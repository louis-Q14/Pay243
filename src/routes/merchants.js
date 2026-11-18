import crypto from 'node:crypto';
import { Router } from 'express';
import { requireActivated, requireMerchantKey, requireUser, verifyPin } from '../auth.js';
import { config } from '../config.js';
import { isUniqueViolation, q, tx } from '../db.js';
import { createTxn, getTxn, getWallet, lockWallet, move, serializeTxn } from '../ledger.js';
import { checkIncoming, lockUsers } from '../limits.js';
import { idempotent } from '../middleware.js';
import { assertPublicUrl } from '../netguard.js';
import { refreshPending, startPayout } from '../services/mobileMoney.js';
import { cancelPayment, createPayment, getPayment, refundPayment, serializePayment, updatePaymentInfo } from '../services/payments.js';
import { monitoringSummary, outflowsCsv, paymentDetail, paymentsCsv, searchOutflows, searchPayments } from '../services/merchantMonitoring.js';
import { assertWithdrawal, purposeOf } from '../services/paymentSplit.js';
import { listEvents } from '../services/webhooks.js';
import { accessOf, assertMerchantEnabled, businessProfileOf, createMerchantAccount, issueKey } from '../services/merchants.js';
import { appUrl, notifyUser } from '../services/notify.js';
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
  if (config.exposed && url.protocol !== 'https:') throw new HttpError(400, 'invalid_url', 'webhook_url doit être en HTTPS.');
  if (String(u).length > 500) throw new HttpError(400, 'invalid_url', 'webhook_url trop longue (500 caractères max.).');
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
/** Espace marchand activé par l'équipe : condition de toutes les actions d'encaissement. */
async function enabledMerchantOf(user) {
  const m = await merchantOfUser(user);
  assertMerchantEnabled(m);
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
    business: businessProfileOf(m),
    access: accessOf(m),
    webhook_url: m.webhook_url,
    ...(withSecret ? { webhook_secret: m.webhook_secret } : {}),
    balances,
    api_keys: keys.map((k) => ({ id: k.id, mode: k.mode, preview: `${k.prefix}…${k.last4}`, created_at: k.created_at })),
    fees: { percent: config.fees.merchantPercent },
    created_at: m.created_at,
  };
}

const merchantExists = () => new HttpError(409, 'merchant_exists', 'Vous avez déjà un compte marchand.');
const businessOnly = () => new HttpError(403, 'business_only', "L'espace marchand est réservé aux comptes entreprise : passez d'abord à un compte entreprise dans vos paramètres.");

/** Demande d'activation de l'espace marchand (comptes entreprise), examinée par l'équipe. */
async function requestAccess(m, user, note) {
  const r = await q.run(`UPDATE merchants SET access_status='requested', access_requested_at=?, access_request=?, access_note=NULL
                         WHERE id=? AND access_status IN ('none','rejected','disabled')`, now(), note, m.id);
  if (!r.changes) {
    throw m.access_status === 'enabled' ? new HttpError(409, 'merchant_already_enabled', 'Votre espace marchand est déjà activé.')
      : new HttpError(409, 'access_already_requested', "Votre demande d'activation est déjà en cours d'examen.");
  }
  notifyUser(user, 'account', `Demande d'activation reçue — ${m.name}`, `Nous avons bien reçu votre demande d'activation de l'espace marchand ${m.name}.`, {
    title: "Demande d'activation reçue",
    paragraphs: [`Nous avons bien reçu votre demande d'activation de l'espace marchand « ${m.name} ». Notre équipe l'examine et vous prévient par email dès qu'elle est traitée.`,
      "Une fois l'espace activé, vous pourrez créer des liens de paiement, générer vos clés API et recevoir des paiements."],
    cta: { label: 'Suivre ma demande', url: appUrl('/settings#vendeur') },
  });
}

merchantAdminRouter.post('/merchants/me/access-request', async (req, res) => {
  if (req.user.account_type !== 'business') throw businessOnly();
  const m = await merchantOfUser(req.user);
  const note = String(req.body?.message ?? '').trim().replace(/\s+/g, ' ').slice(0, 600) || null;
  await requestAccess(m, req.user, note);
  res.json(await serializeMerchant(await q.get('SELECT * FROM merchants WHERE id=?', m.id)));
});

merchantAdminRouter.post('/merchants', requireActivated, async (req, res) => {
  if (req.user.account_type !== 'business') throw businessOnly();
  const { name, webhook_url } = req.body || {};
  if (!name || String(name).trim().length < 2 || String(name).trim().length > 80) throw new HttpError(400, 'invalid_name', 'Nom commercial requis (2 à 80 caractères).');
  if (await q.get('SELECT id FROM merchants WHERE owner_user_id=?', req.user.id)) throw merchantExists();
  const hookUrl = await validWebhookUrl(webhook_url);
  let id;
  try {
    ({ id } = await tx(() => createMerchantAccount(req.user.id, name, hookUrl)));
  } catch (e) {
    if (isUniqueViolation(e)) throw merchantExists();
    throw e;
  }
  // Créer l'espace vaut demande d'activation : l'équipe l'examine avant tout encaissement.
  await requestAccess(await q.get('SELECT * FROM merchants WHERE id=?', id), req.user, null);
  res.status(201).json(await serializeMerchant(await q.get('SELECT * FROM merchants WHERE id=?', id), { withSecret: true }));
});

merchantAdminRouter.get('/merchants/me', async (req, res) => {
  res.json(await serializeMerchant(await merchantOfUser(req.user), { withSecret: true }));
});

merchantAdminRouter.patch('/merchants/me', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const { name, webhook_url } = req.body || {};
  if (name != null && name !== '' && (String(name).trim().length < 2 || String(name).trim().length > 80)) throw new HttpError(400, 'invalid_name', 'Nom commercial : 2 à 80 caractères.');
  const hookUrl = webhook_url === undefined ? m.webhook_url : await validWebhookUrl(webhook_url);
  await q.run('UPDATE merchants SET name=COALESCE(?, name), webhook_url=? WHERE id=?',
    name ? String(name).trim() : null, hookUrl, m.id);
  res.json(await serializeMerchant(await q.get('SELECT * FROM merchants WHERE id=?', m.id), { withSecret: true }));
});

merchantAdminRouter.post('/merchants/me/keys', requireActivated, async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const mode = req.body?.mode === 'live' ? 'live' : 'test';
  const { n } = await q.get('SELECT COUNT(*)::int AS n FROM api_keys WHERE merchant_id=? AND revoked_at IS NULL', m.id);
  if (n >= 10) throw new HttpError(400, 'too_many_keys', '10 clés actives maximum : révoquez-en une avant d’en créer une nouvelle.');
  res.status(201).json({ secret_key: await issueKey(m.id, mode), notice: 'Conservez cette clé secrète : elle ne sera plus affichée.' });
});

merchantAdminRouter.delete('/merchants/me/keys/:id', async (req, res) => {
  const m = await merchantOfUser(req.user);
  const r = await q.run('UPDATE api_keys SET revoked_at=? WHERE id=? AND merchant_id=? AND revoked_at IS NULL', now(), req.params.id, m.id);
  if (!r.changes) throw new HttpError(404, 'key_not_found', 'Clé introuvable.');
  res.json({ id: req.params.id, revoked: true });
});

merchantAdminRouter.post('/merchants/me/webhook-secret', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  await q.run('UPDATE merchants SET webhook_secret=? WHERE id=?', secret, m.id);
  res.json({ webhook_secret: secret });
});

/** Lien de paiement sans code (à partager par WhatsApp, SMS...). */
merchantAdminRouter.post('/merchants/me/payment-links', requireActivated, async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const p = await createPayment(m, config.mode === 'live', { ...req.body, expires_in_minutes: req.body?.expires_in_minutes || 7 * 24 * 60 });
  res.status(201).json(serializePayment(p));
});

// ---------------- Suivi des paiements (espace activé par l'équipe) ----------------
const csvFile = (res, name, body) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(body);
};
/** Sans filtre de période explicite, la liste reprend tout l'historique récent (400 jours). */
const withDefaultPeriod = (query) => (query.from || query.to ? query : { ...query, from: new Date(Date.now() - 399 * 864e5).toISOString() });

merchantAdminRouter.get('/merchants/me/monitoring/summary', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  res.json(await monitoringSummary(m.id, req.query));
});

merchantAdminRouter.get('/merchants/me/payments', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const query = withDefaultPeriod(req.query);
  if (req.query.format === 'csv') return csvFile(res, 'pay243-paiements', paymentsCsv((await searchPayments(m.id, { ...query, limit: 5000, offset: 0 }, { max: 5000 })).data));
  res.json(await searchPayments(m.id, query));
});

merchantAdminRouter.get('/merchants/me/payments/:id', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  res.json(await paymentDetail(m.id, req.params.id));
});

/** Rattacher à la main des numéros de vente / de commande à un paiement (ou corriger la description). */
merchantAdminRouter.patch('/merchants/me/payments/:id', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const p = await getPayment(req.params.id);
  if (!p || p.merchant_id !== m.id) throw new HttpError(404, 'payment_not_found', 'Paiement introuvable.');
  const { order_refs, description } = req.body || {};
  await updatePaymentInfo(p, { order_refs: order_refs ?? undefined, ...(description !== undefined ? { description } : {}) });
  res.json(await paymentDetail(m.id, p.id));
});

merchantAdminRouter.get('/merchants/me/outflows', async (req, res) => {
  const m = await enabledMerchantOf(req.user);
  const query = withDefaultPeriod(req.query);
  if (req.query.format === 'csv') return csvFile(res, 'pay243-sorties', outflowsCsv((await searchOutflows(m.id, { ...query, limit: 5000, offset: 0 }, { max: 5000 })).data));
  res.json(await searchOutflows(m.id, query));
});

/**
 * Versement des ventes : du solde marchand vers le wallet personnel du titulaire (instantané, sans frais).
 * Montant omis = tout le solde disponible. Le titulaire peut ensuite retirer, envoyer ou payer depuis son wallet.
 */
merchantAdminRouter.post('/merchants/me/transfer-to-wallet', requireActivated, async (req, res) => {
  const m = await merchantOfUser(req.user);
  if (m.suspended_at) throw new HttpError(403, 'merchant_suspended', 'Votre espace marchand est suspendu : contactez le support.');
  const currency = assertCurrency(req.body?.currency);
  const raw = req.body?.amount;
  const wanted = raw == null || raw === '' ? null : assertAmount(raw);
  const purpose = purposeOf(req.body?.purpose);
  await verifyPin(req.user, req.body?.pin);
  const txn = await tx(async () => {
    await lockUsers(req.user.id);
    const from = await lockWallet((await getWallet('merchant', m.id, currency)).id);
    const balance = Number(from.balance);
    // Place de marché : seuls les revenus de la plateforme sortent ; l'argent des vendeurs reste réservé.
    const st = await assertWithdrawal(m.id, currency, wanted ?? 0, purpose, balance);
    const amount = wanted ?? (st.has_split ? (purpose === 'seller_payout' ? st.seller_payable : st.available) : balance);
    if (amount <= 0) throw new HttpError(400, 'nothing_to_transfer', st.has_split && st.seller_due ? 'Aucun revenu disponible : le solde est réservé aux vendeurs.' : 'Aucune vente disponible dans cette devise.');
    if (balance < amount) throw new HttpError(402, 'insufficient_funds', `Solde marchand ${currency} insuffisant.`);
    await checkIncoming(req.user, currency, amount);
    const to = await getWallet('user', req.user.id, currency);
    const t = await createTxn({
      type: 'payout', status: 'succeeded', amount, currency, method: 'wallet',
      from_wallet: from.id, to_wallet: to.id, merchant_id: m.id,
      description: purpose === 'seller_payout' ? `Reversement vendeurs ${m.name}` : `Versement des ventes ${m.name}`,
      metadata: { counterparty: m.name, ...(st.has_split ? { purpose } : {}), ...(req.body?.note ? { reason: String(req.body.note).slice(0, 140) } : {}) },
    });
    await move(t.id, from.id, to.id, amount);
    return t;
  });
  const to = await getWallet('user', req.user.id, currency);
  res.status(201).json(serializeTxn(await getTxn(txn.id), [to.id]));
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
  if (req.query.order_ref) { where += ' AND order_refs IS NOT NULL AND order_refs::jsonb @> jsonb_build_array(?::text)'; params.push(String(req.query.order_ref)); }
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

/** Mise à jour : order_refs (n° de vente rattachés au paiement), metadata (fusion), description. */
const updateRoute = async (req, res) => {
  const p = await ownPayment(req);
  res.json(serializePayment(await updatePaymentInfo(p, req.body || {})));
};
merchantApiRouter.post('/payments/:id', updateRoute);
merchantApiRouter.patch('/payments/:id', updateRoute);

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
  const purpose = purposeOf(req.body?.purpose);
  const st = await assertWithdrawal(req.merchant.id, currency, amount + fee, purpose, Number(w.balance));
  const t = await startPayout({
    type: 'payout', fromWalletId: w.id, phone: req.body?.phone, operator: req.body?.operator,
    amount, fee, currency, merchantId: req.merchant.id, description: `Versement ${req.merchant.name}`,
    metadata: st.has_split ? { purpose, ...(req.body?.note ? { reason: String(req.body.note).slice(0, 140) } : {}) } : undefined,
    guard: async () => {
      const locked = await lockWallet(w.id);
      if (locked.balance < amount + fee) throw insufficient();
      await assertWithdrawal(req.merchant.id, currency, amount + fee, purpose, Number(locked.balance));
    },
  });
  res.status(202).json({ id: t.id, object: 'payout', status: t.status, amount: t.amount, fee: t.fee, currency: t.currency, phone: t.phone, operator: t.operator, created_at: t.created_at });
});

merchantApiRouter.get('/events', async (req, res) => {
  res.json({ object: 'list', data: await listEvents(req.merchant.id, Math.min(Number(req.query.limit) || 20, 100)) });
});
