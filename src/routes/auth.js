import { Router } from 'express';
import { assertNewPassword, assertNewPin, hashSecret, requireUser, signToken, verificationStatus, verifySecret } from '../auth.js';
import { config } from '../config.js';
import { isUniqueViolation, q, tx } from '../db.js';
import { getWallet } from '../ledger.js';
import { describeLimits } from '../limits.js';
import { rateLimit } from '../middleware.js';
import { isTrustedDevice, issueOtp, normalizeDeviceId, trustDevice, verifyOtp } from '../otp.js';
import { createMerchantAccount, parseBusinessProfile, rccmTaken } from '../services/merchants.js';
import { appUrl, notificationPrefs, notifyUser } from '../services/notify.js';
import { HttpError, detectOperator, isEmail, newId, normalizeEmail, normalizePhone, now } from '../util.js';

export const authRouter = Router();
const limiter = rateLimit({ name: 'auth', max: config.rateLimits.auth });
const otpLimiter = rateLimit({ name: 'otp', max: config.rateLimits.otp });
// Limite par compte visé (en plus de la limite par adresse IP) : freine la recherche d'un mot de passe
// menée depuis de nombreuses adresses.
const accountKey = (req) => {
  const id = req.body?.identifier ?? req.body?.email ?? req.body?.phone;
  return id ? String(id).trim().toLowerCase().slice(0, 254) : `ip:${req.ip}`;
};
const accountLimiter = (name) => rateLimit({
  name, windowMs: 15 * 60_000, max: config.rateLimits.loginPerAccount, keyOf: accountKey,
  message: 'Trop de tentatives pour ce compte. Réessayez dans un quart d’heure.',
});

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
    activated: !!u.activated_at,
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
  if (config.registrationsEnabled === false) throw new HttpError(503, 'signup_closed', 'Les inscriptions sont momentanément fermées. Réessayez plus tard.');
  const { email, purpose = 'register' } = req.body || {};
  if (purpose !== 'register') throw new HttpError(400, 'invalid_purpose', 'Pour la connexion, le code est envoyé automatiquement par /v1/auth/login.');
  const e = normalizeEmail(email);
  if (await q.get('SELECT id FROM users WHERE email=?', e)) throw emailTaken();
  const r = await issueOtp(e, 'register');
  res.status(201).json({ sent: true, email: e, ...r });
});

/** Étape 2 : création du compte (particulier ou entreprise) avec le code reçu par email. */
authRouter.post('/auth/register', limiter, async (req, res) => {
  if (config.registrationsEnabled === false) throw new HttpError(503, 'signup_closed', 'Les inscriptions sont momentanément fermées. Réessayez plus tard.');
  const { account_type, email, otp_code, full_name, password, pin, phone, business_name, device_id, device_label } = req.body || {};
  if (!ACCOUNT_TYPES.includes(account_type)) {
    throw new HttpError(400, 'invalid_account_type', 'Choisissez un type de compte : "personal" (particulier) ou "business" (entreprise).');
  }
  const e = normalizeEmail(email);
  const p = phone ? normalizePhone(phone) : null;
  const nameLen = String(full_name || '').trim().length;
  if (nameLen < 3 || nameLen > 80) throw new HttpError(400, 'invalid_name', 'Nom complet requis (3 à 80 caractères).');
  const bizLen = String(business_name || '').trim().length;
  if (account_type === 'business' && (bizLen < 2 || bizLen > 80)) {
    throw new HttpError(400, 'invalid_business_name', "Nom de l'entreprise requis (2 à 80 caractères).");
  }
  const profile = account_type === 'business' ? parseBusinessProfile(req.body.business) : null;
  if (profile && await q.get('SELECT id FROM merchants WHERE rccm=?', profile.rccm)) throw rccmTaken();
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
      return account_type === 'business' ? createMerchantAccount(id, business_name, null, profile) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const where = `${err.constraint || ''} ${err.detail || ''}`;
      throw /rccm/.test(where) ? rccmTaken() : /phone/.test(where) ? phoneTaken() : emailTaken();
    }
    throw err;
  }
  const user = await q.get('SELECT * FROM users WHERE id=?', id);
  sendWelcome(user, merchant ? String(business_name).trim() : null);
  res.status(201).json({
    token: signToken({ sub: id }),
    user: serializeUser(user),
    ...(merchant ? { merchant: { id: merchant.id, name: String(business_name).trim(), access: { status: 'none', enabled: false } } } : {}),
  });
});

/**
 * Connexion par email (ou par numéro de téléphone). Depuis un appareil inconnu, le mot de passe ne suffit pas :
 * un code est envoyé par email (ou par SMS à défaut) et la requête doit être rejouée avec otp_code.
 */
authRouter.post('/auth/login', limiter, accountLimiter('login_account'), async (req, res) => {
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
    notifyUser(user, 'security', 'Nouvelle connexion à votre compte Pay243', 'Votre compte vient d’être ouvert depuis un nouvel appareil, désormais reconnu.', {
      paragraphs: ['Votre compte Pay243 vient d’être ouvert depuis un nouvel appareil. Il est désormais reconnu : aucun code ne sera demandé lors des prochaines connexions depuis celui-ci.'],
      details: [['Appareil', deviceName(device_label)], ['Date', new Date().toLocaleString('fr-FR', { timeZone: user.timezone || 'Africa/Kinshasa' })], ['Adresse IP', req.ip || 'inconnue']],
      cta: { label: 'Voir mes appareils', url: appUrl('/settings#securite') },
    });
  }
  res.json({ token: signToken({ sub: user.id }), user: serializeUser(user) });
});

// ---------- Mot de passe oublié ----------
/**
 * Étape 1 : code envoyé à l'adresse du compte. Réponse identique que le compte existe ou non
 * (on ne révèle pas quelles adresses sont inscrites).
 */
authRouter.post('/auth/password/forgot', otpLimiter, async (req, res) => {
  const e = normalizeEmail(req.body?.email);
  const user = await q.get("SELECT id FROM users WHERE email=? AND status='active'", e);
  let sent = null;
  if (user) {
    sent = await issueOtp(e, 'password_reset').catch((err) => {
      if (err.code === 'otp_too_soon' || err.code === 'otp_rate_limited') return null;
      throw err;
    });
  }
  res.json({ sent: true, email: e, expires_in: config.otp.ttlSeconds, channel: 'email', ...(sent?.sandbox_code ? { sandbox_code: sent.sandbox_code } : {}) });
});

/** Étape 2 : nouveau mot de passe. Toutes les sessions ouvertes sont fermées ; cet appareil devient de confiance. */
authRouter.post('/auth/password/reset', limiter, accountLimiter('reset_account'), async (req, res) => {
  const { otp_code, new_password, device_id, device_label } = req.body || {};
  const e = normalizeEmail(req.body?.email);
  assertNewPassword(new_password);
  const user = await q.get("SELECT * FROM users WHERE email=? AND status='active'", e);
  if (!user) throw new HttpError(400, 'invalid_otp', 'Code incorrect ou expiré. Demandez un nouveau code.');
  const deviceHash = normalizeDeviceId(device_id);
  await verifyOtp(e, 'password_reset', otp_code);
  await q.run('UPDATE users SET password_hash=?, sessions_valid_after=? WHERE id=?', await hashSecret(new_password), Date.now(), user.id);
  await trustDevice(user.id, deviceHash, device_label);
  notifyUser(user, 'security', 'Votre mot de passe Pay243 a été réinitialisé', 'Le mot de passe de votre compte vient d’être réinitialisé. Toutes vos sessions ont été fermées.', {
    paragraphs: ['Le mot de passe de votre compte Pay243 vient d’être réinitialisé avec un code envoyé à cette adresse. Toutes les sessions ouvertes ont été fermées.'],
    details: [['Appareil', deviceName(device_label)], ['Adresse IP', req.ip || 'inconnue']],
  });
  const fresh = await q.get('SELECT * FROM users WHERE id=?', user.id);
  res.json({ token: signToken({ sub: user.id }), user: serializeUser(fresh) });
});

// ---------- Emails ----------
/** Nom lisible d'un appareil à partir de son user-agent (« Chrome sur Windows »). */
function deviceName(label) {
  const l = String(label || '');
  const os = /Windows/.test(l) ? 'Windows' : /Android/.test(l) ? 'Android' : /iPhone|iPad/.test(l) ? 'iPhone / iPad' : /Mac OS/.test(l) ? 'Mac' : /Linux/.test(l) ? 'Linux' : null;
  const br = /Edg\//.test(l) ? 'Edge' : /OPR\//.test(l) ? 'Opera' : /Chrome\//.test(l) ? 'Chrome' : /Firefox\//.test(l) ? 'Firefox' : /Safari\//.test(l) ? 'Safari' : null;
  return os || br ? [br, os].filter(Boolean).join(' sur ') : 'Appareil inconnu';
}

function sendWelcome(user, businessName) {
  const first = user.full_name.split(' ')[0];
  if (businessName) {
    notifyUser(user, 'account', `Bienvenue sur Pay243, ${businessName}`, `Votre compte entreprise ${businessName} est prêt.`, {
      title: `Bienvenue, ${first} !`,
      paragraphs: [
        `Votre compte entreprise « ${businessName} » est ouvert. Commencez par vérifier votre identité : notre équipe valide votre pièce, puis active votre compte.`,
        'Pour encaisser (liens de paiement WhatsApp, API pour votre site), demandez ensuite l’activation de votre espace marchand depuis Paramètres › Outils vendeur. Notre équipe l’examine et vous prévient par email.',
      ],
      cta: { label: 'Vérifier mon identité', url: appUrl('/app#kyc') },
    });
  } else {
    notifyUser(user, 'account', 'Bienvenue sur Pay243', 'Votre compte Pay243 est prêt.', {
      title: `Bienvenue, ${first} !`,
      paragraphs: [
        'Votre compte Pay243 est ouvert. Rechargez-le avec M-Pesa, Airtel Money, Orange Money ou une carte, puis envoyez de l’argent gratuitement à vos proches, en francs congolais ou en dollars.',
        'Dernière étape : vérifiez votre identité. Pour votre sécurité, votre compte est activé dès que notre équipe a validé votre pièce d’identité, généralement sous 24 h.',
      ],
      cta: { label: 'Vérifier mon identité', url: appUrl('/app#kyc') },
    });
  }
}

authRouter.get('/me', requireUser, async (req, res) => {
  res.json({ user: serializeUser(req.user), limits: describeLimits(req.user), verification: { status: await verificationStatus(req.user) } });
});
