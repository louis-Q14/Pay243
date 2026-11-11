import crypto from 'node:crypto';
import { afterCommit, q } from '../db.js';
import { assertPublicUrl } from '../netguard.js';
import { newId, now, parseJson } from '../util.js';

const MAX_ATTEMPTS = 8; // ~ 10s, 20s, 40s ... jusqu'à ~ 21 min entre les essais
const LEASE_MS = 60_000; // un événement réservé par une instance n'est pas repris par une autre pendant 1 min

/**
 * Signature des webhooks (même principe que Stripe) :
 *   En-tête  Pay243-Signature: t=<timestamp>,v1=<hex HMAC-SHA256(secret, "<timestamp>.<corps brut>")>
 * Le marchand recalcule le HMAC avec son webhook_secret et rejette les messages de plus de 5 minutes.
 */
export function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Enregistre l'événement (dans la transaction courante) et déclenche l'envoi après validation. */
export async function enqueueEvent(merchantId, type, data) {
  const evt = { id: newId('evt'), object: 'event', type, created_at: now(), data };
  await q.run(
    'INSERT INTO webhook_events (id, merchant_id, type, payload, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,0,?,?)',
    evt.id, merchantId, type, JSON.stringify(evt), now(), now(),
  );
  afterCommit(() => deliverDue().catch(() => {}));
  return evt;
}

let running = false;
export async function deliverDue() {
  if (running) return;
  running = true;
  try {
    // Réservation atomique : plusieurs instances se partagent la file sans doublon (SKIP LOCKED).
    const due = await q.all(
      `UPDATE webhook_events SET next_attempt_at = ?
        WHERE id IN (SELECT id FROM webhook_events
                      WHERE delivered_at IS NULL AND attempts < ? AND next_attempt_at <= ?
                      ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      new Date(Date.now() + LEASE_MS).toISOString(), MAX_ATTEMPTS, now(),
    );
    due.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const e of due) {
      const m = await q.get('SELECT * FROM merchants WHERE id=?', e.merchant_id);
      if (!m?.webhook_url) {
        await q.run('UPDATE webhook_events SET next_attempt_at=?, last_error=? WHERE id=?',
          new Date(Date.now() + 3600e3).toISOString(), 'Aucune URL de webhook configurée', e.id);
        continue;
      }
      let error = null;
      try {
        await assertPublicUrl(m.webhook_url); // revérifié à chaque envoi (le DNS peut changer)
        const r = await fetch(m.webhook_url, {
          redirect: 'manual', // une redirection pourrait viser une adresse interne
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Pay243-Webhooks/1.0',
            'Pay243-Signature': signPayload(m.webhook_secret, e.payload),
          },
          body: e.payload,
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) error = `HTTP ${r.status}`;
      } catch (err) {
        error = err.message;
      }
      const attempts = e.attempts + 1;
      if (!error) {
        await q.run('UPDATE webhook_events SET attempts=?, delivered_at=?, last_error=NULL WHERE id=?', attempts, now(), e.id);
      } else {
        const next = new Date(Date.now() + 10_000 * 2 ** (attempts - 1)).toISOString();
        await q.run('UPDATE webhook_events SET attempts=?, next_attempt_at=?, last_error=? WHERE id=?', attempts, next, error, e.id);
      }
    }
  } finally {
    running = false;
  }
}

export async function listEvents(merchantId, limit = 20) {
  const rows = await q.all('SELECT * FROM webhook_events WHERE merchant_id=? ORDER BY created_at DESC LIMIT ?', merchantId, limit);
  return rows.map((e) => ({ ...parseJson(e.payload), delivery: { attempts: e.attempts, delivered_at: e.delivered_at, last_error: e.last_error } }));
}

let timer;
export function startWebhookWorker(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(() => deliverDue().catch((e) => console.error('[webhooks]', e.message)), intervalMs);
  timer.unref();
}
