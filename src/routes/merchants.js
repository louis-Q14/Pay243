import crypto from 'node:crypto';
import { Router } from 'express';
import { requireMerchantKey, requireUser } from '../auth.js';
import { config } from '../config.js';
import { isUniqueViolation, q, tx } from '../db.js';
import { getWallet, lockWallet } from '../ledger.js';
import { idempotent } from '../middleware.js';
import { assertPublicUrl } from '../netguard.js';
import { refreshPending, startPayout } from '../services/mobileMoney.js';
import { cancelPayment, createPayment, getPayment, refundPayment, serializePayment } from '../services/payments.js';
import { listEvents } from '../services/webhooks.js';
import { createMerchantAccount, issueKey } from '../services/merchants.js';
import { HttpError, assertAmount, assertCurrency, now, percentFee } from '../util.js';

// =====================================================================
//  Espace marchand (géré depuis l'application, authentifié par session)
// =====================================================================
export const merchantAdminRouter = Router();
merchantAdminRouter.use('/merchants', requireUser);

async function validWebhookUrl(u) {
  if (!u) return null;
  let url;
  try { url = new URL(u); } catch { throw new HttpError(400, 'invalid_url', 'webhook_url invalide.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'invalid_url', 'webhook_url doit être une URL http(s).');
  if (config.mode === 'live' && url.protocol !== 'https:') throw new HttpError(400, 'invalid_url', 'webhook_url doit être en HTTPS en production.');
  try {
    await assertPublicUrl(url.toString());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid_url', `Impossible de résoudre ${url.hostname}.`);
  }
  return url.toString();
}

async function merchantOfUser(user) {
  const m = await q.get('SELECT * FROM merchants WHERE owner_user_id=?', user.id);
  if (!m) throw new HttpError(404, 'merchant_not_found', "Vous n'avez pas encore de compte marchand.");
  return m;
}

async function serializeMerchant(m, { withSecret = false } = {}) {
  const balances = [];
  for (const c of config.currencies) balances.push({ currency: c, balance: (await getWallet('merchant', m.id, c)).balance });
  const keys = await q.all('SELECT * FROM api_keys WHERE merchant_id=? AND revoked_at IS NULL ORDER BY created_at DESC', m.id);
  return {
    id: m.id,
    object: 'merchant',
    name: m.name,
    webhook_url: m.webhook_url,
    ...(withSecret ? { webhook_secret: m.webhook_secret } : {}),
    balances,
    api_keys: keys.map((k) => ({ id: k.id, mode: k.mode, preview: `${k.prefix}…${k.last4}`, created_at: k.created_at })),
    fees: { percent: config.fees.merchantPercent },
    created_at: m.created_at,
  };
}

const merchantExists = () => new HttpError(409, 'merchant_exists', 'Vous avez déjà un compte marchand.');

merchantAdminRouter.post('/merchants', async (req, res) => {
  const { name, webhook_url } = req.body || {};
  if (!name || String(name).trim().length < 2) throw new HttpError(400, 'invalid_name', 'Nom commercial requis.');
  if (await q.get('SELECT id FROM merchants WHERE owner_user_id=?', req.user.id)) throw merchantExists();
  const hookUrl = await validWebhookUrl(webhook_url);
  let id; let secretKey;
  try {
    ({ id, secretKey } = await tx(() => createMerchantAccount(req.user.id, name, hookUrl)));
  } catch (e) {
    if (isUniqueViolation(e)) throw merchantExists();
    throw e;
  }
  const m = await q.get('SELECT * FROM merchants WHERE id=?', id);
  res.status(201).json({ ...(await serializeMerchant(m, { withSecret: true })), secret_key: secretKey, notice: 'Conservez cette clé secrète : elle ne sera plus affichée.' });
});

merchantAdminRouter.get('/merchants/me', async (req, res) => {
  res.json(await serializeMerchant(await merchantOfUser(req.user), { withSecret: true }));
});

merchantAdminRouter.patch('/merchants/me', async (req, res) => {
  const m = await merchantOfUser(req.user);
  const { name, webhook_url } = req.body || {};
  const hookUrl = webhook_url === undefined ? m.webhook_url : await validWebhookUrl(webhook_url);
  await q.run('UPDATE merchants SET name=COALESCE(?, name), webhook_url=? WHERE id=?',
    name ? String(name).trim() : null, hookUrl, m.id);
  res.json(await serializeMerchant(await q.get('SELECT * FROM merchants WHERE id=?', m.id), { withSecret: true }));
});

merchantAdminRouter.post('/merchants/me/keys', async (req, res) => {
  const m = await merchantOfUser(req.user);
  const mode = req.body?.mode === 'live' ? 'live' : 'test';
  res.status(201).json({ secret_key: await issueKey(m.id, mode), notice: 'Conservez cette clé secrète : elle ne sera plus affichée.' });
});

merchantAdminRouter.delete('/merchants/me/keys/:id', async (req, res) => {
  const m = await merchantOfUser(req.user);
  const r = await q.run('UPDATE api_keys SET revoked_at=? WHERE id=? AND merchant_id=? AND revoked_at IS NULL', now(), req.params.id, m.id);
  if (!r.changes) throw new HttpError(404, 'key_not_found', 'Clé introuvable.');
  res.json({ id: req.params.id, revoked: true });
});

merchantAdminRouter.post('/merchants/me/webhook-secret', async (req, res) => {
  const m = await merchantOfUser(req.user);
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  await q.run('UPDATE merchants SET webhook_secret=? WHERE id=?', secret, m.id);
  res.json({ webhook_secret: secret });
});

/** Lien de paiement sans code (à partager par WhatsApp, SMS...). */
merchantAdminRouter.post('/merchants/me/payment-links', async (req, res) => {
  const m = await merchantOfUser(req.user);
  const p = await createPayment(m, config.mode === 'live', { ...req.body, expires_in_minutes: req.body?.expires_in_minutes || 7 * 24 * 60 });
  res.status(201).json(serializePayment(p));
});

merchantAdminRouter.get('/merchants/me/payments', async (req, res) => {
  const m = await merchantOfUser(req.user);
  res.json({ data: (await q.all('SELECT * FROM payments WHERE merchant_id=? ORDER BY created_at DESC LIMIT 50', m.id)).map(serializePayment) });
});

// =====================================================================
//  API d'intégration marchands (serveur à serveur, clé sk_test_/sk_live_)
// =====================================================================
export const merchantApiRouter = Router();
merchantApiRouter.use(['/payments', '/balance', '/payouts', '/events'], requireMerchantKey);
const idem = idempotent((req) => `merchant:${req.merchant.id}`);

async function ownPayment(req) {
  const p = await getPayment(req.params.id);
  if (!p || p.merchant_id !== req.merchant.id) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  return p;
}

/** Crée un paiement et renvoie l'URL de la page de paiement hébergée. */
merchantApiRouter.post('/payments', idem, async (req, res) => {
  const p = await createPayment(req.merchant, req.livemode, req.body || {});
  res.status(201).json(serializePayment(p));
});

merchantApiRouter.get('/payments', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const params = [req.merchant.id];
  let where = 'merchant_id=?';
  if (req.query.status) { where += ' AND status=?'; params.push(String(req.query.status)); }
  if (req.query.reference) { where += ' AND reference=?'; params.push(String(req.query.reference)); }
  const rows = await q.all(`SELECT * FROM payments WHERE ${where} ORDER BY created_at DESC LIMIT ?`, ...params, limit);
  res.json({ object: 'list', data: rows.map(serializePayment) });
});

merchantApiRouter.get('/payments/:id', async (req, res) => {
  const p = await ownPayment(req);
  if (p.status === 'processing' && p.txn_id == null) {
    const pending = await q.get("SELECT * FROM transactions WHERE payment_id=? AND status='pending' ORDER BY created_at DESC", p.id);
    if (pending) await refreshPending(pending);
  }
  res.json(serializePayment(await getPayment(p.id)));
});

merchantApiRouter.post('/payments/:id/refunds', idem, async (req, res) => {
  const p = await ownPayment(req);
  const refund = await refundPayment(p.id, req.merchant, req.body?.amount, req.body?.reason);
  res.status(201).json(refund);
});

merchantApiRouter.post('/payments/:id/cancel', async (req, res) => {
  const p = await ownPayment(req);
  res.json(serializePayment(await cancelPayment(p.id, req.merchant)));
});

merchantApiRouter.get('/balance', async (req, res) => {
  const available = [];
  for (const c of config.currencies) available.push({ currency: c, amount: (await getWallet('merchant', req.merchant.id, c)).balance });
  res.json({ object: 'balance', available });
});

/** Versement du solde marchand vers un numéro Mobile Money. */
merchantApiRouter.post('/payouts', idem, async (req, res) => {
  const amount = assertAmount(req.body?.amount);
  const currency = assertCurrency(req.body?.currency);
  const fee = percentFee(amount, config.fees.withdrawalPercent);
  const w = await getWallet('merchant', req.merchant.id, currency);
  const insufficient = () => new HttpError(402, 'insufficient_funds', `Solde insuffisant : ${amount + fee} requis (dont ${fee} de frais).`);
  if (w.balance < amount + fee) throw insufficient();
  const t = await startPayout({
    type: 'payout', fromWalletId: w.id, phone: req.body?.phone, operator: req.body?.operator,
    amount, fee, currency, merchantId: req.merchant.id, description: `Versement ${req.merchant.name}`,
    guard: async () => { if ((await lockWallet(w.id)).balance < amount + fee) throw insufficient(); },
  });
  res.status(202).json({ id: t.id, object: 'payout', status: t.status, amount: t.amount, fee: t.fee, currency: t.currency, phone: t.phone, operator: t.operator, created_at: t.created_at });
});

merchantApiRouter.get('/events', async (req, res) => {
  res.json({ object: 'list', data: await listEvents(req.merchant.id, Math.min(Number(req.query.limit) || 20, 100)) });
});
