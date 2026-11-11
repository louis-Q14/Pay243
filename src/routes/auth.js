import { Router } from 'express';
import { assertNewPassword, assertNewPin, hashSecret, requireUser, signToken, verifySecret } from '../auth.js';
import { config } from '../config.js';
import { isUniqueViolation, q, tx } from '../db.js';
import { getWallet } from '../ledger.js';
import { describeLimits } from '../limits.js';
import { rateLimit } from '../middleware.js';
import { isTrustedDevice, issueOtp, normalizeDeviceId, trustDevice, verifyOtp } from '../otp.js';
import { createMerchantAccount } from '../services/merchants.js';
import { notificationPrefs } from '../services/notify.js';
import { HttpError, detectOperator, isEmail, newId, normalizeEmail, normalizePhone, now } from '../util.js';

export const authRouter = Router();
const limiter = rateLimit({ name: 'auth', max: config.rateLimits.auth });
const otpLimiter = rateLimit({ name: 'otp', max: config.rateLimits.otp });

// Empreinte factice : la vérification d'un compte inconnu prend autant de temps qu'un vrai mot de passe.
const DUMMY_HASH = await hashSecret('pay243-timing-equalizer');

export const ACCOUNT_TYPES = ['personal', 'business'];

export function serializeUser(u) {
  return {
    id: u.id,
    object: 'user',
    account_type: u.account_type,
    email: u.email,
    email_verified: !!u.email_verified_at,
    phone: u.phone,
    operator: u.phone ? detectOperator(u.phone) : null,
    full_name: u.full_name,
    phone_verified: !!u.phone_verified_at,
    handle: u.handle || null,
    avatar_url: u.avatar || null,
    timezone: u.timezone || 'Africa/Kinshasa',
    nationality: u.nationality || 'CD',
    notifications: notificationPrefs(u),
    kyc_level: u.kyc_level,
    created_at: u.created_at,
  };
}

const emailTaken = () => new HttpError(409, 'email_taken', 'Un compte existe déjà avec cette adresse email. Connectez-vous.');
const phoneTaken = () => new HttpError(409, 'phone_taken', 'Ce numéro est déjà associé à un autre compte.');

/** Masque une adresse ou un numéro dans les messages (gr•••@gmail.com, +243812•••78). */
function mask(dest) {
  if (isEmail(dest)) {
    const [local, domain] = dest.split('@');
    return `${local.slice(0, 2)}•••@${domain}`;
  }
  return `${dest.slice(0, 7)}•••${dest.slice(-2)}`;
}

/** Étape 1 de l'inscription : envoi d'un code de vérification à l'adresse email. */
authRouter.post('/auth/otp', otpLimiter, async (req, res) => {
  const { email, purpose = 'register' } = req.body || {};
  if (purpose !== 'register') throw new HttpError(400, 'invalid_purpose', 'Pour la connexion, le code est envoyé automatiquement par /v1/auth/login.');
  const e = normalizeEmail(email);
  if (await q.get('SELECT id FROM users WHERE email=?', e)) throw emailTaken();
  const r = await issueOtp(e, 'register');
  res.status(201).json({ sent: true, email: e, ...r });
});

/** Étape 2 : création du compte (particulier ou entreprise) avec le code reçu par email. */
authRouter.post('/auth/register', limiter, async (req, res) => {
  const { account_type, email, otp_code, full_name, password, pin, phone, business_name, device_id, device_label } = req.body || {};
  if (!ACCOUNT_TYPES.includes(account_type)) {
    throw new HttpError(400, 'invalid_account_type', 'Choisissez un type de compte : "personal" (particulier) ou "business" (entreprise).');
  }
  const e = normalizeEmail(email);
  const p = phone ? normalizePhone(phone) : null;
  if (!full_name || String(full_name).trim().length < 3) throw new HttpError(400, 'invalid_name', 'Nom complet requis (3 caractères min.).');
  if (account_type === 'business' && (!business_name || String(business_name).trim().length < 2)) {
    throw new HttpError(400, 'invalid_business_name', "Nom de l'entreprise requis.");
  }
  assertNewPassword(password);
  assertNewPin(pin);
  if (await q.get('SELECT id FROM users WHERE email=?', e)) throw emailTaken();
  if (p && await q.get('SELECT id FROM users WHERE phone=?', p)) throw phoneTaken();
  const deviceHash = normalizeDeviceId(device_id);
  await verifyOtp(e, 'register', otp_code);
  const [passwordHash, pinHash] = await Promise.all([hashSecret(password), hashSecret(pin)]);
  const id = newId('usr');
  let merchant = null;
  try {
    merchant = await tx(async () => {
      await q.run(`INSERT INTO users (id, account_type, email, email_verified_at, phone, full_name, password_hash, pin_hash, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)`,
      id, account_type, e, now(), p, String(full_name).trim(), passwordHash, pinHash, now());
      await getWallet('user', id, 'CDF');
      await getWallet('user', id, 'USD');
      await trustDevice(id, deviceHash, device_label);
      return account_type === 'business' ? createMerchantAccount(id, business_name) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw /phone/.test(`${err.constraint || ''} ${err.detail || ''}`) ? phoneTaken() : emailTaken();
    throw err;
  }
  const user = await q.get('SELECT * FROM users WHERE id=?', id);
  res.status(201).json({
    token: signToken({ sub: id }),
    user: serializeUser(user),
    ...(merchant ? { merchant: { id: merchant.id, name: String(business_name).trim(), secret_key: merchant.secretKey, notice: 'Conservez cette clé secrète : elle ne sera plus affichée.' } } : {}),
  });
});

/**
 * Connexion par email (ou par numéro de téléphone). Depuis un appareil inconnu, le mot de passe ne suffit pas :
 * un code est envoyé par email (ou par SMS à défaut) et la requête doit être rejouée avec otp_code.
 */
authRouter.post('/auth/login', limiter, async (req, res) => {
  const { password, otp_code, device_id, device_label } = req.body || {};
  const identifier = req.body?.identifier ?? req.body?.email ?? req.body?.phone;
  let user;
  try {
    user = isEmail(identifier)
      ? await q.get('SELECT * FROM users WHERE email=?', normalizeEmail(identifier))
      : await q.get('SELECT * FROM users WHERE phone=?', normalizePhone(identifier));
  } catch { /* format invalide : même réponse qu'un compte inconnu */ }
  const ok = await verifySecret(password || '', user?.password_hash || DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Identifiant ou mot de passe incorrect.');
  if (user.status === 'closed') throw new HttpError(403, 'account_closed', 'Ce compte a été fermé.');
  if (user.status !== 'active') throw new HttpError(403, 'account_disabled', 'Compte suspendu.');
  const deviceHash = normalizeDeviceId(device_id);
  if (!(await isTrustedDevice(user.id, deviceHash))) {
    const destination = user.email || user.phone;
    if (!otp_code) {
      const sent = await issueOtp(destination, 'login').catch((e) => {
        if (e.code === 'otp_too_soon') return null; // un code récent est encore valable
        throw e;
      });
      throw new HttpError(403, 'otp_required',
        `Nouvel appareil : saisissez le code envoyé ${isEmail(destination) ? 'par email à' : 'par SMS au'} ${mask(destination)}.`,
        { channel: isEmail(destination) ? 'email' : 'sms', ...(sent || {}) });
    }
    await verifyOtp(destination, 'login', otp_code);
    await trustDevice(user.id, deviceHash, device_label);
  }
  res.json({ token: signToken({ sub: user.id }), user: serializeUser(user) });
});

authRouter.get('/me', requireUser, (req, res) => {
  res.json({ user: serializeUser(req.user), limits: describeLimits(req.user) });
});
