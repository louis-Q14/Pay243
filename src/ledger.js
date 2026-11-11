import { q, tx } from './db.js';
import { HttpError, newId, now, parseJson } from './util.js';

const SELECT_WALLET = 'SELECT * FROM wallets WHERE owner_type=? AND owner_id=? AND currency=?';

/** Récupère (ou crée) le wallet d'un propriétaire dans une devise. */
export async function getWallet(ownerType, ownerId, currency) {
  const w = await q.get(SELECT_WALLET, ownerType, ownerId, currency);
  if (w) return w;
  await q.run(
    'INSERT INTO wallets (id, owner_type, owner_id, currency, balance, created_at) VALUES (?,?,?,?,0,?) ON CONFLICT (owner_type, owner_id, currency) DO NOTHING',
    newId('wal'), ownerType, ownerId, currency, now(),
  );
  return q.get(SELECT_WALLET, ownerType, ownerId, currency);
}

/**
 * Comptes techniques de la plateforme :
 *  - float_<operateur> : contrepartie des fonds entrés/sortis via un opérateur Mobile Money
 *  - float_card        : contrepartie des fonds encaissés par carte
 *  - payout_pending    : fonds réservés pendant un décaissement en cours
 *  - fees              : revenus de commissions Pay243
 *  - fx_pool           : position de change
 * Les comptes système peuvent être négatifs (ils représentent de l'argent hors plateforme).
 */
export const systemWallet = (name, currency) => getWallet('system', name, currency);

export const getWalletById = (id) => q.get('SELECT * FROM wallets WHERE id=?', id);

/** Verrouille un wallet jusqu'à la fin de la transaction et renvoie son solde à jour. */
export const lockWallet = (id) => q.get('SELECT * FROM wallets WHERE id=? FOR UPDATE', id);

/**
 * Mouvement de fonds atomique entre deux wallets de même devise.
 * Les deux lignes sont verrouillées (dans l'ordre des identifiants, pour limiter les deadlocks) avant le
 * contrôle de solde : deux débits concurrents, même sur deux serveurs, ne peuvent pas dépasser le solde.
 */
export async function move(txnId, fromWalletId, toWalletId, amount) {
  if (amount <= 0) return;
  return tx(async () => {
    const rows = await q.all('SELECT * FROM wallets WHERE id IN (?, ?) ORDER BY id FOR UPDATE', fromWalletId, toWalletId);
    const from = rows.find((w) => w.id === fromWalletId);
    const to = rows.find((w) => w.id === toWalletId);
    if (!from || !to) throw new HttpError(500, 'wallet_not_found', 'Wallet introuvable.');
    if (from.currency !== to.currency) throw new HttpError(500, 'currency_mismatch', 'Devises différentes.');
    if (from.owner_type !== 'system' && from.balance < amount) {
      throw new HttpError(402, 'insufficient_funds', 'Solde insuffisant.');
    }
    const ts = now();
    const fb = (await q.get('UPDATE wallets SET balance = balance - ? WHERE id=? RETURNING balance', amount, from.id)).balance;
    const tb = (await q.get('UPDATE wallets SET balance = balance + ? WHERE id=? RETURNING balance', amount, to.id)).balance;
    await q.run('INSERT INTO ledger_entries (txn_id, wallet_id, amount, balance_after, created_at) VALUES (?,?,?,?,?), (?,?,?,?,?)',
      txnId, from.id, -amount, fb, ts, txnId, to.id, amount, tb, ts);
  });
}

const TXN_FIELDS = ['type', 'status', 'amount', 'fee', 'currency', 'from_wallet', 'to_wallet', 'merchant_id', 'payment_id',
  'method', 'operator', 'phone', 'provider', 'provider_ref', 'failure_reason', 'description', 'metadata'];

export async function createTxn(fields) {
  const id = newId('txn');
  const ts = now();
  const row = { fee: 0, ...fields };
  if (row.metadata && typeof row.metadata !== 'string') row.metadata = JSON.stringify(row.metadata);
  const cols = TXN_FIELDS.filter((f) => row[f] !== undefined);
  await q.run(
    `INSERT INTO transactions (id, ${cols.join(',')}, created_at, updated_at) VALUES (?, ${cols.map(() => '?').join(',')}, ?, ?)`,
    id, ...cols.map((c) => row[c]), ts, ts,
  );
  return getTxn(id);
}

export async function updateTxn(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  await q.run(`UPDATE transactions SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id=?`, ...cols.map((c) => fields[c]), now(), id);
}

export const getTxn = (id) => q.get('SELECT * FROM transactions WHERE id=?', id);
export const lockTxn = (id) => q.get('SELECT * FROM transactions WHERE id=? FOR UPDATE', id);

export function serializeTxn(t, perspectiveWalletIds = []) {
  let direction = null;
  if (perspectiveWalletIds.includes(t.to_wallet) && !perspectiveWalletIds.includes(t.from_wallet)) direction = 'credit';
  else if (perspectiveWalletIds.includes(t.from_wallet)) direction = 'debit';
  const meta = parseJson(t.metadata, {});
  return {
    id: t.id,
    object: 'transaction',
    type: t.type,
    status: t.status,
    direction,
    amount: t.amount,
    fee: t.fee,
    currency: t.currency,
    method: t.method,
    operator: t.operator,
    phone: t.phone,
    description: t.description,
    counterparty: meta.counterparty || null,
    failure_reason: t.failure_reason,
    payment_id: t.payment_id,
    metadata: meta,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

/** Contrôle d'intégrité : chaque devise doit être équilibrée (somme des soldes = 0). */
export const auditLedger = () => q.all('SELECT currency, SUM(balance) AS total FROM wallets GROUP BY currency ORDER BY currency');
