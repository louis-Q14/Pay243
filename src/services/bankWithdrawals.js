// Retrait vers un compte bancaire enregistré : Pay243 n'est relié à aucune banque par API.
// Les fonds (montant + frais) sont réservés tout de suite ; l'équipe Finance fait le virement,
// puis le marque payé (référence bancaire) ou le rejette (fonds restitués).
import { accountWallet } from '../accounts.js';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { createTxn, getTxn, lockWallet, move, systemWallet, updateTxn } from '../ledger.js';
import { checkOutgoing, lockUsers } from '../limits.js';
import { HttpError, percentFee } from '../util.js';
import { assertWithdrawal, purposeOf } from './paymentSplit.js';

/** Demande de retrait bancaire d'un utilisateur (PIN déjà vérifié). La devise est celle du compte bancaire. */
export async function startBankWithdrawal(user, { bankAccountId, amount, purpose: rawPurpose }) {
  const bank = await q.get('SELECT * FROM bank_accounts WHERE id=? AND user_id=?', String(bankAccountId || ''), user.id);
  if (!bank) throw new HttpError(404, 'bank_account_not_found', 'Compte bancaire introuvable. Enregistrez-le dans Paramètres > Paiements.');
  const currency = bank.currency;
  const fee = percentFee(amount, config.fees.withdrawalPercent);
  const wallet = await accountWallet(user, currency);
  // Compte d'une entreprise : un versement de son espace marchand (argent des vendeurs réservé).
  const merchantId = wallet.owner_type === 'merchant' ? wallet.owner_id : undefined;
  const purpose = purposeOf(rawPurpose);
  const pending = await systemWallet('payout_pending', currency);
  const fees = fee ? await systemWallet('fees', currency) : null;
  const last4 = bank.account_number.slice(-4);
  const txn = await tx(async () => {
    await lockUsers(user.id);
    await checkOutgoing(user, currency, amount);
    const w = await lockWallet(wallet.id);
    if (w.balance < amount + fee) throw new HttpError(402, 'insufficient_funds', `Solde insuffisant : ${amount + fee} requis (dont ${fee} de frais).`);
    const split = merchantId && (await assertWithdrawal(merchantId, currency, amount + fee, purpose, Number(w.balance))).has_split;
    const t = await createTxn({
      type: merchantId ? 'payout' : 'withdrawal', status: 'pending', amount, fee, currency, method: 'bank', provider: 'bank',
      from_wallet: wallet.id, to_wallet: pending.id, merchant_id: merchantId,
      description: `Retrait vers ${bank.bank_name} •••• ${last4}`,
      metadata: {
        bank_account_id: bank.id, bank_name: bank.bank_name, holder_name: bank.holder_name, account_last4: last4,
        ...(merchantId ? { initiated_by: user.id } : {}), ...(split ? { purpose } : {}),
      },
    });
    await move(t.id, wallet.id, pending.id, amount);
    if (fee) await move(t.id, wallet.id, fees.id, fee);
    return t;
  });
  return getTxn(txn.id);
}

/** Retrait bancaire en attente, verrouillé (dénouement une seule fois, même avec deux agents en même temps). */
async function lockPending(id) {
  const t = await q.get("SELECT * FROM transactions WHERE id=? AND method='bank' FOR UPDATE", id);
  if (!t) throw new HttpError(404, 'withdrawal_not_found', 'Retrait bancaire introuvable.');
  if (t.status !== 'pending') throw new HttpError(409, 'not_pending', 'Ce retrait a déjà été traité.');
  return t;
}

/** Virement fait par l'équipe Finance : les fonds réservés sortent vers le compte bancaire de Pay243. */
export async function markBankWithdrawalPaid(id, reference) {
  const ref = String(reference || '').trim().slice(0, 80);
  if (ref.length < 3) throw new HttpError(400, 'reference_required', 'Référence du virement obligatoire (relevé bancaire).');
  await tx(async () => {
    const t = await lockPending(id);
    await move(t.id, t.to_wallet, (await systemWallet('float_bank', t.currency)).id, Number(t.amount));
    await updateTxn(t.id, { status: 'succeeded', provider_ref: ref });
  });
  return getTxn(id);
}

/** Virement impossible (compte refusé par la banque…) : montant et frais reviennent sur le compte d'origine. */
export async function rejectBankWithdrawal(id, reason) {
  await tx(async () => {
    const t = await lockPending(id);
    await move(t.id, t.to_wallet, t.from_wallet, Number(t.amount));
    if (Number(t.fee)) await move(t.id, (await systemWallet('fees', t.currency)).id, t.from_wallet, Number(t.fee));
    await updateTxn(t.id, { status: 'failed', failure_reason: reason });
  });
  return getTxn(id);
}
