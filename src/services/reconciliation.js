import crypto from 'node:crypto';
import { config } from '../config.js';
import { acquireLease, isUniqueViolation, q, releaseLease, tx } from '../db.js';
import { getTxn, lockTxn, updateTxn } from '../ledger.js';
import { HttpError, newId, now, parseJson } from '../util.js';
import { COLLECTION_TYPES, PAYOUT_TYPES, handleProviderResult, refreshPending } from './mobileMoney.js';
import { getPayment } from './payments.js';
import { audit } from './kyc.js';

/*
 * Rapprochement Mobile Money : trois filets de sécurité complémentaires.
 *
 *  1. Contrôle des transactions en attente (automatique, toutes les 5 min) : interroge l'opérateur pour
 *     chaque opération restée "pending". Un encaissement sans réponse finit en échec (le client peut
 *     réessayer) avec une alerte ; un décaissement n'est JAMAIS restitué d'office (l'argent est peut-être
 *     parti) : il est signalé à la finance.
 *  2. Rapprochement quotidien avec le relevé de l'opérateur : chaque ligne du relevé est comparée au
 *     grand livre ; les écarts deviennent des « exceptions » à traiter au back-office.
 *  3. Rapport de cantonnement : monnaie électronique en circulation comparée aux fonds détenus.
 */

const KIND_LABELS = {
  not_credited: "Réussi chez l'opérateur, non crédité chez Pay243",
  unknown_operator_txn: "Opération du relevé inconnue de Pay243",
  not_at_operator: "Réussi chez Pay243, absent ou échoué chez l'opérateur",
  amount_mismatch: 'Montant, devise ou sens différent',
  collection_expired: "Encaissement expiré sans réponse de l'opérateur",
  payout_stuck: 'Décaissement bloqué en attente',
};

const direction = (type) => (COLLECTION_TYPES.includes(type) ? 'collect' : 'disburse');

// ---------------- Journée comptable (heure de Kinshasa) ----------------
export function businessDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || Number.isNaN(Date.parse(date))) {
    throw new HttpError(400, 'invalid_date', 'date au format AAAA-MM-JJ requise.');
  }
  const start = Date.parse(`${date}T00:00:00Z`) - config.recon.tzOffsetMinutes * 60_000;
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}
export const localDate = (ts = Date.now()) => new Date(ts + config.recon.tzOffsetMinutes * 60_000).toISOString().slice(0, 10);

// ---------------- Exceptions ----------------
/** Ouvre un écart ; ignoré s'il en existe déjà un ouvert du même type sur la transaction (index unique). */
async function openException(kind, { runId = null, txn = null, operator, providerRef, amount, currency, details }) {
  const r = await q.run(`INSERT INTO recon_exceptions (id, run_id, kind, txn_id, operator, provider_ref, amount, currency, details, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'open',?) ON CONFLICT DO NOTHING`,
  newId('rex'), runId, kind, txn?.id || null, operator ?? txn?.operator ?? null, providerRef ?? txn?.provider_ref ?? null,
  amount ?? txn?.amount ?? null, currency ?? txn?.currency ?? null, details ? JSON.stringify(details) : null, now());
  return r.changes > 0;
}

export async function serializeException(e) {
  const t = e.txn_id ? await getTxn(e.txn_id) : null;
  return {
    id: e.id,
    object: 'recon_exception',
    kind: e.kind,
    label: KIND_LABELS[e.kind] || e.kind,
    status: e.status,
    run_id: e.run_id,
    operator: e.operator,
    provider_ref: e.provider_ref,
    amount: e.amount,
    currency: e.currency,
    details: parseJson(e.details, {}),
    transaction: t ? { id: t.id, type: t.type, status: t.status, amount: t.amount, currency: t.currency, phone: t.phone, created_at: t.created_at, failure_reason: t.failure_reason } : null,
    resolution: e.resolution,
    resolved_by: e.resolved_by,
    resolution_note: e.resolution_note,
    resolved_at: e.resolved_at,
    created_at: e.created_at,
  };
}

export async function listExceptions(status = 'open', limit = 100) {
  if (!['open', 'resolved'].includes(status)) throw new HttpError(400, 'invalid_status', 'status doit valoir open ou resolved.');
  const rows = await q.all(`SELECT * FROM recon_exceptions WHERE status=? ORDER BY created_at ${status === 'open' ? 'ASC' : 'DESC'} LIMIT ?`, status, Math.min(limit, 500));
  return Promise.all(rows.map(serializeException));
}

// ---------------- 1. Contrôle des transactions en attente ----------------
/**
 * Une seule instance exécute le contrôle à la fois (bail en base de 10 min).
 * `nowMs` permet de simuler l'écoulement du temps (tests).
 */
export async function sweepPending({ nowMs = Date.now() } = {}) {
  if (!(await acquireLease('recon_sweep', 10 * 60_000))) return null;
  const out = { checked: 0, resolved: 0, expired: 0, flagged: 0 };
  try {
    const cutoff = new Date(nowMs - config.recon.checkAfterSeconds * 1000).toISOString();
    const rows = await q.all("SELECT * FROM transactions WHERE status='pending' AND operator IS NOT NULL AND created_at <= ? ORDER BY created_at LIMIT 200", cutoff);
    for (const t of rows) {
      out.checked++;
      const fresh = await refreshPending(t);
      if (fresh.status !== 'pending') { out.resolved++; continue; }
      const ageMinutes = Math.floor((nowMs - Date.parse(t.created_at)) / 60_000);
      if (COLLECTION_TYPES.includes(t.type) && ageMinutes >= config.recon.collectionExpireMinutes) {
        await handleProviderResult({ txnId: t.id, status: 'failed', reason: "Délai dépassé sans confirmation de l'opérateur." });
        await openException('collection_expired', { txn: t, details: { age_minutes: ageMinutes } });
        out.expired++;
      } else if (PAYOUT_TYPES.includes(t.type) && ageMinutes >= config.recon.payoutAlertMinutes) {
        if (await openException('payout_stuck', { txn: t, details: { age_minutes: ageMinutes } })) out.flagged++;
      }
    }
  } finally {
    await releaseLease('recon_sweep');
  }
  return out;
}

let timer;
export function startReconWorker() {
  if (timer) return;
  timer = setInterval(() => sweepPending().catch((e) => console.error('[recon]', e)), config.recon.sweepIntervalMs);
  timer.unref();
}

// ---------------- 2. Rapprochement avec le relevé opérateur ----------------
/**
 * Format canonique du relevé (CSV, une ligne d'en-tête) :
 *   provider_ref,reference,type,amount,currency,status,timestamp
 *   - reference : identifiant Pay243 (txn_…) quand l'opérateur le restitue
 *   - type      : collect (encaissement) | disburse (décaissement)
 *   - amount    : montant en unités majeures (ex. 12.50)
 *   - status    : succeeded | failed (COMPLETED, SUCCESS, TS, FAILED, TF acceptés)
 * Les relevés réels (export du portail opérateur ou de l'agrégateur) se convertissent vers ce format :
 * un adaptateur par opérateur, à écrire avec un vrai fichier en main.
 */
function parseCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const split = (line) => {
    const out = []; let cur = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === ';') { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  if (!lines.length) throw new HttpError(400, 'empty_statement', 'Relevé vide.');
  const header = split(lines[0]).map((h) => h.toLowerCase());
  for (const col of ['provider_ref', 'type', 'amount', 'currency', 'status']) {
    if (!header.includes(col)) throw new HttpError(400, 'invalid_statement', `Colonne obligatoire manquante : ${col}.`);
  }
  return lines.slice(1).map((l, i) => {
    const cells = split(l);
    const row = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
    const amount = Math.round(Number(String(row.amount).replace(',', '.')) * 100);
    const status = ({ succeeded: 'succeeded', success: 'succeeded', completed: 'succeeded', ts: 'succeeded', failed: 'failed', tf: 'failed', rejected: 'failed' })[String(row.status).toLowerCase()];
    const type = ({ collect: 'collect', deposit: 'collect', c2b: 'collect', disburse: 'disburse', payout: 'disburse', b2c: 'disburse' })[String(row.type).toLowerCase()];
    if (!row.provider_ref || !Number.isSafeInteger(amount) || amount <= 0 || !status || !type || !config.currencies.includes(String(row.currency).toUpperCase())) {
      throw new HttpError(400, 'invalid_statement_row', `Ligne ${i + 2} invalide : ${l.slice(0, 120)}`);
    }
    return { line: i + 2, provider_ref: row.provider_ref, reference: row.reference || null, type, amount, currency: row.currency.toUpperCase(), status, timestamp: row.timestamp || null };
  });
}

export async function importStatement({ operator, date, csv, replace = false }, actor, ip) {
  if (!config.providers[operator]) throw new HttpError(400, 'invalid_operator', `operator doit valoir : ${Object.keys(config.providers).join(', ')}.`);
  const { start, end } = businessDay(date);
  const rows = parseCsv(csv);
  const existing = await q.get("SELECT * FROM recon_runs WHERE operator=? AND business_date=? AND status='completed'", operator, date);
  if (existing && !replace) {
    throw new HttpError(409, 'already_reconciled', `Le relevé ${operator} du ${date} a déjà été importé. Renvoyez avec replace=1 pour le remplacer.`);
  }

  const conflict = () => new HttpError(409, 'already_reconciled', `Le relevé ${operator} du ${date} vient d'être importé par ailleurs. Réessayez avec replace=1.`);
  try {
    return await tx(async () => {
    if (existing) {
      const sup = await q.run("UPDATE recon_runs SET status='superseded' WHERE id=? AND status='completed'", existing.id);
      if (!sup.changes) throw conflict();
      await q.run("UPDATE recon_exceptions SET status='resolved', resolution='superseded', resolved_by=?, resolved_at=? WHERE run_id=? AND status='open'", actor, now(), existing.id);
    }
    const runId = newId('rcn');
    const ours = await q.all("SELECT * FROM transactions WHERE operator=? AND method='mobile_money' AND created_at >= ? AND created_at < ?", operator, start, end);
    const byRef = new Map(ours.filter((t) => t.provider_ref).map((t) => [t.provider_ref, t]));
    const byId = new Map(ours.map((t) => [t.id, t]));
    const find = async (r) => byRef.get(r.provider_ref) || (r.reference && byId.get(r.reference))
      // Hors fenêtre (opération à cheval sur minuit) : recherche globale.
      || q.get('SELECT * FROM transactions WHERE operator=? AND (provider_ref=? OR id=?)', operator, r.provider_ref, r.reference || '');

    const seen = new Set();
    const totals = {};
    const tot = (cur) => (totals[cur] ||= { statement_net: 0, ledger_net: 0, difference: 0 });
    let matched = 0; let exceptions = 0;
    const flag = async (kind, args) => { if (await openException(kind, { runId, operator, ...args })) exceptions++; };

    for (const r of rows) {
      const t = await find(r);
      if (t) seen.add(t.id);
      if (r.status === 'succeeded') tot(r.currency).statement_net += r.type === 'collect' ? r.amount : -r.amount;
      if (r.status !== 'succeeded') {
        if (t?.status === 'succeeded') await flag('not_at_operator', { txn: t, details: { statement: r } });
        continue;
      }
      if (!t) { await flag('unknown_operator_txn', { providerRef: r.provider_ref, amount: r.amount, currency: r.currency, details: { statement: r } }); continue; }
      if (t.amount !== r.amount || t.currency !== r.currency || direction(t.type) !== r.type) {
        await flag('amount_mismatch', { txn: t, details: { statement: r, ledger: { amount: t.amount, currency: t.currency, type: direction(t.type) } } });
        continue;
      }
      if (t.status === 'succeeded') matched++;
      else await flag('not_credited', { txn: t, details: { statement: r, ledger_status: t.status } });
    }

    for (const t of ours) {
      if (t.status !== 'succeeded') continue;
      tot(t.currency).ledger_net += COLLECTION_TYPES.includes(t.type) ? t.amount : -t.amount;
      if (!seen.has(t.id)) await flag('not_at_operator', { txn: t, details: { reason: 'Absent du relevé' } });
    }
    for (const v of Object.values(totals)) v.difference = v.statement_net - v.ledger_net;

    const byKind = (await q.all('SELECT kind, COUNT(*) AS n FROM recon_exceptions WHERE run_id=? GROUP BY kind ORDER BY kind', runId))
      .reduce((acc, x) => ({ ...acc, [x.kind]: x.n }), {});
    const summary = { window: { start, end }, ledger_transactions: ours.length, exceptions_by_kind: byKind, totals };
    await q.run(`INSERT INTO recon_runs (id, operator, business_date, status, rows, matched, exceptions, summary, imported_by, file_sha256, created_at)
           VALUES (?,?,?,'completed',?,?,?,?,?,?,?)`,
    runId, operator, date, rows.length, matched, exceptions, JSON.stringify(summary), actor,
    crypto.createHash('sha256').update(String(csv)).digest('hex'), now());
    await audit(actor, 'recon.import', runId, { operator, date, rows: rows.length, matched, exceptions, replaced: existing?.id || null }, ip);
    return serializeRun(await q.get('SELECT * FROM recon_runs WHERE id=?', runId));
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict(); // import concurrent du même relevé
    throw e;
  }
}

export const serializeRun = (r) => ({ ...r, object: 'recon_run', summary: parseJson(r.summary, {}) });
export const listRuns = async (limit = 30) => (await q.all('SELECT * FROM recon_runs ORDER BY created_at DESC LIMIT ?', Math.min(limit, 200))).map(serializeRun);

// ---------------- Traitement d'une exception ----------------
export async function resolveException(id, actor, { action, note } = {}, ip) {
  const e = await q.get('SELECT * FROM recon_exceptions WHERE id=?', id);
  if (!e) throw new HttpError(404, 'exception_not_found', 'Écart introuvable.');
  if (e.status !== 'open') throw new HttpError(409, 'already_resolved', 'Écart déjà traité.');
  const n = String(note || '').trim();
  if (n.length < 10) throw new HttpError(400, 'note_required', 'Une note explicative (10 caractères min.) est requise.');
  const t = e.txn_id ? await getTxn(e.txn_id) : null;

  let resolution;
  if (action === 'acknowledge') {
    resolution = 'acknowledged';
  } else if (action === 'apply_success') {
    if (!t) throw new HttpError(409, 'no_transaction', 'Aucune transaction Pay243 à valider : traitez cet écart manuellement puis marquez-le comme vu.');
    if (e.kind === 'amount_mismatch') throw new HttpError(409, 'amount_mismatch', "Montant différent : impossible de valider automatiquement. Contactez l'opérateur.");
    if (t.status === 'failed' && PAYOUT_TYPES.includes(t.type)) {
      throw new HttpError(409, 'funds_returned', "Les fonds ont déjà été restitués au client alors que l'opérateur a payé : récupération manuelle requise.");
    }
    if (t.status === 'failed' && t.type === 'payment') {
      const p = await getPayment(t.payment_id);
      if (!['requires_payment', 'expired', 'processing'].includes(p?.status)) {
        throw new HttpError(409, 'payer_refund_needed', `Le paiement est déjà « ${p?.status} » (payé autrement ou annulé) : remboursez le payeur, puis marquez l'écart comme vu.`);
      }
    }
    if (!['pending', 'failed'].includes(t.status)) throw new HttpError(409, 'invalid_state', `Transaction au statut « ${t.status} ».`);
    await tx(async () => {
      const locked = await lockTxn(t.id);
      if (locked.status !== t.status) throw new HttpError(409, 'state_changed', 'La transaction vient de changer de statut : rechargez.');
      if (locked.status === 'failed') await updateTxn(t.id, { status: 'pending', failure_reason: null }); // réouverture tracée par l'audit
      await handleProviderResult({ txnId: t.id, status: 'succeeded' });
    });
    resolution = 'applied_success';
  } else if (action === 'apply_failure') {
    if (t?.status !== 'pending') throw new HttpError(409, 'invalid_state', 'Seule une transaction encore en attente peut être déclarée échouée.');
    await handleProviderResult({ txnId: t.id, status: 'failed', reason: `Échec confirmé par la finance : ${n.slice(0, 120)}` });
    resolution = 'applied_failure';
  } else {
    throw new HttpError(400, 'invalid_action', 'action doit valoir acknowledge, apply_success ou apply_failure.');
  }

  await tx(async () => {
    // Un même dénouement règle tous les écarts ouverts sur la transaction.
    const ids = t && resolution !== 'acknowledged'
      ? (await q.all("SELECT id FROM recon_exceptions WHERE txn_id=? AND status='open'", t.id)).map((x) => x.id)
      : [e.id];
    let closed = 0;
    for (const xid of ids) {
      const r = await q.run("UPDATE recon_exceptions SET status='resolved', resolution=?, resolved_by=?, resolution_note=?, resolved_at=? WHERE id=? AND status='open'",
        resolution, actor, n.slice(0, 500), now(), xid);
      closed += r.changes;
    }
    if (resolution === 'acknowledged' && !closed) throw new HttpError(409, 'already_resolved', 'Écart déjà traité.');
    await audit(actor, `recon.${resolution}`, e.id, { txn_id: t?.id || null, kind: e.kind, closed, note: n }, ip);
  });
  return serializeException(await q.get('SELECT * FROM recon_exceptions WHERE id=?', e.id));
}

// ---------------- 3. Cantonnement ----------------
/**
 * Monnaie électronique en circulation (soldes clients + marchands + décaissements en cours) par devise,
 * à comparer au solde du compte de cantonnement à la banque partenaire (`trust` en unités mineures).
 */
export async function safeguardingReport(trust = {}) {
  return Promise.all(config.currencies.map(async (currency) => {
    const sum = async (owner) => (await q.get('SELECT COALESCE(SUM(balance),0) AS s FROM wallets WHERE owner_type=? AND currency=?', owner, currency)).s;
    const sys = Object.fromEntries((await q.all("SELECT owner_id, balance FROM wallets WHERE owner_type='system' AND currency=?", currency)).map((w) => [w.owner_id, w.balance]));
    const users = await sum('user');
    const merchants = await sum('merchant');
    const inFlight = sys.payout_pending || 0;
    const outstanding = users + merchants + inFlight;
    const floats = Object.fromEntries(Object.entries(sys).filter(([k]) => k.startsWith('float_')).map(([k, v]) => [k.slice(6), -v]));
    const trustBalance = Number.isSafeInteger(trust[currency]) ? trust[currency] : null;
    return {
      currency,
      e_money_outstanding: outstanding,
      breakdown: { users, merchants, payouts_in_flight: inFlight },
      platform: { fees: sys.fees || 0, fx_pool: sys.fx_pool || 0 },
      held_at_partners: floats, // fonds reçus/versés via chaque canal (contrepartie du grand livre)
      trust_account: trustBalance,
      coverage: trustBalance == null ? null : trustBalance - outstanding, // doit être >= 0
      covered: trustBalance == null ? null : trustBalance >= outstanding,
    };
  }));
}
