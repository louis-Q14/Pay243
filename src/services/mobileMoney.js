import { config } from '../config.js';
import { q, tx } from '../db.js';
import { createTxn, getTxn, move, systemWallet, updateTxn } from '../ledger.js';
import { getProvider } from '../providers/mobileMoney/index.js';
import { HttpError, detectOperator, normalizePhone } from '../util.js';
import { onPaymentCollectionFailed, onRefundPayoutResult, settlePayment } from './payments.js';
import { enqueueEvent } from './webhooks.js';

const SUPPORTED = Object.keys(config.providers);

/** Normalise le numéro, détecte l'opérateur via le préfixe et vérifie la cohérence avec l'opérateur choisi. */
export function resolveOperator(phone, operator) {
  const p = normalizePhone(phone);
  const detected = detectOperator(p);
  const op = operator ? String(operator).toLowerCase() : detected;
  if (!op || !SUPPORTED.includes(op)) {
    throw new HttpError(400, 'unsupported_operator',
      `Opérateur non pris en charge pour ${p}. Acceptés : M-Pesa (Vodacom), Airtel Money, Orange Money.`);
  }
  if (operator && detected && detected !== op && SUPPORTED.includes(detected)) {
    throw new HttpError(400, 'operator_mismatch', `Le numéro ${p} semble appartenir à ${config.providers[detected].label}, pas à ${config.providers[op].label}.`);
  }
  return { phone: p, operator: op };
}

/**
 * Encaissement Mobile Money (push USSD vers le client). Utilisé pour :
 *  - type 'topup'   : recharge du wallet d'un utilisateur
 *  - type 'payment' : paiement direct d'un marchand depuis le checkout (sans compte Pay243)
 */
export async function startCollection({ type, phone, operator, amount, currency, toWalletId, paymentId = null, merchantId = null, description, metadata }) {
  const r = resolveOperator(phone, operator);
  const provider = getProvider(r.operator);
  const float = await systemWallet(`float_${r.operator}`, currency);
  const txn = await createTxn({
    type, status: 'pending', amount, currency, method: 'mobile_money',
    from_wallet: float.id, to_wallet: toWalletId,
    operator: r.operator, phone: r.phone, provider: provider.name,
    payment_id: paymentId, merchant_id: merchantId, description, metadata,
  });
  // Référence connue avant l'envoi : un callback très rapide retrouve toujours sa transaction.
  if (provider.referenceFor) await updateTxn(txn.id, { provider_ref: provider.referenceFor(txn.id) });
  try {
    const res = await provider.collect({ txnId: txn.id, phone: r.phone, amount, currency, description });
    if (res?.providerRef) await updateTxn(txn.id, { provider_ref: res.providerRef });
  } catch (e) {
    if (e.uncertain) {
      // Issue inconnue : la transaction reste "pending" ; le contrôleur de transactions en attente
      // interrogera l'opérateur, puis le rapprochement tranchera.
      console.warn(`[mobile-money] ${txn.id} incertain : ${e.message}`);
      return getTxn(txn.id);
    }
    await handleProviderResult({ txnId: txn.id, status: 'failed', reason: e.message });
    throw new HttpError(502, 'provider_error', `${config.providers[r.operator].label} a rejeté la demande : ${e.message}`);
  }
  return getTxn(txn.id);
}

/**
 * Décaissement vers un numéro Mobile Money. Les fonds (montant + frais) sont débités immédiatement
 * vers un compte de réservation ; ils sont restitués si l'opérateur échoue.
 *  - type 'withdrawal' : retrait d'un utilisateur
 *  - type 'payout'     : versement d'un marchand
 *  - type 'refund'     : remboursement d'un paiement Mobile Money
 * `guard` (facultatif) s'exécute dans la transaction de débit, avant le mouvement (contrôle de plafonds).
 */
export async function startPayout({ type, fromWalletId, phone, operator, amount, fee = 0, currency, merchantId = null, paymentId = null, description, metadata, guard }) {
  const r = resolveOperator(phone, operator);
  const provider = getProvider(r.operator);
  const pending = await systemWallet('payout_pending', currency);
  const fees = fee ? await systemWallet('fees', currency) : null;
  const txn = await tx(async () => {
    if (guard) await guard();
    const t = await createTxn({
      type, status: 'pending', amount, fee, currency, method: 'mobile_money',
      from_wallet: fromWalletId, to_wallet: pending.id,
      operator: r.operator, phone: r.phone, provider: provider.name,
      merchant_id: merchantId, payment_id: paymentId, description, metadata,
    });
    await move(t.id, fromWalletId, pending.id, amount);
    if (fee) await move(t.id, fromWalletId, fees.id, fee);
    if (provider.referenceFor) await updateTxn(t.id, { provider_ref: provider.referenceFor(t.id) });
    return t;
  });
  try {
    const res = await provider.disburse({ txnId: txn.id, phone: r.phone, amount, currency, description });
    if (res?.providerRef) await updateTxn(txn.id, { provider_ref: res.providerRef });
  } catch (e) {
    if (e.uncertain) {
      // L'argent a peut-être été envoyé : surtout ne pas restituer les fonds automatiquement.
      console.warn(`[mobile-money] ${txn.id} incertain : ${e.message}`);
      return getTxn(txn.id);
    }
    await handleProviderResult({ txnId: txn.id, status: 'failed', reason: e.message });
    throw new HttpError(502, 'provider_error', `${config.providers[r.operator].label} a rejeté le décaissement : ${e.message}`);
  }
  return getTxn(txn.id);
}

export const COLLECTION_TYPES = ['topup', 'payment'];
export const PAYOUT_TYPES = ['withdrawal', 'payout', 'refund'];

/**
 * Dénouement d'une opération opérateur. Idempotent et sûr en concurrence : la transaction est verrouillée,
 * puis ignorée si elle n'est plus "pending" (callback + interrogation de statut simultanés, plusieurs serveurs).
 */
export async function handleProviderResult({ txnId, providerRef, status, reason }) {
  return tx(async () => {
    const txn = txnId
      ? await q.get('SELECT * FROM transactions WHERE id=? FOR UPDATE', txnId)
      : await q.get('SELECT * FROM transactions WHERE provider_ref=? FOR UPDATE', providerRef);
    if (!txn || txn.status !== 'pending') return;
    const extra = providerRef && !txn.provider_ref ? { provider_ref: providerRef } : {};

    if (COLLECTION_TYPES.includes(txn.type)) {
      if (status === 'succeeded') {
        if (txn.type === 'topup') {
          await move(txn.id, txn.from_wallet, txn.to_wallet, txn.amount);
          await updateTxn(txn.id, { status: 'succeeded', ...extra });
        } else {
          if (Object.keys(extra).length) await updateTxn(txn.id, extra);
          await settlePayment(txn.payment_id, await getTxn(txn.id));
        }
      } else {
        await updateTxn(txn.id, { status: 'failed', failure_reason: reason || 'Échec opérateur', ...extra });
        if (txn.type === 'payment') await onPaymentCollectionFailed(txn.payment_id, reason);
      }
      return;
    }

    if (PAYOUT_TYPES.includes(txn.type)) {
      if (status === 'succeeded') {
        await move(txn.id, txn.to_wallet, (await systemWallet(`float_${txn.operator}`, txn.currency)).id, txn.amount);
        await updateTxn(txn.id, { status: 'succeeded', ...extra });
      } else {
        // Restitution intégrale (montant + frais) au wallet d'origine
        await move(txn.id, txn.to_wallet, txn.from_wallet, txn.amount);
        if (txn.fee) await move(txn.id, (await systemWallet('fees', txn.currency)).id, txn.from_wallet, txn.fee);
        await updateTxn(txn.id, { status: 'failed', failure_reason: reason || 'Échec opérateur', ...extra });
      }
      if (txn.type === 'refund') await onRefundPayoutResult(txn, status, reason);
      if (txn.type === 'payout' && txn.merchant_id) {
        await enqueueEvent(txn.merchant_id, `payout.${status}`, {
          id: txn.id, object: 'payout', amount: txn.amount, fee: txn.fee, currency: txn.currency,
          phone: txn.phone, operator: txn.operator, status, failure_reason: status === 'failed' ? reason : null,
        });
      }
    }
  });
}

/** Interroge l'opérateur pour une transaction en attente (si le pilote le permet). */
export async function refreshPending(txn) {
  if (txn.status !== 'pending' || !txn.operator) return txn;
  const provider = getProvider(txn.operator);
  if (!provider.checkStatus) return txn;
  try {
    const s = await provider.checkStatus(txn);
    if (s) await handleProviderResult({ txnId: txn.id, ...s });
  } catch { /* on réessaiera */ }
  return getTxn(txn.id);
}
