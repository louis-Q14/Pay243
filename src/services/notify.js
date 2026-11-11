import { config } from '../config.js';
import { emailProvider, layoutHtml, layoutText } from '../providers/email/index.js';
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
/** Catégories toujours envoyées : sécurité et vie du compte (bienvenue, vérification d'identité, fermeture). */
const ALWAYS = new Set(['security', 'account']);

export function notificationPrefs(user) {
  return { ...NOTIFICATION_DEFAULTS, ...parseJson(user.notification_prefs, {}), ...LOCKED };
}

/** Fusionne une mise à jour partielle avec les préférences actuelles ; ignore les clés inconnues. */
export function mergePrefs(user, patch = {}) {
  const next = notificationPrefs(user);
  for (const k of Object.keys(NOTIFICATION_DEFAULTS)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  return { ...next, ...LOCKED };
}

export const appUrl = (p = '/app') => `${config.baseUrl.replace(/\/$/, '')}${p}`;

/**
 * Prévient l'utilisateur selon ses préférences. category : 'payments' | 'security' | 'account'.
 * Ne bloque jamais l'opération appelante (les erreurs d'envoi sont journalisées).
 * Options : to (écrire à une ancienne adresse), title, paragraphs (sinon le message seul), details [[libellé, valeur]], cta { label, url }.
 */
export function notifyUser(user, category, subject, message, { to, title, paragraphs, details, cta, footer } = {}) {
  const p = notificationPrefs(user);
  const jobs = [];
  const email = to || user.email;
  const wantsEmail = ALWAYS.has(category) || p[`${category}_email`];
  if (email && wantsEmail) {
    const content = {
      preheader: message.slice(0, 120),
      title: title || subject,
      paragraphs: paragraphs || [message],
      details: details || [],
      cta,
      footer: footer || (category === 'security'
        ? "Si vous n'êtes pas à l'origine de cette action, changez immédiatement votre mot de passe et contactez le support Pay243."
        : undefined),
    };
    jobs.push(emailProvider().send({ to: email, subject, text: layoutText(content), html: layoutHtml(content), tag: category }));
  }
  if (user.phone && category === 'payments' && p.payments_sms) jobs.push(smsProvider().send({ to: user.phone, message: `Pay243 : ${message}`.slice(0, 300) }));
  // Sans email, les alertes importantes partent par SMS.
  if (!email && user.phone && ALWAYS.has(category)) jobs.push(smsProvider().send({ to: user.phone, message: `Pay243 : ${message}`.slice(0, 300) }));
  for (const j of jobs) Promise.resolve(j).catch((e) => console.error(`[notify:${category}]`, e.message));
}
