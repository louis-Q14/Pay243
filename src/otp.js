import crypto from 'node:crypto';
import { config, exposesCodes } from './config.js';
import { q } from './db.js';
import { emailProvider, layoutHtml, layoutText } from './providers/email/index.js';
import { smsProvider } from './providers/sms/index.js';
import { HttpError, isEmail, newId, now, safeEqual, sha256 } from './util.js';

export const OTP_PURPOSES = ['register', 'login', 'email_change', 'phone_change', 'password_reset', 'staff_login'];

const hashCode = (destination, purpose, code) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${destination}:${purpose}:${code}`).digest('hex');

const SMS = {
  register: (code) => `Pay243 : votre code de vérification est ${code}. Il expire dans 5 minutes. Ne le communiquez à personne.`,
  login: (code) => `Pay243 : code de connexion sur un nouvel appareil : ${code}. Si ce n'est pas vous, changez votre mot de passe.`,
  phone_change: (code) => `Pay243 : code pour ajouter ce numéro à votre compte : ${code}. Il expire dans 5 minutes.`,
  password_reset: (code) => `Pay243 : code de réinitialisation du mot de passe : ${code}. Si ce n'est pas vous, ignorez ce message.`,
};

const EMAIL = {
  register: (code) => ({
    subject: `${code} est votre code Pay243`,
    title: 'Confirmez votre adresse email',
    intro: 'Saisissez ce code pour terminer la création de votre compte Pay243. Il expire dans 5 minutes.',
    footer: "Vous n'avez pas demandé ce code ? Ignorez ce message : aucun compte ne sera créé. Pay243 ne vous demandera jamais ce code par téléphone.",
  }),
  login: (code) => ({
    subject: `${code} : connexion depuis un nouvel appareil`,
    title: 'Connexion depuis un nouvel appareil',
    intro: "Quelqu'un (vous, normalement) essaie de se connecter à votre compte depuis un appareil inconnu. Saisissez ce code pour l'autoriser.",
    footer: "Si ce n'est pas vous, ne communiquez ce code à personne et changez votre mot de passe.",
  }),
  email_change: () => ({
    subject: 'Confirmez votre nouvelle adresse email Pay243',
    title: 'Confirmez votre nouvelle adresse',
    intro: 'Saisissez ce code dans vos paramètres Pay243 pour utiliser cette adresse email. Il expire dans 5 minutes.',
    footer: "Vous n'avez rien demandé ? Ignorez ce message : votre adresse ne sera pas ajoutée.",
  }),
  staff_login: (code) => ({
    subject: `${code} : connexion au back-office Pay243`,
    title: 'Connexion au back-office',
    intro: 'Saisissez ce code pour terminer votre connexion au back-office Pay243. Il expire dans 5 minutes.',
    footer: "Si vous n'êtes pas à l'origine de cette connexion, votre mot de passe est compromis : prévenez immédiatement un administrateur.",
  }),
  password_reset: (code) => ({
    subject: `${code} : réinitialisation de votre mot de passe Pay243`,
    title: 'Réinitialisez votre mot de passe',
    intro: 'Vous avez demandé à réinitialiser le mot de passe de votre compte Pay243. Saisissez ce code pour en choisir un nouveau. Il expire dans 5 minutes.',
    footer: "Vous n'avez rien demandé ? Ignorez ce message : votre mot de passe reste inchangé. Pay243 ne vous demandera jamais ce code par téléphone.",
  }),
};

/** Envoie le code par email ou par SMS selon la destination. */
async function deliver(destination, purpose, code) {
  if (isEmail(destination)) {
    const m = EMAIL[purpose](code);
    const content = { preheader: `Votre code : ${code}`, title: m.title, paragraphs: [m.intro], code, footer: m.footer };
    return emailProvider().send({ to: destination, subject: m.subject, text: layoutText(content), html: layoutHtml(content), tag: `otp_${purpose}` });
  }
  return smsProvider().send({ to: destination, message: SMS[purpose](code) });
}

/**
 * Génère et envoie un code à 6 chiffres, par email (destination contenant « @ ») ou par SMS.
 * Applique un délai entre deux envois et un plafond horaire par destination.
 * Renvoie { expires_in, channel, sandbox_code? } — le code n'est exposé que si l'envoi est simulé (démo, tests).
 */
export async function issueOtp(destination, purpose) {
  if (!OTP_PURPOSES.includes(purpose)) throw new HttpError(400, 'invalid_purpose', 'purpose invalide.');
  const o = config.otp;
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const recent = await q.all('SELECT purpose, created_at FROM otp_codes WHERE destination=? AND created_at >= ? ORDER BY created_at DESC', destination, hourAgo);
  const last = recent.find((r) => r.purpose === purpose);
  if (last) {
    const wait = Math.ceil(o.resendSeconds - (Date.now() - Date.parse(last.created_at)) / 1000);
    if (wait > 0) throw new HttpError(429, 'otp_too_soon', `Patientez ${wait} s avant de demander un nouveau code.`, { retry_after: wait });
  }
  if (recent.length >= o.maxPerHour) throw new HttpError(429, 'otp_rate_limited', 'Trop de codes demandés pour cette adresse. Réessayez dans une heure.');
  const channel = isEmail(destination) ? 'email' : 'sms';

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const id = newId('otp');
  // Un seul code actif par (numéro, usage) : les précédents sont invalidés.
  await q.run('UPDATE otp_codes SET consumed_at=? WHERE destination=? AND purpose=? AND consumed_at IS NULL', now(), destination, purpose);
  await q.run('INSERT INTO otp_codes (id, destination, channel, purpose, code_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
    id, destination, channel, purpose, hashCode(destination, purpose, code), new Date(Date.now() + o.ttlSeconds * 1000).toISOString(), now());
  try {
    await deliver(destination, purpose, code);
  } catch (e) {
    await q.run('UPDATE otp_codes SET consumed_at=? WHERE id=?', now(), id);
    throw new HttpError(502, `${channel}_failed`, `Envoi du ${channel === 'email' ? 'message' : 'SMS'} impossible : ${e.message}`);
  }
  // Le code ne revient dans l'API que si aucun message réel n'est parti (pilote « mock », hors production).
  return { expires_in: o.ttlSeconds, channel, ...(exposesCodes(channel) ? { sandbox_code: code } : {}) };
}

/** Vérifie et consomme le code (consommation atomique : un code ne sert qu'une fois, même en concurrence). */
export async function verifyOtp(destination, purpose, code) {
  if (!/^\d{6}$/.test(String(code || ''))) throw new HttpError(400, 'invalid_otp', 'Code de vérification à 6 chiffres requis.');
  const row = await q.get('SELECT * FROM otp_codes WHERE destination=? AND purpose=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1', destination, purpose);
  if (!row || row.expires_at < now()) throw new HttpError(400, 'otp_expired', 'Code expiré ou inexistant. Demandez un nouveau code.');
  if (row.attempts >= config.otp.maxAttempts) throw new HttpError(429, 'otp_locked', "Trop d'essais. Demandez un nouveau code.");
  if (!safeEqual(row.code_hash, hashCode(destination, purpose, String(code)))) {
    const { attempts } = await q.get('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=? RETURNING attempts', row.id);
    throw new HttpError(400, 'invalid_otp', `Code incorrect. Essais restants : ${Math.max(config.otp.maxAttempts - attempts, 0)}.`);
  }
  const used = await q.run('UPDATE otp_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND attempts < ?', now(), row.id, config.otp.maxAttempts);
  if (!used.changes) throw new HttpError(400, 'otp_expired', 'Code déjà utilisé. Demandez un nouveau code.');
}

// ---------- Appareils de confiance ----------
export function normalizeDeviceId(deviceId) {
  if (deviceId == null || deviceId === '') return null;
  const d = String(deviceId);
  if (d.length < 16 || d.length > 128) throw new HttpError(400, 'invalid_device_id', 'device_id doit comporter 16 à 128 caractères.');
  return sha256(d);
}

export async function isTrustedDevice(userId, deviceHash) {
  if (!deviceHash) return false;
  const r = await q.run('UPDATE trusted_devices SET last_seen_at=? WHERE user_id=? AND device_hash=?', now(), userId, deviceHash);
  return r.changes > 0;
}

export async function trustDevice(userId, deviceHash, label) {
  if (!deviceHash) return;
  await q.run(
    `INSERT INTO trusted_devices (user_id, device_hash, label, created_at, last_seen_at) VALUES (?,?,?,?,?)
     ON CONFLICT (user_id, device_hash) DO UPDATE SET label = EXCLUDED.label, last_seen_at = EXCLUDED.last_seen_at`,
    userId, deviceHash, label ? String(label).slice(0, 120) : null, now(), now(),
  );
}
