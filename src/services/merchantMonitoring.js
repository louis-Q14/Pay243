/**
 * Suivi marchand : paiements reçus, sorties (versements, remboursements), synthèse par période, export CSV.
 * Tout est filtré par marchand ; les montants restent en unités mineures.
 */
import { config } from '../config.js';
import { q } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { serializePayment } from './payments.js';

const PAID = ['succeeded', 'partially_refunded', 'refunded'];
const PAYMENT_STATUSES = ['requires_payment', 'processing', ...PAID, 'failed', 'canceled', 'expired'];
const METHODS = ['wallet', 'mobile_money', 'card'];
const OUT_TYPES = ['payout', 'refund'];
const TXN_STATUSES = ['pending', 'succeeded', 'failed'];

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
const inList = (v, allowed) => (v && allowed.includes(String(v)) ? String(v) : null);

function isoOrNull(v, field) {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid_date', `${field} : date invalide (format ISO 8601 attendu).`);
  return d.toISOString();
}

/** Période [from, to[ ; par défaut les 30 derniers jours. Bornée à 400 jours. */
export function periodOf(query) {
  const to = isoOrNull(query.to, 'to') || new Date(Date.now() + 60e3).toISOString();
  const from = isoOrNull(query.from, 'from') || new Date(Date.parse(to) - 30 * 864e5).toISOString();
  if (from >= to) throw new HttpError(400, 'invalid_period', 'La date de début doit précéder la date de fin.');
  if (Date.parse(to) - Date.parse(from) > 400 * 864e5) throw new HttpError(400, 'invalid_period', 'Période de 400 jours au maximum.');
  return { from, to };
}

function pageOf(query, max = 100) {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), max);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

const payerName = (p) => p.payer_name || null;

/** Paiement vu par le marchand : objet API + payeur lisible + net restant après remboursements. */
export function monitoringPayment(p) {
  const base = serializePayment(p);
  const paid = PAID.includes(p.status);
  return {
    ...base,
    payer: { ...(base.payer || {}), name: payerName(p) },
    net: paid ? Number(p.amount) - Number(p.fee) : null,
    net_after_refunds: paid ? Number(p.amount) - Number(p.fee) - Number(p.refunded_amount) : null,
  };
}

function paymentFilters(merchantId, query) {
  const where = ['p.merchant_id = ?'];
  const args = [merchantId];
  const { from, to } = periodOf(query);
  // Un paiement payé compte à sa date de paiement ; les autres à leur date de création.
  where.push('COALESCE(p.paid_at, p.created_at) >= ? AND COALESCE(p.paid_at, p.created_at) < ?'); args.push(from, to);
  const status = String(query.status || '');
  if (status === 'paid') where.push(`p.status IN (${PAID.map(() => '?').join(',')})`), args.push(...PAID);
  else if (status === 'unpaid') where.push("p.status IN ('failed','canceled','expired')");
  else if (status === 'open') where.push("p.status IN ('requires_payment','processing')");
  else if (inList(status, PAYMENT_STATUSES)) where.push('p.status = ?'), args.push(status);
  const currency = inList(query.currency, config.currencies);
  if (currency) where.push('p.currency = ?'), args.push(currency);
  const method = inList(query.method, METHODS);
  if (method) where.push('p.method = ?'), args.push(method);
  const s = String(query.q || '').trim().slice(0, 100);
  if (s) {
    const like = `%${escapeLike(s)}%`;
    where.push(`(p.id = ? OR p.reference ILIKE ? OR p.order_refs ILIKE ? OR p.description ILIKE ? OR p.payer_phone LIKE ?
                 OR p.txn_id = ? OR p.metadata ILIKE ? OR u.full_name ILIKE ?)`);
    args.push(s, like, like, like, like, s, like, like);
  }
  return { sql: where.join(' AND '), args };
}

const PAYMENT_FROM = 'FROM payments p LEFT JOIN users u ON u.id = p.customer_user_id';

export async function searchPayments(merchantId, query, { max = 100 } = {}) {
  const { sql, args } = paymentFilters(merchantId, query);
  const { limit, offset } = pageOf(query, max);
  const rows = await q.all(`SELECT p.*, u.full_name AS payer_name ${PAYMENT_FROM} WHERE ${sql}
                            ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  const totals = await q.all(`SELECT p.currency, COUNT(*)::int AS n,
                                COALESCE(SUM(CASE WHEN p.status IN ('succeeded','partially_refunded','refunded') THEN p.amount ELSE 0 END),0)::bigint AS gross,
                                COALESCE(SUM(CASE WHEN p.status IN ('succeeded','partially_refunded','refunded') THEN p.fee ELSE 0 END),0)::bigint AS fees
                              ${PAYMENT_FROM} WHERE ${sql} GROUP BY p.currency ORDER BY p.currency`, ...args);
  return {
    object: 'list',
    data: rows.map(monitoringPayment),
    total: totals.reduce((s, t) => s + t.n, 0),
    totals: totals.map((t) => ({ currency: t.currency, count: t.n, gross: Number(t.gross), fees: Number(t.fees), net: Number(t.gross) - Number(t.fees) })),
    limit, offset,
  };
}

/** Détail d'un paiement : opérations du grand livre liées (encaissement, remboursements) et webhooks envoyés. */
export async function paymentDetail(merchantId, id) {
  const p = await q.get(`SELECT p.*, u.full_name AS payer_name ${PAYMENT_FROM} WHERE p.id = ? AND p.merchant_id = ?`, id, merchantId);
  if (!p) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  const txns = await q.all('SELECT * FROM transactions WHERE payment_id = ? ORDER BY created_at', p.id);
  const events = await q.all(`SELECT id, type, attempts, delivered_at, last_error, created_at FROM webhook_events
                               WHERE merchant_id = ? AND payload LIKE ? ORDER BY created_at LIMIT 50`, merchantId, `%"id":"${escapeLike(p.id)}"%`);
  return {
    ...monitoringPayment(p),
    operations: txns.map((t) => ({
      id: t.id, type: t.type, status: t.status, amount: Number(t.amount), fee: Number(t.fee), currency: t.currency,
      method: t.method, operator: t.operator, phone: t.phone,
      provider_ref: t.provider_ref && !/^mock_/.test(t.provider_ref) ? t.provider_ref : null,
      failure_reason: t.failure_reason, reason: parseJson(t.metadata, {}).reason || null, created_at: t.created_at, updated_at: t.updated_at,
    })),
    webhooks: events.map((e) => ({ id: e.id, type: e.type, attempts: e.attempts, delivered_at: e.delivered_at, last_error: e.last_error, created_at: e.created_at })),
  };
}

function outflowFilters(merchantId, query) {
  const where = [`t.merchant_id = ? AND t.type IN ('payout','refund')`];
  const args = [merchantId];
  const { from, to } = periodOf(query);
  where.push('t.created_at >= ? AND t.created_at < ?'); args.push(from, to);
  const type = inList(query.type, OUT_TYPES);
  if (type) where.push('t.type = ?'), args.push(type);
  const status = inList(query.status, TXN_STATUSES);
  if (status) where.push('t.status = ?'), args.push(status);
  const currency = inList(query.currency, config.currencies);
  if (currency) where.push('t.currency = ?'), args.push(currency);
  const s = String(query.q || '').trim().slice(0, 100);
  if (s) {
    const like = `%${escapeLike(s)}%`;
    where.push('(t.id = ? OR t.payment_id = ? OR t.phone LIKE ? OR t.provider_ref = ? OR t.description ILIKE ? OR p.reference ILIKE ? OR p.order_refs ILIKE ?)');
    args.push(s, s, like, s, like, like, like);
  }
  return { sql: where.join(' AND '), args };
}

const OUT_FROM = 'FROM transactions t LEFT JOIN payments p ON p.id = t.payment_id';

function serializeOutflow(t) {
  const meta = parseJson(t.metadata, {});
  return {
    id: t.id,
    object: 'outflow',
    type: t.type, // payout : versement des ventes · refund : remboursement d'un client
    kind: t.type === 'refund' ? 'refund' : t.method === 'wallet' ? 'payout_wallet' : 'payout_mobile_money',
    status: t.status,
    amount: Number(t.amount),
    fee: Number(t.fee),
    total: Number(t.amount) + Number(t.fee),
    currency: t.currency,
    method: t.method,
    operator: t.operator,
    phone: t.phone,
    provider_ref: t.provider_ref && !/^mock_/.test(t.provider_ref) ? t.provider_ref : null,
    description: t.description,
    reason: meta.reason || null,
    failure_reason: t.failure_reason,
    payment: t.payment_id ? { id: t.payment_id, reference: t.p_reference, order_refs: parseJson(t.p_order_refs, []), description: t.p_description } : null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export async function searchOutflows(merchantId, query, { max = 100 } = {}) {
  const { sql, args } = outflowFilters(merchantId, query);
  const { limit, offset } = pageOf(query, max);
  const rows = await q.all(`SELECT t.*, p.reference AS p_reference, p.order_refs AS p_order_refs, p.description AS p_description
                            ${OUT_FROM} WHERE ${sql} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  const totals = await q.all(`SELECT t.currency, COUNT(*)::int AS n,
                                COALESCE(SUM(CASE WHEN t.status <> 'failed' THEN t.amount + t.fee ELSE 0 END),0)::bigint AS total
                              ${OUT_FROM} WHERE ${sql} GROUP BY t.currency ORDER BY t.currency`, ...args);
  return {
    object: 'list',
    data: rows.map(serializeOutflow),
    total: totals.reduce((s, t) => s + t.n, 0),
    totals: totals.map((t) => ({ currency: t.currency, count: t.n, total: Number(t.total) })),
    limit, offset,
  };
}

/** Synthèse de la période, par devise, et série quotidienne des encaissements nets. */
export async function monitoringSummary(merchantId, query) {
  const { from, to } = periodOf(query);
  const paid = await q.all(`SELECT currency, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::bigint AS gross, COALESCE(SUM(fee),0)::bigint AS fees
                              FROM payments WHERE merchant_id = ? AND status IN ('succeeded','partially_refunded','refunded')
                               AND paid_at >= ? AND paid_at < ? GROUP BY currency`, merchantId, from, to);
  const attempts = await q.all(`SELECT currency, status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::bigint AS amount FROM payments
                                 WHERE merchant_id = ? AND created_at >= ? AND created_at < ? GROUP BY currency, status`, merchantId, from, to);
  const outs = await q.all(`SELECT currency, type, method, status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::bigint AS amount, COALESCE(SUM(fee),0)::bigint AS fees
                              FROM transactions WHERE merchant_id = ? AND type IN ('payout','refund') AND created_at >= ? AND created_at < ?
                             GROUP BY currency, type, method, status`, merchantId, from, to);
  const daily = await q.all(`SELECT currency, substr(paid_at,1,10) AS day, COUNT(*)::int AS n, COALESCE(SUM(amount - fee),0)::bigint AS net
                               FROM payments WHERE merchant_id = ? AND status IN ('succeeded','partially_refunded','refunded')
                                AND paid_at >= ? AND paid_at < ? GROUP BY 1, 2 ORDER BY 2`, merchantId, from, to);
  const open = await q.all(`SELECT currency, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::bigint AS amount FROM payments
                             WHERE merchant_id = ? AND (status = 'processing' OR (status = 'requires_payment' AND expires_at >= ?))
                             GROUP BY currency`, merchantId, new Date().toISOString());
  const wallets = await q.all("SELECT currency, balance FROM wallets WHERE owner_type = 'merchant' AND owner_id = ?", merchantId);

  const currencies = config.currencies.map((currency) => {
    const pd = paid.find((r) => r.currency === currency) || { n: 0, gross: 0, fees: 0 };
    const at = attempts.filter((r) => r.currency === currency);
    const count = (sts) => at.filter((r) => sts.includes(r.status)).reduce((s, r) => s + r.n, 0);
    const succeeded = count(PAID);
    const failed = count(['failed']);
    const abandoned = count(['canceled', 'expired']);
    const sum = (rows) => rows.reduce((s, r) => s + Number(r.amount) + Number(r.fees), 0);
    const ok = outs.filter((r) => r.currency === currency && r.status !== 'failed');
    const refunds = ok.filter((r) => r.type === 'refund');
    const payWallet = ok.filter((r) => r.type === 'payout' && r.method === 'wallet');
    const payMm = ok.filter((r) => r.type === 'payout' && r.method !== 'wallet');
    const op = open.find((r) => r.currency === currency) || { n: 0, amount: 0 };
    return {
      currency,
      balance: Number(wallets.find((w) => w.currency === currency)?.balance || 0),
      received: { count: pd.n, gross: Number(pd.gross), fees: Number(pd.fees), net: Number(pd.gross) - Number(pd.fees) },
      attempts: { total: at.reduce((s, r) => s + r.n, 0), succeeded, failed, abandoned, success_rate: succeeded + failed + abandoned ? succeeded / (succeeded + failed + abandoned) : null },
      open: { count: op.n, amount: Number(op.amount) },
      outflows: {
        total: sum(ok),
        refunds: { count: refunds.reduce((s, r) => s + r.n, 0), amount: sum(refunds) },
        payouts_wallet: { count: payWallet.reduce((s, r) => s + r.n, 0), amount: sum(payWallet) },
        payouts_mobile_money: { count: payMm.reduce((s, r) => s + r.n, 0), amount: sum(payMm) },
        pending: outs.filter((r) => r.currency === currency && r.status === 'pending').reduce((s, r) => s + r.n, 0),
      },
      daily: daily.filter((r) => r.currency === currency).map((r) => ({ day: r.day, count: r.n, net: Number(r.net) })),
    };
  });
  return { object: 'merchant_summary', from, to, currencies };
}

// ---------------- Export CSV (séparateur « ; », lisible par Excel en français) ----------------
const cell = (v) => {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // pas d'injection de formule dans le tableur
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const dec = (minor) => (minor == null ? '' : (Number(minor) / 100).toFixed(2).replace('.', ','));
const toCsv = (head, rows) => '﻿' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';

export function paymentsCsv(list) {
  return toCsv(
    ['Date', 'Référence Pay243', 'Référence marchand', 'N° de vente / commande', 'Description', 'Statut', 'Moyen', 'Opérateur', 'Payeur', 'Téléphone', 'Devise', 'Montant', 'Frais', 'Net', 'Remboursé', 'Payé le', 'Créé le'],
    list.map((p) => [
      p.paid_at || p.created_at, p.id, p.reference, (p.order_refs || []).join(', '), p.description, p.status, p.method,
      p.payer?.operator, p.payer?.name, p.payer?.phone, p.currency, dec(p.amount), dec(p.fee), dec(p.net), dec(p.refunded_amount), p.paid_at, p.created_at,
    ]),
  );
}

export function outflowsCsv(list) {
  return toCsv(
    ['Date', 'Référence Pay243', 'Type', 'Statut', 'Moyen', 'Opérateur', 'Téléphone', 'Devise', 'Montant', 'Frais', 'Total débité', 'Paiement lié', 'Référence marchand', 'N° de vente / commande', 'Motif', 'Réf. opérateur', 'Échec'],
    list.map((o) => [
      o.created_at, o.id, o.kind, o.status, o.method, o.operator, o.phone, o.currency, dec(o.amount), dec(o.fee), dec(o.total),
      o.payment?.id, o.payment?.reference, (o.payment?.order_refs || []).join(', '), o.reason || o.description, o.provider_ref, o.failure_reason,
    ]),
  );
}
