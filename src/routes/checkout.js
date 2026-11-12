import { Router } from 'express';
import { notVerifiedError, optionalUser, verificationStatus } from '../auth.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { getWallet } from '../ledger.js';
import { publicCors, rateLimit } from '../middleware.js';
import { cardProcessor } from '../providers/cards/index.js';
import { getProvider } from '../providers/mobileMoney/index.js';
import { handleProviderResult, refreshPending } from '../services/mobileMoney.js';
import { getPayment, payWithCard, payWithMobileMoney, payWithWallet, publicCheckoutView } from '../services/payments.js';
import { can, requireStaff } from '../staff.js';
import { HttpError, safeEqual } from '../util.js';

// =====================================================================
//  Checkout hébergé : endpoints publics utilisés par /checkout/:id
// =====================================================================
export const checkoutRouter = Router();
checkoutRouter.use('/checkout', publicCors);

checkoutRouter.get('/checkout/:id', optionalUser, async (req, res) => {
  const p = await getPayment(req.params.id);
  if (p?.status === 'processing') {
    const pending = await q.get("SELECT * FROM transactions WHERE payment_id=? AND status='pending' ORDER BY created_at DESC", p.id);
    if (pending) await refreshPending(pending);
  }
  const view = await publicCheckoutView(await getPayment(req.params.id));
  if (req.user) {
    view.customer = {
      full_name: req.user.full_name,
      balance: (await getWallet('user', req.user.id, view.currency)).balance,
      cards: await q.all('SELECT id, brand, last4 FROM cards WHERE user_id=?', req.user.id),
    };
  }
  res.json(view);
});

checkoutRouter.post('/checkout/:id/pay', rateLimit({ name: 'checkout_pay', max: 15 }), optionalUser, async (req, res) => {
  const { method, pin, phone, operator, card_id, token } = req.body || {};
  const id = req.params.id;
  if (req.user && !req.user.activated_at && (method === 'wallet' || req.body?.card_id)) throw notVerifiedError(await verificationStatus(req.user));
  if (method === 'wallet') {
    if (!req.user) throw new HttpError(401, 'unauthorized', 'Connectez-vous à Pay243 pour payer avec votre wallet.');
    await payWithWallet(id, req.user, pin);
  } else if (method === 'mobile_money') {
    await payWithMobileMoney(id, phone, operator, req.user || null);
  } else if (method === 'card') {
    await payWithCard(id, { user: req.user, cardId: card_id, token, pin });
  } else {
    throw new HttpError(400, 'invalid_method', 'method doit être "wallet", "mobile_money" ou "card".');
  }
  res.json(await publicCheckoutView(await getPayment(id)));
});

// =====================================================================
//  Callbacks des opérateurs Mobile Money (entrants)
//  URL à déclarer chez l'opérateur : {BASE_URL}/webhooks/mobile-money/{mpesa|airtel|orange}?token={CALLBACK_SECRET}
//  En plus du jeton, filtrez les IP sources des opérateurs au niveau du pare-feu / reverse proxy.
// =====================================================================
export const callbackRouter = Router();

callbackRouter.post('/webhooks/mobile-money/:operator', async (req, res) => {
  const token = req.get('X-Callback-Token') || req.query.token || '';
  if (!safeEqual(token, config.callbackSecret)) throw new HttpError(401, 'invalid_callback_token', 'Jeton de callback invalide.');
  const provider = getProvider(req.params.operator);
  const results = provider.parseCallback(req.body, req.query) || [];
  let processed = 0;
  for (const r of results) {
    let result = r;
    // Un callback annonçant un succès crédite de l'argent : on ne le croit pas sur parole. Le statut est
    // confirmé auprès de l'opérateur ; sans confirmation, l'opération reste en attente et le contrôle
    // périodique (puis le rapprochement) tranchera.
    if (r.status === 'succeeded' && provider.checkStatus) {
      const txn = r.txnId
        ? await q.get('SELECT * FROM transactions WHERE id=?', r.txnId)
        : await q.get('SELECT * FROM transactions WHERE provider_ref=?', r.providerRef);
      if (!txn || txn.status !== 'pending' || txn.operator !== req.params.operator) continue;
      const confirmed = await provider.checkStatus(txn).catch(() => null);
      if (!confirmed) continue;
      result = { ...r, txnId: txn.id, ...confirmed };
    }
    await handleProviderResult(result);
    processed += 1;
  }
  res.json({ received: true, processed });
});

// =====================================================================
//  Outils sandbox (désactivés en production)
// =====================================================================
export const sandboxRouter = Router();

sandboxRouter.use('/sandbox', (_req, _res, next) => {
  if (config.mode === 'live') throw new HttpError(404, 'not_found', 'Indisponible en production.');
  next();
});

/** Simule la tokenisation de carte normalement réalisée dans le navigateur par le SDK du processeur. */
sandboxRouter.post('/sandbox/cards/tokenize', publicCors, (req, res) => {
  res.json({ token: cardProcessor().tokenize(req.body || {}) });
});

/** Permet de tester les plafonds de niveaux KYC supérieurs. Réservé à l'équipe : cet outil active un compte. */
sandboxRouter.post('/sandbox/users/:phone/kyc', requireStaff, can('users.kyc_override'), async (req, res) => {
  const level = Number(req.body?.level);
  if (![1, 2, 3].includes(level)) throw new HttpError(400, 'invalid_level', 'level doit valoir 1, 2 ou 3.');
  const r = await q.run('UPDATE users SET kyc_level=?, activated_at = CASE WHEN ? >= 2 THEN COALESCE(activated_at, ?) ELSE activated_at END WHERE phone=?', level, level, new Date().toISOString(), `+243${String(req.params.phone).replace(/\D/g, '').slice(-9)}`);
  if (!r.changes) throw new HttpError(404, 'not_found', 'Utilisateur introuvable.');
  res.json({ ok: true, kyc_level: level });
});
