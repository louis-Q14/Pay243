import express, { Router } from 'express';
import { assertNewPassword, assertNewPin, hashSecret, requireUser, signToken, verifyPin, verifySecret } from '../auth.js';
import { isUniqueViolation, q, tx } from '../db.js';
import { serializeTxn } from '../ledger.js';
import { rateLimit } from '../middleware.js';
import { issueOtp, normalizeDeviceId, verifyOtp } from '../otp.js';
import { createMerchantAccount } from '../services/merchants.js';
import { mergePrefs, notifyUser } from '../services/notify.js';
import { HttpError, newId, normalizeEmail, normalizePhone, now } from '../util.js';
import { serializeUser } from './auth.js';

// =====================================================================
//  Paramètres du compte : profil, coordonnées, adresses, sécurité,
//  notifications, données personnelles, relevés, fermeture du compte.
//  Toutes les routes sont sous /v1/me/… et exigent une session.
// =====================================================================
export const settingsRouter = Router();
settingsRouter.use('/me', requireUser);
const sensitive = rateLimit({ name: 'settings_sensitive', max: 20 });
const otpLimiter = rateLimit({ name: 'settings_otp', max: 10 });

const reload = (id) => q.get('SELECT * FROM users WHERE id=?', id);
const checkPassword = async (user, password) => {
  if (!(await verifySecret(password || '', user.password_hash))) throw new HttpError(401, 'invalid_password', 'Mot de passe incorrect.');
};

const RESERVED_HANDLES = new Set(['admin', 'support', 'pay243', 'pay', 'kongo', 'kongowallet', 'aide', 'help', 'api', 'app', 'checkout', 'settings', 'parametres', 'signup', 'login', 'securite', 'security']);
export function normalizeHandle(input) {
  const h = String(input || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9._]{2,29}$/.test(h) || /[._]{2}/.test(h) || /[._]$/.test(h)) {
    throw new HttpError(400, 'invalid_handle', 'Identifiant : 3 à 30 caractères, lettres minuscules, chiffres, « . » ou « _ », en commençant par une lettre.');
  }
  if (RESERVED_HANDLES.has(h)) throw new HttpError(409, 'handle_taken', 'Cet identifiant est réservé.');
  return h;
}

const TIMEZONES = new Set([...(Intl.supportedValuesOf?.('timeZone') || []), 'UTC']);
const serializeAddress = (a) => ({
  id: a.id, object: 'address', line1: a.line1, line2: a.line2, city: a.city, province: a.province,
  postal_code: a.postal_code, country: a.country, is_primary: !!a.is_primary, created_at: a.created_at,
});
const listAddresses = async (userId) =>
  (await q.all('SELECT * FROM addresses WHERE user_id=? ORDER BY is_primary DESC, created_at ASC', userId)).map(serializeAddress);

async function listDevices(userId, currentDeviceId) {
  let current = null;
  try { current = normalizeDeviceId(currentDeviceId); } catch { /* en-tête invalide : aucun appareil marqué */ }
  const rows = await q.all('SELECT device_hash, label, created_at, last_seen_at FROM trusted_devices WHERE user_id=? ORDER BY last_seen_at DESC', userId);
  return rows.map((d) => ({ id: d.device_hash, label: d.label, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.device_hash === current }));
}

// ---------- Vue d'ensemble (une seule requête pour la page /settings) ----------
settingsRouter.get('/me/settings', async (req, res) => {
  const u = req.user;
  const merchant = await q.get('SELECT id, name, created_at FROM merchants WHERE owner_user_id=?', u.id);
  const kyc = await q.get('SELECT status, document_type, created_at, review_note FROM kyc_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 1', u.id);
  res.json({
    user: serializeUser(u),
    addresses: await listAddresses(u.id),
    devices: await listDevices(u.id, req.get('X-Device-Id')),
    merchant: merchant || null,
    kyc: { level: u.kyc_level, last_status: kyc?.status || null, review_note: kyc?.status === 'rejected' ? kyc.review_note : null },
    locked_fields: u.kyc_level >= 2 ? ['full_name', 'nationality'] : [],
  });
});

// ---------- Profil ----------
settingsRouter.patch('/me', async (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const set = {};
  const locked = u.kyc_level >= 2;
  if (b.full_name !== undefined) {
    const name = String(b.full_name).trim().replace(/\s+/g, ' ');
    if (name.length < 3 || name.length > 80) throw new HttpError(400, 'invalid_name', 'Nom complet : 3 à 80 caractères.');
    if (locked && name !== u.full_name) throw new HttpError(409, 'name_locked', "Votre nom a été vérifié avec votre pièce d'identité. Pour le modifier, contactez le support avec un justificatif.");
    set.full_name = name;
  }
  if (b.handle !== undefined) set.handle = b.handle === null || b.handle === '' ? null : normalizeHandle(b.handle);
  if (b.timezone !== undefined) {
    if (!TIMEZONES.has(String(b.timezone))) throw new HttpError(400, 'invalid_timezone', 'Fuseau horaire inconnu.');
    set.timezone = String(b.timezone);
  }
  if (b.nationality !== undefined) {
    const n = String(b.nationality).toUpperCase();
    if (!/^[A-Z]{2}$/.test(n)) throw new HttpError(400, 'invalid_nationality', 'Nationalité : code pays à 2 lettres (ex : CD).');
    if (locked && n !== u.nationality) throw new HttpError(409, 'nationality_locked', "Votre nationalité a été vérifiée avec votre pièce d'identité. Contactez le support pour la modifier.");
    set.nationality = n;
  }
  const keys = Object.keys(set);
  if (!keys.length) throw new HttpError(400, 'nothing_to_update', 'Aucune modification.');
  try {
    await q.run(`UPDATE users SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => set[k]), u.id);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'handle_taken', 'Cet identifiant est déjà pris.');
    throw e;
  }
  res.json({ user: serializeUser(await reload(u.id)) });
});

// Photo de profil : image brute (JPEG/PNG/WebP, 300 Ko max), redimensionnée côté navigateur.
const IMAGE_MAGIC = { 'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'image/png': (b) => b.subarray(0, 4).toString('hex') === '89504e47', 'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };
settingsRouter.put('/me/avatar', express.raw({ type: Object.keys(IMAGE_MAGIC), limit: '300kb' }), async (req, res) => {
  const mime = String(req.get('Content-Type') || '').split(';')[0].trim();
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length || !IMAGE_MAGIC[mime]?.(buf)) throw new HttpError(400, 'invalid_image', 'Image JPEG, PNG ou WebP requise.');
  await q.run('UPDATE users SET avatar=? WHERE id=?', `data:${mime};base64,${buf.toString('base64')}`, req.user.id);
  res.json({ user: serializeUser(await reload(req.user.id)) });
});
settingsRouter.delete('/me/avatar', async (req, res) => {
  await q.run('UPDATE users SET avatar=NULL WHERE id=?', req.user.id);
  res.json({ user: serializeUser(await reload(req.user.id)) });
});

// ---------- Adresse email (changement vérifié par code envoyé à la nouvelle adresse) ----------
settingsRouter.post('/me/email/otp', otpLimiter, async (req, res) => {
  const e = normalizeEmail(req.body?.email);
  if (e === req.user.email) throw new HttpError(400, 'same_email', "C'est déjà votre adresse email.");
  if (await q.get('SELECT id FROM users WHERE email=?', e)) throw new HttpError(409, 'email_taken', 'Cette adresse est déjà utilisée par un autre compte.');
  res.status(201).json({ sent: true, email: e, ...(await issueOtp(e, 'email_change')) });
});

settingsRouter.post('/me/email', sensitive, async (req, res) => {
  const u = req.user;
  const e = normalizeEmail(req.body?.email);
  await checkPassword(u, req.body?.password);
  await verifyOtp(e, 'email_change', req.body?.otp_code);
  try {
    await q.run('UPDATE users SET email=?, email_verified_at=? WHERE id=?', e, now(), u.id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'email_taken', 'Cette adresse est déjà utilisée par un autre compte.');
    throw err;
  }
  // L'ancienne adresse est prévenue : c'est elle qui permet de repérer un détournement du compte.
  if (u.email) notifyUser(u, 'security', 'Votre adresse email Pay243 a changé', `L'adresse email de votre compte est désormais ${e}. Si vous n'êtes pas à l'origine de ce changement, contactez immédiatement le support.`, { to: u.email });
  res.json({ user: serializeUser(await reload(u.id)) });
});

// ---------- Numéro de téléphone (Mobile Money), vérifié par SMS ----------
settingsRouter.post('/me/phone/otp', otpLimiter, async (req, res) => {
  const p = normalizePhone(req.body?.phone);
  if (p === req.user.phone && req.user.phone_verified_at) throw new HttpError(400, 'same_phone', 'Ce numéro est déjà vérifié sur votre compte.');
  const owner = await q.get('SELECT id FROM users WHERE phone=?', p);
  if (owner && owner.id !== req.user.id) throw new HttpError(409, 'phone_taken', 'Ce numéro est déjà associé à un autre compte.');
  res.status(201).json({ sent: true, phone: p, ...(await issueOtp(p, 'phone_change')) });
});

settingsRouter.post('/me/phone', sensitive, async (req, res) => {
  const u = req.user;
  const p = normalizePhone(req.body?.phone);
  await verifyOtp(p, 'phone_change', req.body?.otp_code);
  try {
    await q.run('UPDATE users SET phone=?, phone_verified_at=? WHERE id=?', p, now(), u.id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'phone_taken', 'Ce numéro est déjà associé à un autre compte.');
    throw err;
  }
  if (u.phone !== p) notifyUser(u, 'security', 'Numéro de téléphone modifié', `Le numéro Mobile Money de votre compte est désormais ${p}. Si ce n'est pas vous, contactez le support.`);
  res.json({ user: serializeUser(await reload(u.id)) });
});

settingsRouter.delete('/me/phone', sensitive, async (req, res) => {
  const u = req.user;
  if (!u.email) throw new HttpError(400, 'phone_required', "Ajoutez d'abord une adresse email : c'est votre seul identifiant de connexion.");
  await checkPassword(u, req.body?.password);
  await q.run('UPDATE users SET phone=NULL, phone_verified_at=NULL WHERE id=?', u.id);
  res.json({ user: serializeUser(await reload(u.id)) });
});

// ---------- Adresses postales ----------
const MAX_ADDRESSES = 5;
function addressFields(b, partial = false) {
  const out = {};
  const text = (k, min, max, required) => {
    if (b[k] === undefined) { if (required && !partial) throw new HttpError(400, `invalid_${k}`, `Champ « ${k} » requis.`); return; }
    const v = b[k] === null ? '' : String(b[k]).trim();
    if (!v && !required) { out[k] = null; return; }
    if (v.length < min || v.length > max) throw new HttpError(400, `invalid_${k}`, `Champ « ${k} » : ${min} à ${max} caractères.`);
    out[k] = v;
  };
  text('line1', 3, 120, true);
  text('line2', 1, 120, false);
  text('city', 2, 60, true);
  text('province', 2, 60, false);
  text('postal_code', 2, 12, false);
  if (b.country !== undefined) {
    const c = String(b.country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) throw new HttpError(400, 'invalid_country', 'Pays : code à 2 lettres (ex : CD).');
    out.country = c;
  }
  return out;
}
const ownAddress = async (req) => {
  const a = await q.get('SELECT * FROM addresses WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!a) throw new HttpError(404, 'address_not_found', 'Adresse introuvable.');
  return a;
};

settingsRouter.get('/me/addresses', async (req, res) => res.json({ data: await listAddresses(req.user.id) }));

settingsRouter.post('/me/addresses', async (req, res) => {
  const f = addressFields(req.body || {});
  const id = newId('adr');
  await tx(async () => {
    await q.get('SELECT id FROM users WHERE id=? FOR UPDATE', req.user.id); // sérialise les ajouts concurrents
    const { n } = await q.get('SELECT COUNT(*)::int AS n FROM addresses WHERE user_id=?', req.user.id);
    if (n >= MAX_ADDRESSES) throw new HttpError(400, 'too_many_addresses', `${MAX_ADDRESSES} adresses maximum.`);
    const primary = n === 0 || req.body?.is_primary === true;
    if (primary) await q.run('UPDATE addresses SET is_primary=FALSE WHERE user_id=?', req.user.id);
    await q.run('INSERT INTO addresses (id, user_id, line1, line2, city, province, postal_code, country, is_primary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, req.user.id, f.line1, f.line2 ?? null, f.city, f.province ?? null, f.postal_code ?? null, f.country || 'CD', primary, now());
  });
  res.status(201).json(serializeAddress(await q.get('SELECT * FROM addresses WHERE id=?', id)));
});

settingsRouter.patch('/me/addresses/:id', async (req, res) => {
  const a = await ownAddress(req);
  const f = addressFields(req.body || {}, true);
  const keys = Object.keys(f);
  if (keys.length) await q.run(`UPDATE addresses SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => f[k]), a.id);
  if (req.body?.is_primary === true && !a.is_primary) {
    await tx(async () => {
      await q.run('UPDATE addresses SET is_primary=FALSE WHERE user_id=?', req.user.id);
      await q.run('UPDATE addresses SET is_primary=TRUE WHERE id=?', a.id);
    });
  }
  res.json(serializeAddress(await q.get('SELECT * FROM addresses WHERE id=?', a.id)));
});

settingsRouter.delete('/me/addresses/:id', async (req, res) => {
  const a = await ownAddress(req);
  await tx(async () => {
    await q.run('DELETE FROM addresses WHERE id=?', a.id);
    if (a.is_primary) {
      // L'adresse la plus ancienne restante devient principale.
      const next = await q.get('SELECT id FROM addresses WHERE user_id=? ORDER BY created_at ASC LIMIT 1', req.user.id);
      if (next) await q.run('UPDATE addresses SET is_primary=TRUE WHERE id=?', next.id);
    }
  });
  res.json({ id: a.id, deleted: true });
});

// ---------- Sécurité ----------
/** Change le mot de passe et déconnecte toutes les autres sessions ; renvoie un nouveau jeton pour celle-ci. */
settingsRouter.post('/me/password', sensitive, async (req, res) => {
  const u = req.user;
  const { current_password, new_password } = req.body || {};
  await checkPassword(u, current_password);
  assertNewPassword(new_password);
  if (current_password === new_password) throw new HttpError(400, 'same_password', "Le nouveau mot de passe doit être différent de l'actuel.");
  await q.run('UPDATE users SET password_hash=?, sessions_valid_after=? WHERE id=?', await hashSecret(new_password), Date.now(), u.id);
  notifyUser(u, 'security', 'Mot de passe modifié', "Le mot de passe de votre compte Pay243 vient d'être modifié. Toutes vos autres sessions ont été déconnectées. Si ce n'est pas vous, contactez immédiatement le support.");
  res.json({ token: signToken({ sub: u.id }), user: serializeUser(await reload(u.id)) });
});

settingsRouter.post('/me/pin', sensitive, async (req, res) => {
  const u = req.user;
  const { current_pin, new_pin } = req.body || {};
  await verifyPin(u, current_pin); // compte les erreurs : même blocage qu'à un paiement
  assertNewPin(new_pin);
  await q.run('UPDATE users SET pin_hash=? WHERE id=?', await hashSecret(new_pin), u.id);
  notifyUser(u, 'security', 'PIN de transaction modifié', "Le PIN de transaction de votre compte Pay243 vient d'être modifié. Si ce n'est pas vous, contactez immédiatement le support.");
  res.json({ updated: true });
});

settingsRouter.get('/me/devices', async (req, res) => res.json({ data: await listDevices(req.user.id, req.get('X-Device-Id')) }));

/** Retire un appareil de confiance : la prochaine connexion depuis celui-ci demandera un code. */
settingsRouter.delete('/me/devices/:id', async (req, res) => {
  const r = await q.run('DELETE FROM trusted_devices WHERE user_id=? AND device_hash=?', req.user.id, req.params.id);
  if (!r.changes) throw new HttpError(404, 'device_not_found', 'Appareil introuvable.');
  res.json({ id: req.params.id, deleted: true });
});

/** Déconnecte toutes les sessions et oublie les autres appareils ; la session courante reçoit un nouveau jeton. */
settingsRouter.post('/me/sessions/revoke', sensitive, async (req, res) => {
  const u = req.user;
  let keep = null;
  try { keep = normalizeDeviceId(req.get('X-Device-Id')); } catch { /* aucun appareil conservé */ }
  await tx(async () => {
    await q.run('UPDATE users SET sessions_valid_after=? WHERE id=?', Date.now(), u.id);
    await q.run('DELETE FROM trusted_devices WHERE user_id=? AND device_hash IS DISTINCT FROM ?', u.id, keep);
  });
  notifyUser(u, 'security', 'Déconnexion de tous vos appareils', 'Toutes les sessions de votre compte Pay243 ont été fermées, sauf celle utilisée pour cette demande.');
  res.json({ token: signToken({ sub: u.id }) });
});

// ---------- Notifications ----------
settingsRouter.put('/me/notifications', async (req, res) => {
  const prefs = mergePrefs(req.user, req.body || {});
  await q.run('UPDATE users SET notification_prefs=? WHERE id=?', JSON.stringify(prefs), req.user.id);
  res.json({ user: serializeUser(await reload(req.user.id)) });
});

// ---------- Passage en compte entreprise ----------
settingsRouter.post('/me/business', sensitive, async (req, res) => {
  const u = req.user;
  const name = String(req.body?.business_name || '').trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'invalid_business_name', "Nom de l'entreprise requis (2 à 80 caractères).");
  const merchant = await tx(async () => {
    const existing = await q.get('SELECT id, name FROM merchants WHERE owner_user_id=?', u.id);
    await q.run("UPDATE users SET account_type='business' WHERE id=?", u.id);
    if (existing) return { id: existing.id, name: existing.name, secretKey: null };
    return { ...(await createMerchantAccount(u.id, name)), name };
  });
  res.json({
    user: serializeUser(await reload(u.id)),
    merchant: { id: merchant.id, name: merchant.name, ...(merchant.secretKey ? { secret_key: merchant.secretKey, notice: 'Conservez cette clé secrète : elle ne sera plus affichée.' } : {}) },
  });
});

// ---------- Données personnelles et relevés ----------
const userWalletIds = async (userId) => (await q.all("SELECT id FROM wallets WHERE owner_type='user' AND owner_id=?", userId)).map((w) => w.id);
async function userTransactions(userId, { from, to } = {}) {
  const ids = await userWalletIds(userId);
  const marks = ids.map(() => '?').join(',');
  const range = from ? ' AND created_at >= ? AND created_at < ?' : '';
  const rows = await q.all(
    `SELECT * FROM transactions WHERE (from_wallet IN (${marks}) OR to_wallet IN (${marks}))${range} ORDER BY created_at ASC`,
    ...ids, ...ids, ...(from ? [from, to] : []),
  );
  return rows.map((t) => serializeTxn(t, ids));
}

/** Export de toutes les données personnelles (droit d'accès et de portabilité). */
settingsRouter.get('/me/export', sensitive, async (req, res) => {
  const u = req.user;
  const body = {
    exported_at: now(),
    profile: serializeUser(u),
    addresses: await listAddresses(u.id),
    trusted_devices: await listDevices(u.id),
    cards: (await q.all('SELECT brand, last4, exp_month, exp_year, created_at FROM cards WHERE user_id=?', u.id)),
    kyc_submissions: (await q.all('SELECT id, status, document_type, created_at, reviewed_at, review_note FROM kyc_submissions WHERE user_id=? ORDER BY created_at', u.id)),
    merchant: await q.get('SELECT id, name, webhook_url, created_at FROM merchants WHERE owner_user_id=?', u.id) || null,
    transactions: await userTransactions(u.id),
  };
  res.set('Content-Disposition', `attachment; filename="pay243-donnees-${u.id}.json"`);
  res.json(body);
});

/** Mois disponibles pour les relevés. */
settingsRouter.get('/me/statements', async (req, res) => {
  const ids = await userWalletIds(req.user.id);
  const marks = ids.map(() => '?').join(',');
  const rows = await q.all(
    `SELECT substr(created_at, 1, 7) AS month, COUNT(*)::int AS count FROM transactions
     WHERE from_wallet IN (${marks}) OR to_wallet IN (${marks}) GROUP BY 1 ORDER BY 1 DESC`, ...ids, ...ids,
  );
  res.json({ data: rows });
});

/** Relevé mensuel au format CSV (séparateur « ; », lisible par Excel en français). Dates dans le fuseau du compte. */
settingsRouter.get('/me/statements/:month', async (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(req.params.month);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new HttpError(400, 'invalid_month', 'Mois au format AAAA-MM.');
  const from = new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toISOString();
  const to = new Date(Date.UTC(+m[1], +m[2], 1)).toISOString();
  const txns = await userTransactions(req.user.id, { from, to });
  const tz = req.user.timezone || 'Africa/Kinshasa';
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  // Texte libre (description, contrepartie) : neutralise l'injection de formules dans Excel. Les montants restent numériques.
  const cell = (v, text = true) => {
    const s = v == null ? '' : String(v);
    const safe = text && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[;"\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const amount = (minor, dir) => `${dir === 'debit' ? '-' : ''}${(minor / 100).toFixed(2).replace('.', ',')}`;
  const lines = [['Date', 'Référence', 'Type', 'Description', 'Contrepartie', 'Statut', 'Devise', 'Montant', 'Frais'].join(';')];
  for (const t of txns) {
    const texts = [date.format(new Date(t.created_at)), t.id, t.type, t.description, t.counterparty, t.status, t.currency].map((v) => cell(v));
    const nums = [amount(t.amount, t.direction), t.fee ? amount(t.fee, 'debit') : ''].map((v) => cell(v, false));
    lines.push([...texts, ...nums].join(';'));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="releve-pay243-${req.params.month}.csv"` });
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

// ---------- Fermeture du compte ----------
settingsRouter.post('/me/close', sensitive, async (req, res) => {
  const u = req.user;
  await checkPassword(u, req.body?.password);
  if (req.body?.confirm !== 'FERMER') throw new HttpError(400, 'confirmation_required', 'Tapez FERMER pour confirmer.');
  await tx(async () => {
    await q.get('SELECT id FROM users WHERE id=? FOR UPDATE', u.id);
    const merchant = await q.get('SELECT id FROM merchants WHERE owner_user_id=?', u.id);
    const owners = [['user', u.id], ...(merchant ? [['merchant', merchant.id]] : [])];
    for (const [type, id] of owners) {
      const w = await q.all('SELECT currency, balance FROM wallets WHERE owner_type=? AND owner_id=? AND balance <> 0', type, id);
      if (w.length) {
        throw new HttpError(409, 'balance_not_zero', `Videz d'abord ${type === 'user' ? 'votre wallet' : 'votre compte marchand'} (${w.map((x) => `${(x.balance / 100).toFixed(2)} ${x.currency}`).join(', ')}) : retirez ou envoyez ce solde avant de fermer le compte.`);
      }
    }
    const ids = await userWalletIds(u.id);
    const marks = ids.map(() => '?').join(',');
    const pending = await q.get(`SELECT COUNT(*)::int AS n FROM transactions WHERE status='pending' AND (from_wallet IN (${marks}) OR to_wallet IN (${marks}))`, ...ids, ...ids);
    if (pending.n) throw new HttpError(409, 'pending_transactions', 'Des opérations sont encore en cours. Attendez leur dénouement avant de fermer le compte.');
    await q.run("UPDATE users SET status='closed', closed_at=?, sessions_valid_after=? WHERE id=?", now(), Date.now(), u.id);
    await q.run('DELETE FROM trusted_devices WHERE user_id=?', u.id);
    await q.run('DELETE FROM cards WHERE user_id=?', u.id);
    if (merchant) await q.run('UPDATE api_keys SET revoked_at=? WHERE merchant_id=? AND revoked_at IS NULL', now(), merchant.id);
  });
  notifyUser(u, 'security', 'Votre compte Pay243 est fermé', `Votre compte a été fermé le ${new Date().toLocaleString('fr-FR')}${req.body?.reason ? ` (motif : ${String(req.body.reason).slice(0, 200)})` : ''}. Vos relevés restent conservés conformément à la réglementation.`);
  res.json({ closed: true });
});

