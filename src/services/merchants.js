import crypto from 'node:crypto';
import { generateApiKey } from '../auth.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { HttpError, newId, now } from '../util.js';

/** Émet une nouvelle clé API (seul son hash est conservé) et renvoie la clé en clair, à afficher une fois. */
export async function issueKey(merchantId, mode) {
  if (mode === 'live' && config.mode !== 'live') throw new HttpError(400, 'live_disabled', "Les clés live ne sont disponibles qu'en production, après validation KYB.");
  const k = generateApiKey(mode);
  await q.run('INSERT INTO api_keys (id, merchant_id, mode, prefix, key_hash, last4, created_at) VALUES (?,?,?,?,?,?,?)',
    newId('key'), merchantId, mode, k.prefix, k.hash, k.last4, now());
  return k.key;
}

const PHONE_RE = /^\+?[0-9][0-9 ().-]{6,22}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const bad = (code, message) => new HttpError(400, code, message);
const text = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Valide les informations de l'entreprise saisies à l'inscription.
 * Obligatoires : RCCM, adresse, ville, téléphone et email de contact. Facultatifs : fax, site web.
 */
export function parseBusinessProfile(input) {
  const b = input && typeof input === 'object' ? input : {};
  const rccm = text(b.rccm, 60).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 /.-]{4,59}$/.test(rccm) || !/\d/.test(rccm)) {
    throw bad('invalid_rccm', 'Numéro RCCM invalide (ex : CD/KNG/RCCM/24-B-01234).');
  }
  const address = text(b.address, 200);
  if (address.length < 5) throw bad('invalid_business_address', "Indiquez l'adresse de l'entreprise (numéro, avenue, commune).");
  const city = text(b.city, 80);
  if (city.length < 2) throw bad('invalid_business_city', "Indiquez la ville de l'entreprise.");
  const country = (text(b.country, 2) || 'CD').toUpperCase();
  const phone = text(b.phone, 25);
  if (!PHONE_RE.test(phone)) throw bad('invalid_business_phone', "Numéro de téléphone de l'entreprise invalide.");
  const email = text(b.email, 160).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('invalid_business_email', "Adresse email de l'entreprise invalide.");
  const fax = text(b.fax, 25) || null;
  if (fax && !PHONE_RE.test(fax)) throw bad('invalid_business_fax', 'Numéro de fax invalide.');
  let website = text(b.website, 200) || null;
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    let u;
    try { u = new URL(website); } catch { throw bad('invalid_website', 'Adresse du site web invalide.'); }
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) throw bad('invalid_website', 'Adresse du site web invalide.');
    website = u.toString();
  }
  return { rccm, address, city, country, phone, email, fax, website };
}

export const rccmTaken = () => new HttpError(409, 'rccm_taken', 'Ce numéro RCCM est déjà rattaché à un compte Pay243.');

/** Informations de l'entreprise telles qu'exposées par l'API (null si non renseignées). */
export function businessProfileOf(m) {
  if (!m?.rccm && !m?.address_line && !m?.contact_phone) return null;
  return {
    rccm: m.rccm || null, address: m.address_line || null, city: m.city || null, country: m.country || null,
    phone: m.contact_phone || null, email: m.contact_email || null, fax: m.fax || null, website: m.website || null,
  };
}

// ---------------------------------------------------------------------
//  Accès à l'espace marchand : réservé aux comptes entreprise, sur demande,
//  activé par l'équipe depuis le back-office. Tant qu'il n'est pas activé :
//  pas d'onglet dans l'app, pas de clé API, pas de lien de paiement, API refusée.
// ---------------------------------------------------------------------
export const ACCESS_LABELS = { none: 'Non demandé', requested: 'Demande en attente', enabled: 'Activé', rejected: 'Demande refusée', disabled: 'Désactivé' };

/** État de l'accès tel qu'exposé au titulaire (le motif n'est montré que pour un refus ou une désactivation). */
export function accessOf(m) {
  const status = m?.access_status || 'none';
  return {
    status,
    label: ACCESS_LABELS[status],
    enabled: status === 'enabled',
    requested_at: m?.access_requested_at || null,
    decided_at: m?.access_decided_at || null,
    note: ['rejected', 'disabled'].includes(status) ? m?.access_note || null : null,
  };
}

export function assertMerchantEnabled(m) {
  if (m?.access_status === 'enabled') return;
  throw new HttpError(403, 'merchant_not_enabled', m?.access_status === 'requested'
    ? "Votre demande d'activation de l'espace marchand est en cours d'examen : vous serez prévenu par email."
    : "Votre espace marchand n'est pas activé. Demandez son activation depuis Paramètres › Outils vendeur.");
}

/**
 * Crée le compte marchand (non activé) d'un utilisateur. À appeler dans tx() :
 * l'unicité (un marchand par utilisateur, un RCCM par marchand) est garantie par la base.
 * Aucune clé API n'est émise : le titulaire en génère une une fois l'espace activé par l'équipe.
 */
export async function createMerchantAccount(userId, name, webhookUrl = null, profile = null) {
  const id = newId('mch');
  const p = profile || {};
  await q.run(`INSERT INTO merchants (id, owner_user_id, name, webhook_url, webhook_secret, created_at,
                 rccm, address_line, city, country, contact_phone, contact_email, fax, website)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, userId, String(name).trim(), webhookUrl, `whsec_${crypto.randomBytes(24).toString('base64url')}`, now(),
    p.rccm || null, p.address || null, p.city || null, p.country || null, p.phone || null, p.email || null, p.fax || null, p.website || null);
  return { id };
}
