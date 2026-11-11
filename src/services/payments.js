import { verifyPin } from '../auth.js';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { createTxn, getTxn, getWallet, lockWallet, move, systemWallet, updateTxn } from '../ledger.js';
import { checkOutgoing, lockUsers } from '../limits.js';
import { cardProcessor } from '../providers/cards/index.js';
import { listOperators } from '../providers/mobileMoney/index.js';
import { HttpError, assertAmount, assertCurrency, newId, now, parseJson, percentFee } from '../util.js';
import { resolveOperator, startCollection, startPayout } from './mobileMoney.js';
import { enqueueEvent } from './webhooks.js';

export const getPayment = (id) => q.get('SELECT * FROM payments WHERE id=?', id);
const lockPayment = (id) => q.get('SELECT * FROM payments WHERE id=? FOR UPDATE', id);
const merchantOf = (p) => q.get('SELECT * FROM merchants WHERE id=?', p.merchant_id);

export function serializePayment(p) {
  return {
    id: p.id,
    object: 'payment',
    livemode: !!p.livemode,
    amount: p.amount,
    currency: p.currency,
    description: p.description,
    reference: p.reference,
    status: p.status,
    fee: p.fee,
    net: p.status === 'requires_payment' ? null : p.amount - p.fee,
    refunded_amount: p.refunded_amount,
    method: p.method,
    payer: p.payer_phone ? { phone: p.payer_phone, operator: p.payer_operator } : null,
    checkout_url: `${config.baseUrl}/checkout/${p.id}`,
    return_url: p.return_url,
    cancel_url: p.cancel_url,
    metadata: parseJson(p.metadata, {}),
    last_error: p.last_error,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
    created_at: p.created_at,
  };
}

function validUrl(u, field) {
  if (u == null || u === '') return null;
  try {
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new HttpError(400, 'invalid_url', `${field} doit être une URL http(s) valide.`);
  }
}

export async function createPayment(merchant, livemode, body) {
  const amount = assertAmount(body.amount);
  const currency = assertCurrency(body.currency);
  const metadata = body.metadata ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length > 20) {
    throw new HttpError(400, 'invalid_metadata', 'metadata doit être un objet de 20 clés maximum.');
  }
  const minutes = Math.min(Math.max(Number(body.expires_in_minutes) || config.paymentExpiryMinutes, 5), 7 * 24 * 60);
  const id = newId('pay');
  const ts = now();
  await q.run(
    `INSERT INTO payments (id, merchant_id, livemode, amount, currency, description, reference, status, return_url, cancel_url, metadata, expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'requires_payment',?,?,?,?,?,?)`,
    id, merchant.id, livemode ? 1 : 0, amount, currency,
    String(body.description || '').slice(0, 200) || null,
    body.reference ? String(body.reference).slice(0, 100) : null,
    validUrl(body.return_url, 'return_url'), validUrl(body.cancel_url, 'cancel_url'),
    JSON.stringify(metadata), new Date(Date.now() + minutes * 60e3).toISOString(), ts, ts,
  );
  return getPayment(id);
}

async function setPayment(id, fields) {
  const cols = Object.keys(fields);
  await q.run(`UPDATE payments SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`, ...cols.map((c) => fields[c]), now(), id);
}

const NOT_PAYABLE = {
  processing: 'Un paiement est déjà en attente de confirmation sur le téléphone du client.',
  succeeded: 'Ce paiement a déjà été effectué.',
  refunded: 'Ce paiement a déjà été effectué.',
  partially_refunded: 'Ce paiement a déjà été effectué.',
  canceled: 'Ce paiement a été annulé par le marchand.',
  expired: 'Ce lien de paiement a expiré.',
};

async function assertPayable(p) {
  if (!p) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  if (p.status === 'requires_payment' && p.expires_at < now()) {
    await q.run("UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='requires_payment'", now(), p.id);
    throw new HttpError(410, 'payment_expired', 'Ce lien de paiement a expiré.');
  }
  if (p.status !== 'requires_payment') {
    throw new HttpError(409, 'payment_not_payable', NOT_PAYABLE[p.status] || `Paiement non payable (statut : ${p.status}).`);
  }
}

/**
 * Passe atomiquement le paiement de requires_payment à processing. Une seule requête gagne, même si deux
 * clients (ou deux serveurs) tentent de payer le même lien au même instant.
 */
async function claimPayment(p, fields) {
  const cols = Object.keys(fields);
  const r = await q.run(
    `UPDATE payments SET status='processing', ${cols.map((c) => `${c}=?`).join(',')}, updated_at=?
      WHERE id=? AND status='requires_payment' AND expires_at >= ?`,
    ...cols.map((c) => fields[c]), now(), p.id, now(),
  );
  if (!r.changes) {
    await assertPayable(await getPayment(p.id));
    throw new HttpError(409, 'payment_not_payable', NOT_PAYABLE.processing);
  }
}

/** Crédite le marchand (montant brut), prélève la commission, notifie. */
export async function settlePayment(paymentId, txn) {
  return tx(async () => {
    const p = await lockPayment(paymentId);
    if (['succeeded', 'refunded', 'partially_refunded'].includes(p.status)) {
      throw new HttpError(409, 'already_paid', `Paiement ${p.id} déjà réglé : encaissement ${txn.id} à rembourser au payeur.`);
    }
    const merchantWallet = await getWallet('merchant', p.merchant_id, p.currency);
    const fee = percentFee(p.amount, config.fees.merchantPercent);
    await move(txn.id, txn.from_wallet, merchantWallet.id, txn.amount);
    await move(txn.id, merchantWallet.id, (await systemWallet('fees', p.currency)).id, fee);
    await updateTxn(txn.id, { status: 'succeeded', fee, to_wallet: merchantWallet.id });
    await setPayment(p.id, { status: 'succeeded', fee, txn_id: txn.id, method: txn.method, paid_at: now(), last_error: null });
    await enqueueEvent(p.merchant_id, 'payment.succeeded', serializePayment(await getPayment(p.id)));
  });
}

export async function onPaymentCollectionFailed(paymentId, reason) {
  const r = await q.run("UPDATE payments SET status='requires_payment', last_error=?, updated_at=? WHERE id=? AND status='processing'",
    reason || 'Paiement refusé', now(), paymentId);
  if (!r.changes) return;
  const p = await getPayment(paymentId);
  await enqueueEvent(p.merchant_id, 'payment.failed', serializePayment(p));
}

// ---------------- Moyens de paiement du checkout ----------------

/** Paiement avec le solde du wallet Pay243 du client. */
export async function payWithWallet(paymentId, user, pin) {
  const p0 = await getPayment(paymentId);
  await assertPayable(p0);
  const merchant = await merchantOf(p0);
  if (merchant.owner_user_id === user.id) throw new HttpError(400, 'self_payment', 'Vous ne pouvez pas payer votre propre boutique.');
  await verifyPin(user, pin);
  return tx(async () => {
    const p = await lockPayment(paymentId); // revérifié sous verrou
    await assertPayable(p);
    await lockUsers(user.id);
    await checkOutgoing(user, p.currency, p.amount);
    const w = await lockWallet((await getWallet('user', user.id, p.currency)).id);
    if (w.balance < p.amount) {
      throw new HttpError(402, 'insufficient_funds', `Solde ${p.currency} insuffisant. Rechargez votre wallet via Mobile Money ou carte.`);
    }
    const txn = await createTxn({
      type: 'payment', status: 'pending', amount: p.amount, currency: p.currency, method: 'wallet',
      from_wallet: w.id, to_wallet: (await getWallet('merchant', p.merchant_id, p.currency)).id,
      merchant_id: p.merchant_id, payment_id: p.id,
      description: p.description || `Paiement ${merchant.name}`, metadata: { counterparty: merchant.name },
    });
    await setPayment(p.id, { customer_user_id: user.id });
    await settlePayment(p.id, txn);
    return getPayment(p.id);
  });
}

/** Paiement direct Mobile Money (client sans compte Pay243). Résultat asynchrone. */
export async function payWithMobileMoney(paymentId, phone, operator, user = null) {
  const p = await getPayment(paymentId);
  await assertPayable(p);
  const r = resolveOperator(phone, operator);
  const merchant = await merchantOf(p);
  await claimPayment(p, { payer_phone: r.phone, payer_operator: r.operator, customer_user_id: user?.id || null, last_error: null });
  let txn;
  try {
    txn = await startCollection({
      type: 'payment', phone: r.phone, operator: r.operator, amount: p.amount, currency: p.currency,
      toWalletId: (await getWallet('merchant', p.merchant_id, p.currency)).id,
      paymentId: p.id, merchantId: p.merchant_id,
      description: p.description || `Paiement ${merchant.name}`, metadata: { counterparty: merchant.name },
    });
  } catch (e) {
    if (e.code !== 'provider_error') await onPaymentCollectionFailed(p.id, e.message); // erreur avant l'envoi : on libère
    throw e;
  }
  return { payment: await getPayment(p.id), txn };
}

/** Paiement par carte : carte enregistrée (client connecté + PIN) ou jeton à usage unique (invité). */
export async function payWithCard(paymentId, { user, cardId, token, pin }) {
  const p = await getPayment(paymentId);
  await assertPayable(p);
  let cardToken = token;
  if (cardId) {
    if (!user) throw new HttpError(401, 'unauthorized', 'Connectez-vous pour utiliser une carte enregistrée.');
    await verifyPin(user, pin);
    const card = await q.get('SELECT * FROM cards WHERE id=? AND user_id=?', cardId, user.id);
    if (!card) throw new HttpError(404, 'card_not_found', 'Carte introuvable.');
    cardToken = card.provider_token;
  }
  if (!cardToken) throw new HttpError(400, 'missing_card', 'Fournissez card_id (carte enregistrée) ou token (jeton de carte).');
  const merchant = await merchantOf(p);
  await claimPayment(p, { customer_user_id: user?.id || null, last_error: null });
  const txn = await createTxn({
    type: 'payment', status: 'pending', amount: p.amount, currency: p.currency, method: 'card',
    from_wallet: (await systemWallet('float_card', p.currency)).id,
    to_wallet: (await getWallet('merchant', p.merchant_id, p.currency)).id,
    merchant_id: p.merchant_id, payment_id: p.id, provider: cardProcessor().name,
    description: p.description || `Paiement ${merchant.name}`, metadata: { counterparty: merchant.name },
  });
  let res;
  try {
    res = await cardProcessor().charge({ token: cardToken, amount: p.amount, currency: p.currency, txnId: txn.id, description: p.description });
  } catch (e) {
    res = { status: 'failed', reason: e.message };
  }
  if (res.status !== 'succeeded') {
    await updateTxn(txn.id, { status: 'failed', failure_reason: res.reason });
    await onPaymentCollectionFailed(p.id, res.reason);
    throw new HttpError(402, 'card_declined', res.reason || 'Carte refusée.');
  }
  await tx(async () => {
    await updateTxn(txn.id, { provider_ref: res.providerRef });
    await setPayment(p.id, { card_token: cardToken });
    await settlePayment(p.id, await getTxn(txn.id));
  });
  return getPayment(p.id);
}

// ---------------- Remboursements & annulation ----------------

function refundObject(txn, p) {
  return { id: txn.id, object: 'refund', payment_id: p.id, amount: txn.amount, currency: txn.currency, status: txn.status, method: p.method, created_at: txn.created_at };
}

/**
 * Réserve atomiquement le montant à rembourser (le total remboursé ne peut jamais dépasser le montant payé,
 * même avec des demandes simultanées sur plusieurs serveurs).
 */
async function reserveRefund(p, amount) {
  const r = await q.run(
    `UPDATE payments SET refunded_amount = refunded_amount + ?,
            status = CASE WHEN refunded_amount + ? >= amount THEN 'refunded' ELSE 'partially_refunded' END,
            updated_at = ?
      WHERE id = ? AND status IN ('succeeded','partially_refunded') AND refunded_amount + ? <= amount`,
    amount, amount, now(), p.id, amount,
  );
  if (!r.changes) {
    const fresh = await getPayment(p.id);
    throw new HttpError(400, 'amount_too_large', `Montant remboursable restant : ${fresh.amount - fresh.refunded_amount}.`);
  }
}

async function releaseRefund(paymentId, amount) {
  await q.run(
    `UPDATE payments SET refunded_amount = GREATEST(refunded_amount - ?, 0),
            status = CASE WHEN GREATEST(refunded_amount - ?, 0) = 0 THEN 'succeeded' ELSE 'partially_refunded' END,
            updated_at = ?
      WHERE id = ?`,
    amount, amount, now(), paymentId,
  );
}

export async function refundPayment(paymentId, merchant, rawAmount, reason) {
  const p = await getPayment(paymentId);
  if (!p || p.merchant_id !== merchant.id) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  if (!['succeeded', 'partially_refunded'].includes(p.status)) {
    throw new HttpError(409, 'not_refundable', `Seul un paiement réussi peut être remboursé (statut : ${p.status}).`);
  }
  const remaining = p.amount - p.refunded_amount;
  const amount = rawAmount == null ? remaining : assertAmount(rawAmount);
  if (amount > remaining) throw new HttpError(400, 'amount_too_large', `Montant remboursable restant : ${remaining}.`);
  const mWallet = await getWallet('merchant', merchant.id, p.currency);
  if (mWallet.balance < amount) throw new HttpError(402, 'insufficient_funds', 'Solde marchand insuffisant pour ce remboursement.');
  const description = `Remboursement ${merchant.name}${reason ? ` — ${String(reason).slice(0, 80)}` : ''}`;

  if (p.method === 'wallet') {
    return tx(async () => {
      await reserveRefund(p, amount);
      const to = await getWallet('user', p.customer_user_id, p.currency);
      const t = await createTxn({ type: 'refund', status: 'succeeded', amount, currency: p.currency, method: 'wallet', from_wallet: mWallet.id, to_wallet: to.id, merchant_id: merchant.id, payment_id: p.id, description, metadata: { counterparty: merchant.name } });
      await move(t.id, mWallet.id, to.id, amount); // solde insuffisant -> tout est annulé, réservation comprise
      await enqueueEvent(merchant.id, 'payment.refunded', { ...serializePayment(await getPayment(p.id)), refund: refundObject(t, p) });
      return refundObject(t, p);
    });
  }

  if (p.method === 'card') {
    const floatCard = await systemWallet('float_card', p.currency);
    const t = await tx(async () => {
      await reserveRefund(p, amount);
      const created = await createTxn({ type: 'refund', status: 'pending', amount, currency: p.currency, method: 'card', from_wallet: mWallet.id, to_wallet: floatCard.id, merchant_id: merchant.id, payment_id: p.id, description, metadata: { counterparty: merchant.name } });
      await move(created.id, mWallet.id, floatCard.id, amount);
      return created;
    });
    const original = await getTxn(p.txn_id);
    let res;
    try {
      res = await cardProcessor().refund({ providerRef: original?.provider_ref, amount, currency: p.currency });
    } catch (e) {
      res = { status: 'failed', reason: e.message };
    }
    if (res.status !== 'succeeded') {
      await tx(async () => {
        await move(t.id, floatCard.id, mWallet.id, amount);
        await releaseRefund(p.id, amount);
        await updateTxn(t.id, { status: 'failed', failure_reason: res.reason || 'Refus du processeur' });
      });
      throw new HttpError(502, 'refund_failed', res.reason || 'Le processeur a refusé le remboursement.');
    }
    return tx(async () => {
      await updateTxn(t.id, { status: 'succeeded', provider_ref: res.providerRef });
      const done = await getTxn(t.id);
      await enqueueEvent(merchant.id, 'payment.refunded', { ...serializePayment(await getPayment(p.id)), refund: refundObject(done, p) });
      return refundObject(done, p);
    });
  }

  // Mobile Money : décaissement vers le numéro payeur ; le montant est réservé dès maintenant.
  await reserveRefund(p, amount);
  let t;
  try {
    t = await startPayout({
      type: 'refund', fromWalletId: mWallet.id, phone: p.payer_phone, operator: p.payer_operator,
      amount, currency: p.currency, merchantId: merchant.id, paymentId: p.id, description,
    });
  } catch (e) {
    // provider_error : l'échec a déjà été dénoué (réservation libérée par onRefundPayoutResult).
    if (e.code !== 'provider_error') await releaseRefund(p.id, amount);
    throw e;
  }
  return refundObject(t, p);
}

/** Dénouement d'un remboursement Mobile Money. */
export async function onRefundPayoutResult(txn, status, reason) {
  const p = await getPayment(txn.payment_id);
  if (!p) return;
  const refund = refundObject(await getTxn(txn.id), p);
  if (status === 'succeeded') {
    await enqueueEvent(p.merchant_id, 'payment.refunded', { ...serializePayment(p), refund });
  } else {
    await releaseRefund(p.id, txn.amount);
    await enqueueEvent(p.merchant_id, 'refund.failed', { ...refund, failure_reason: reason });
  }
}

export async function cancelPayment(paymentId, merchant) {
  const p = await getPayment(paymentId);
  if (!p || p.merchant_id !== merchant.id) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  const r = await q.run("UPDATE payments SET status='canceled', updated_at=? WHERE id=? AND status='requires_payment'", now(), p.id);
  if (!r.changes) {
    const fresh = await getPayment(p.id);
    throw new HttpError(409, 'not_cancelable', `Impossible d'annuler un paiement au statut "${fresh.status}".`);
  }
  const done = await getPayment(p.id);
  await enqueueEvent(merchant.id, 'payment.canceled', serializePayment(done));
  return done;
}

/** Vue publique pour la page de paiement hébergée (aucune donnée sensible). */
export async function publicCheckoutView(p) {
  if (!p) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  if (p.status === 'requires_payment' && p.expires_at < now()) {
    await q.run("UPDATE payments SET status='expired', updated_at=? WHERE id=? AND status='requires_payment'", now(), p.id);
    p = await getPayment(p.id);
  }
  const m = await merchantOf(p);
  return {
    id: p.id,
    merchant: { name: m.name },
    amount: p.amount,
    currency: p.currency,
    description: p.description,
    status: p.status,
    last_error: p.last_error,
    expires_at: p.expires_at,
    return_url: p.return_url,
    cancel_url: p.cancel_url,
    livemode: !!p.livemode,
    sandbox: config.mode !== 'live',
    operators: listOperators().map(({ id, label }) => ({ id, label })),
  };
}
