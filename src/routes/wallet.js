import { Router } from 'express';
import { requireActivated, requireUser, verifyPin } from '../auth.js';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { createTxn, getTxn, getWallet, lockWallet, move, serializeTxn, systemWallet, updateTxn } from '../ledger.js';
import { checkIncoming, checkOutgoing, lockUsers } from '../limits.js';
import { idempotent, rateLimit } from '../middleware.js';
import { cardProcessor } from '../providers/cards/index.js';
import { listOperators } from '../providers/mobileMoney/index.js';
import { refreshPending, startCollection, startPayout } from '../services/mobileMoney.js';
import { appUrl, notifyUser } from '../services/notify.js';
import { HttpError, assertAmount, assertCurrency, formatMoney, isEmail, newId, normalizeEmail, normalizePhone, now, percentFee } from '../util.js';

export const walletRouter = Router();
walletRouter.use(['/wallets', '/transactions', '/topups', '/transfers', '/withdrawals', '/conversions', '/cards'], requireUser);
// Aucune opération d'argent avant l'activation du compte (identité validée par l'équipe).
walletRouter.use(['/topups', '/transfers', '/withdrawals', '/conversions'], requireActivated);
// Débit maximal par utilisateur : freine l'automatisation (demandes USSD en rafale vers des numéros tiers, essais de PIN).
walletRouter.use(['/topups', '/transfers', '/withdrawals', '/conversions'], rateLimit({
  name: 'money', max: config.rateLimits.money, keyOf: (req) => req.user.id,
  message: 'Trop d’opérations en peu de temps. Patientez une minute.',
}));
const idem = idempotent((req) => `user:${req.user.id}`);

const userWalletIds = async (userId) => (await q.all("SELECT id FROM wallets WHERE owner_type='user' AND owner_id=?", userId)).map((w) => w.id);

/** Numéro Mobile Money de l'opération : celui saisi, sinon celui du profil (facultatif depuis l'inscription par email). */
function mobileNumber(phone, user) {
  const n = phone || user.phone;
  if (!n) throw new HttpError(400, 'missing_phone', 'Indiquez votre numéro Mobile Money (M-Pesa, Airtel ou Orange).');
  return n;
}

walletRouter.get('/operators', (_req, res) => res.json({ data: listOperators().map(({ id, label }) => ({ id, label })) }));

walletRouter.get('/wallets', async (req, res) => {
  const data = [];
  for (const c of config.currencies) {
    const w = await getWallet('user', req.user.id, c);
    data.push({ id: w.id, object: 'wallet', currency: c, balance: w.balance });
  }
  res.json({ data, fx: { usd_to_cdf: config.fx.usdToCdf, spread_percent: config.fx.spreadPercent } });
});

walletRouter.get('/transactions', async (req, res) => {
  const ids = await userWalletIds(req.user.id);
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const marks = ids.map(() => '?').join(',');
  const rows = await q.all(
    `SELECT * FROM transactions WHERE from_wallet IN (${marks}) OR to_wallet IN (${marks}) ORDER BY created_at DESC LIMIT ?`,
    ...ids, ...ids, limit,
  );
  res.json({ data: rows.map((t) => serializeTxn(t, ids)) });
});

walletRouter.get('/transactions/:id', async (req, res) => {
  const ids = await userWalletIds(req.user.id);
  let t = await getTxn(req.params.id);
  if (!t || (!ids.includes(t.from_wallet) && !ids.includes(t.to_wallet))) throw new HttpError(404, 'not_found', 'Transaction introuvable.');
  t = await refreshPending(t);
  res.json(serializeTxn(t, ids));
});

// ---------- Recharge : Mobile Money (M-Pesa / Airtel / Orange) ou carte enregistrée ----------
walletRouter.post('/topups', idem, async (req, res) => {
  const { method = 'mobile_money', phone, operator, card_id } = req.body || {};
  const amount = assertAmount(req.body?.amount);
  const currency = assertCurrency(req.body?.currency);
  await checkIncoming(req.user, currency, amount);
  const wallet = await getWallet('user', req.user.id, currency);

  if (method === 'mobile_money') {
    const txn = await startCollection({
      type: 'topup', phone: mobileNumber(phone, req.user), operator, amount, currency, toWalletId: wallet.id,
      description: 'Recharge wallet Pay243',
    });
    return res.status(202).json({
      ...serializeTxn(txn, [wallet.id]),
      next_action: { type: 'confirm_on_phone', message: `Validez la demande ${config.providers[txn.operator].label} sur le ${txn.phone} avec votre PIN opérateur.` },
    });
  }

  if (method === 'card') {
    const card = await q.get('SELECT * FROM cards WHERE id=? AND user_id=?', card_id, req.user.id);
    if (!card) throw new HttpError(404, 'card_not_found', 'Carte introuvable.');
    const floatCard = await systemWallet('float_card', currency);
    const txn = await createTxn({ type: 'topup', status: 'pending', amount, currency, method: 'card', from_wallet: floatCard.id, to_wallet: wallet.id, provider: cardProcessor().name, description: `Recharge par carte •••• ${card.last4}` });
    const r = await cardProcessor().charge({ token: card.provider_token, amount, currency, txnId: txn.id, description: 'Recharge Pay243' });
    if (r.status !== 'succeeded') {
      await updateTxn(txn.id, { status: 'failed', failure_reason: r.reason });
      throw new HttpError(402, 'card_declined', r.reason || 'Carte refusée.');
    }
    await tx(async () => {
      await move(txn.id, floatCard.id, wallet.id, amount);
      await updateTxn(txn.id, { status: 'succeeded', provider_ref: r.providerRef });
    });
    return res.status(201).json(serializeTxn(await getTxn(txn.id), [wallet.id]));
  }

  throw new HttpError(400, 'invalid_method', 'method doit être "mobile_money" ou "card".');
});

// ---------- Transfert P2P entre wallets Pay243 ----------
walletRouter.post('/transfers', idem, async (req, res) => {
  const { pin, note } = req.body || {};
  const amount = assertAmount(req.body?.amount);
  const currency = assertCurrency(req.body?.currency);
  // Destinataire : @identifiant, adresse email ou numéro de téléphone (champ `to`, ou to_email / to_phone).
  const recipient = req.body?.to ?? req.body?.to_email ?? req.body?.to_phone;
  if (!recipient) throw new HttpError(400, 'missing_recipient', 'Indiquez l\'email ou le numéro du destinataire.');
  const byHandle = /^@/.test(String(recipient).trim());
  const target = byHandle
    ? await q.get("SELECT * FROM users WHERE handle=? AND status='active'", String(recipient).trim().slice(1).toLowerCase())
    : isEmail(recipient)
      ? await q.get("SELECT * FROM users WHERE email=? AND status='active'", normalizeEmail(recipient))
      : await q.get("SELECT * FROM users WHERE phone=? AND status='active'", normalizePhone(recipient));
  if (!target) {
    throw new HttpError(404, 'recipient_not_found', byHandle
      ? "Aucun compte Pay243 n'utilise cet identifiant."
      : isEmail(recipient)
        ? "Aucun compte Pay243 n'utilise cette adresse email."
        : "Ce numéro n'a pas de compte Pay243. Utilisez un retrait Mobile Money pour lui envoyer de l'argent.");
  }
  if (target.id === req.user.id) throw new HttpError(400, 'self_transfer', 'Impossible de vous envoyer de l\'argent à vous-même.');
  if (!target.activated_at) throw new HttpError(403, 'recipient_not_verified', "Ce destinataire n'a pas encore activé son compte Pay243 : il doit d'abord faire vérifier son identité.");
  await verifyPin(req.user, pin);
  const from = await getWallet('user', req.user.id, currency);
  const to = await getWallet('user', target.id, currency);
  const txn = await tx(async () => {
    // Plafonds contrôlés sous verrou : deux transferts simultanés ne peuvent pas les contourner.
    await lockUsers(req.user.id, target.id);
    await checkOutgoing(req.user, currency, amount);
    await checkIncoming(target, currency, amount);
    const t = await createTxn({
      type: 'transfer', status: 'succeeded', amount, currency, method: 'wallet', from_wallet: from.id, to_wallet: to.id,
      description: note ? String(note).slice(0, 140) : 'Transfert Pay243',
      metadata: { counterparty: `${req.user.full_name} → ${target.full_name}`, from: req.user.email || req.user.phone, to: target.email || target.phone },
    });
    await move(t.id, from.id, to.id, amount);
    return t;
  });
  notifyUser(target, 'payments', `Vous avez reçu ${formatMoney(amount, currency)}`,
    `${req.user.full_name} vous a envoyé ${formatMoney(amount, currency)} sur Pay243${note ? ` : « ${String(note).slice(0, 140)} »` : ''}. Référence ${txn.id}.`, {
      title: `Vous avez reçu ${formatMoney(amount, currency)}`,
      paragraphs: [`${req.user.full_name} vous a envoyé de l'argent sur Pay243. Il est déjà disponible dans votre wallet.`],
      details: [['Montant', formatMoney(amount, currency)], ['De', req.user.full_name], ...(note ? [['Motif', String(note).slice(0, 140)]] : []), ['Référence', txn.id]],
      cta: { label: 'Voir mon wallet', url: appUrl('/app') },
    });
  res.status(201).json(serializeTxn(await getTxn(txn.id), [from.id]));
});

// ---------- Retrait vers Mobile Money ----------
walletRouter.post('/withdrawals', idem, async (req, res) => {
  const { phone, operator, pin } = req.body || {};
  const amount = assertAmount(req.body?.amount);
  const currency = assertCurrency(req.body?.currency);
  await verifyPin(req.user, pin);
  const fee = percentFee(amount, config.fees.withdrawalPercent);
  const wallet = await getWallet('user', req.user.id, currency);
  const txn = await startPayout({
    type: 'withdrawal', fromWalletId: wallet.id, phone: mobileNumber(phone, req.user), operator,
    amount, fee, currency, description: 'Retrait Pay243',
    guard: async () => {
      await lockUsers(req.user.id);
      await checkOutgoing(req.user, currency, amount);
      const w = await lockWallet(wallet.id);
      if (w.balance < amount + fee) {
        throw new HttpError(402, 'insufficient_funds', `Solde insuffisant : ${amount + fee} requis (dont ${fee} de frais).`);
      }
    },
  });
  res.status(202).json(serializeTxn(txn, [wallet.id]));
});

// ---------- Conversion CDF <-> USD ----------
walletRouter.post('/conversions', idem, async (req, res) => {
  const { pin } = req.body || {};
  const from = assertCurrency(req.body?.from_currency);
  const to = assertCurrency(req.body?.to_currency);
  if (from === to) throw new HttpError(400, 'same_currency', 'Choisissez deux devises différentes.');
  const amount = assertAmount(req.body?.amount);
  await verifyPin(req.user, pin);
  const rate = config.fx.usdToCdf;
  const spread = 1 - config.fx.spreadPercent / 100;
  const converted = Math.floor((from === 'USD' ? amount * rate : amount / rate) * spread);
  if (converted <= 0) throw new HttpError(400, 'amount_too_small', 'Montant trop faible pour être converti.');
  const src = await getWallet('user', req.user.id, from);
  const dst = await getWallet('user', req.user.id, to);
  const poolFrom = await systemWallet('fx_pool', from);
  const poolTo = await systemWallet('fx_pool', to);
  const txn = await tx(async () => {
    const t = await createTxn({
      type: 'conversion', status: 'succeeded', amount, currency: from, method: 'wallet', from_wallet: src.id, to_wallet: dst.id,
      description: `Conversion ${from} → ${to}`, metadata: { to_currency: to, to_amount: converted, rate, spread_percent: config.fx.spreadPercent },
    });
    await move(t.id, src.id, poolFrom.id, amount);
    await move(t.id, poolTo.id, dst.id, converted);
    return t;
  });
  res.status(201).json(serializeTxn(await getTxn(txn.id), [src.id]));
});

// ---------- Cartes enregistrées (jetons uniquement) ----------
const serializeCard = (c) => ({ id: c.id, object: 'card', brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year, created_at: c.created_at });

walletRouter.get('/cards', async (req, res) => {
  res.json({ data: (await q.all('SELECT * FROM cards WHERE user_id=? ORDER BY created_at DESC', req.user.id)).map(serializeCard) });
});

walletRouter.post('/cards', requireActivated, async (req, res) => {
  const { token } = req.body || {};
  if (!token) throw new HttpError(400, 'missing_token', 'Jeton de carte requis (obtenu via le SDK du processeur).');
  if ((await q.get('SELECT COUNT(*) AS n FROM cards WHERE user_id=?', req.user.id)).n >= 5) throw new HttpError(400, 'too_many_cards', '5 cartes maximum.');
  const info = cardProcessor().retrieveToken(token);
  const id = newId('card');
  await q.run('INSERT INTO cards (id, user_id, provider, provider_token, brand, last4, exp_month, exp_year, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, req.user.id, cardProcessor().name, token, info.brand, info.last4, info.exp_month, info.exp_year, now());
  res.status(201).json(serializeCard(await q.get('SELECT * FROM cards WHERE id=?', id)));
});

walletRouter.delete('/cards/:id', async (req, res) => {
  const r = await q.run('DELETE FROM cards WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!r.changes) throw new HttpError(404, 'card_not_found', 'Carte introuvable.');
  res.json({ id: req.params.id, deleted: true });
});
