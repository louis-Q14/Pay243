import { emailProvider } from '../providers/email/index.js';
import { smsProvider } from '../providers/sms/index.js';
import { parseJson } from '../util.js';

/**
 * Préférences de notification. Les alertes de sécurité (mot de passe, email, connexion) ne peuvent pas être coupées :
 * elles sont le seul moyen pour l'utilisateur de repérer une prise de contrôle de son compte.
 */
export const NOTIFICATION_DEFAULTS = {
  payments_email: true,   // argent reçu / envoyé, par email
  payments_sms: false,    // idem, par SMS (si un numéro est enregistré)
  security_email: true,   // toujours actif
  product_email: false,   // nouveautés et offres
};
const LOCKED = { security_email: true };

export function notificationPrefs(user) {
  return { ...NOTIFICATION_DEFAULTS, ...parseJson(user.notification_prefs, {}), ...LOCKED };
}

/** Fusionne une mise à jour partielle avec les préférences actuelles ; ignore les clés inconnues. */
export function mergePrefs(user, patch = {}) {
  const next = notificationPrefs(user);
  for (const k of Object.keys(NOTIFICATION_DEFAULTS)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  return { ...next, ...LOCKED };
}

/**
 * Prévient l'utilisateur selon ses préférences. category : 'payments' | 'security'.
 * Ne bloque jamais l'opération appelante (les erreurs d'envoi sont journalisées).
 * `to` permet d'écrire à une ancienne adresse (changement d'email).
 */
export function notifyUser(user, category, subject, message, { to } = {}) {
  const p = notificationPrefs(user);
  const jobs = [];
  const email = to || user.email;
  if (email && p[`${category}_email`]) jobs.push(emailProvider().send({ to: email, subject, text: message }));
  if (user.phone && category === 'payments' && p.payments_sms) jobs.push(smsProvider().send({ to: user.phone, message: `Pay243 : ${message}`.slice(0, 300) }));
  if (!email && user.phone && category === 'security') jobs.push(smsProvider().send({ to: user.phone, message: `Pay243 : ${message}`.slice(0, 300) }));
  for (const j of jobs) Promise.resolve(j).catch((e) => console.error(`[notify:${category}]`, e.message));
}
