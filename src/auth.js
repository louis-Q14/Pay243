import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, safeEqual, sha256 } from './util.js';

const scrypt = promisify(crypto.scrypt);

// ---------- Mots de passe & PIN (scrypt, asynchrone : ne bloque pas le serveur) ----------
export async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(secret), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifySecret(secret, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const hash = await scrypt(String(secret), Buffer.from(saltHex, 'hex'), 64);
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

const MAX_PIN_FAILURES = 5;

/** Vérifie le PIN de transaction ; bloque le compte après 5 erreurs consécutives (compteur atomique). */
export async function verifyPin(user, pin) {
  const fresh = await q.get('SELECT pin_hash, pin_failures FROM users WHERE id=?', user.id);
  if (fresh.pin_failures >= MAX_PIN_FAILURES) {
    throw new HttpError(423, 'pin_locked', 'PIN bloqué après trop de tentatives. Contactez le support Pay243.');
  }
  if (!pin || !(await verifySecret(pin, fresh.pin_hash))) {
    const { pin_failures: n } = await q.get('UPDATE users SET pin_failures = pin_failures + 1 WHERE id=? RETURNING pin_failures', user.id);
    if (n >= MAX_PIN_FAILURES) throw new HttpError(423, 'pin_locked', 'PIN bloqué après trop de tentatives. Contactez le support Pay243.');
    throw new HttpError(401, 'invalid_pin', `PIN incorrect. Tentatives restantes : ${MAX_PIN_FAILURES - n}.`);
  }
  if (fresh.pin_failures) await q.run('UPDATE users SET pin_failures = 0 WHERE id=?', user.id);
}

// ---------- Jetons de session (JWT HS256) ----------
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signToken(payload, ttlSeconds = 60 * 60 * 12) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const t = Date.now();
  const body = b64({ ...payload, iat: Math.floor(t / 1000), iat_ms: t, exp: Math.floor(t / 1000) + ttlSeconds });
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  const [h, b, s] = String(token).split('.');
  if (!h || !b || !s) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${h}.${b}`).digest('base64url');
  if (!safeEqual(s, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(b, 'base64url').toString()); } catch { return null; }
  if (!payload || typeof payload.sub !== 'string' || !(payload.exp >= Date.now() / 1000)) return null;
  return payload;
}

const issuedAt = (p) => Number(p.iat_ms ?? p.iat * 1000);

/** Règles communes (inscription, changement dans les paramètres). */
const COMMON_PASSWORDS = new Set(['password', 'password1', 'motdepasse', '12345678', '123456789', '1234567890', 'azertyuiop', 'azerty123', 'qwertyuiop', 'qwerty123', 'pay243pay243', 'iloveyou', 'kinshasa', '00000000', '11111111']);
export function assertNewPassword(password) {
  const p = typeof password === 'string' ? password : '';
  if (p.length < 8) throw new HttpError(400, 'weak_password', 'Le mot de passe doit contenir au moins 8 caractères.');
  if (p.length > 128) throw new HttpError(400, 'weak_password', 'Le mot de passe ne peut pas dépasser 128 caractères.');
  if (COMMON_PASSWORDS.has(p.toLowerCase()) || /^(.)\1+$/.test(p)) {
    throw new HttpError(400, 'weak_password', 'Ce mot de passe est trop courant. Choisissez-en un plus difficile à deviner.');
  }
}
export function assertNewPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin || ''))) throw new HttpError(400, 'invalid_pin', 'Le PIN de transaction doit comporter 4 à 6 chiffres.');
  if (/^(\d)\1+$/.test(String(pin)) || ['1234', '123456', '0000', '4321', '654321'].includes(String(pin))) {
    throw new HttpError(400, 'weak_pin', 'PIN trop simple. Évitez 1234, 0000, etc.');
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Middleware : utilisateur connecté (application wallet). */
export async function requireUser(req, _res, next) {
  const token = bearer(req);
  const payload = token && !token.startsWith('sk_') ? verifyToken(token) : null;
  if (!payload) throw new HttpError(401, 'unauthorized', 'Session invalide ou expirée. Reconnectez-vous.');
  const user = await q.get('SELECT * FROM users WHERE id=?', payload.sub);
  if (!user || user.status !== 'active') throw new HttpError(401, 'unauthorized', 'Compte inactif.');
  // Jeton émis avant un changement de mot de passe ou une déconnexion globale : refusé.
  if (issuedAt(payload) < Number(user.sessions_valid_after || 0)) throw new HttpError(401, 'unauthorized', 'Session expirée. Reconnectez-vous.');
  req.user = user;
  next();
}

/** Comme requireUser mais facultatif (checkout invité). */
export async function optionalUser(req, _res, next) {
  const token = bearer(req);
  const payload = token && !token.startsWith('sk_') ? verifyToken(token) : null;
  if (payload) {
    const user = await q.get('SELECT * FROM users WHERE id=?', payload.sub);
    if (user?.status === 'active' && issuedAt(payload) >= Number(user.sessions_valid_after || 0)) req.user = user;
  }
  next();
}

// ---------- Activation du compte ----------
/** Statut de vérification affiché à l'utilisateur : required | pending | rejected | verified. */
export async function verificationStatus(user) {
  if (user.activated_at) return 'verified';
  const last = await q.get('SELECT status FROM kyc_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 1', user.id);
  return last?.status === 'pending' ? 'pending' : last?.status === 'rejected' ? 'rejected' : 'required';
}

export const notVerifiedError = (status) => new HttpError(403, 'account_not_verified',
  status === 'pending'
    ? "Votre pièce d'identité est en cours de vérification. Vous pourrez effectuer des opérations dès que notre équipe aura activé votre compte."
    : "Votre compte n'est pas encore activé. Vérifiez votre identité : notre équipe valide votre demande, puis votre compte est activé.",
  { verification_status: status });

/** Middleware (après requireUser) : aucune opération d'argent avant l'activation du compte. */
export async function requireActivated(req, _res, next) {
  if (!req.user.activated_at) throw notVerifiedError(await verificationStatus(req.user));
  next();
}

// ---------- Clés API marchands ----------
// Format : sk_test_<32 car.> / sk_live_<32 car.> ; seul le hash SHA-256 est stocké.
export function generateApiKey(mode) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = `sk_${mode}_${secret}`;
  return { key, prefix: key.slice(0, 16), hash: sha256(key), last4: key.slice(-4) };
}

/** Middleware : authentification d'un marchand par clé secrète (serveur à serveur). */
export async function requireMerchantKey(req, _res, next) {
  const key = bearer(req);
  if (!key || !/^sk_(test|live)_/.test(key)) {
    throw new HttpError(401, 'invalid_api_key', 'Clé API manquante. Utilisez "Authorization: Bearer sk_test_...".');
  }
  const row = await q.get('SELECT * FROM api_keys WHERE prefix=? AND revoked_at IS NULL', key.slice(0, 16));
  if (!row || !safeEqual(row.key_hash, sha256(key))) throw new HttpError(401, 'invalid_api_key', 'Clé API invalide ou révoquée.');
  req.merchant = await q.get('SELECT * FROM merchants WHERE id=?', row.merchant_id);
  if (req.merchant.suspended_at) throw new HttpError(403, 'merchant_suspended', 'Compte marchand suspendu. Contactez le support Pay243.');
  if (req.merchant.access_status !== 'enabled') throw new HttpError(403, 'merchant_not_enabled', "L'espace marchand de ce compte n'est pas activé par Pay243.");
  const owner = await q.get('SELECT status, activated_at FROM users WHERE id=?', req.merchant.owner_user_id);
  if (owner?.status !== 'active') throw new HttpError(403, 'merchant_suspended', 'Compte marchand inactif. Contactez le support Pay243.');
  if (!owner.activated_at) throw new HttpError(403, 'account_not_verified', "Le compte de ce marchand n'est pas encore activé : son identité doit d'abord être vérifiée par Pay243.");
  req.livemode = row.mode === 'live';
  next();
}

// Back-office : voir src/staff.js (rôles, permissions, sessions de l'équipe).
