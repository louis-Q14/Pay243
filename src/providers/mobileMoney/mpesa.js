import crypto from 'node:crypto';
import { config } from '../../config.js';
import { ProviderError, providerFetch, toMajor } from './index.js';

/**
 * Vodacom M-Pesa RDC via l'M-Pesa Open API (marché "vodacomDRC", pays "DRC").
 * Référence : portail https://openapiportal.m-pesa.com (API Documentation + Testing Documentation, nov. 2026).
 *
 * Authentification : la clé API est chiffrée en RSA (PKCS#1 v1.5) avec la clé publique du portail pour obtenir
 * une clé de session (GET /getSession/), elle-même chiffrée de la même façon à chaque requête.
 * Une nouvelle clé de session met jusqu'à 30 s à devenir active ; sa durée de vie se règle sur la page
 * « Applications » du portail (MPESA_SESSION_MINUTES doit lui correspondre). La clé suivante est donc
 * préparée en arrière-plan avant l'expiration de la clé courante.
 *
 * Les opérations "single stage" sont synchrones : l'appel HTTP reste ouvert jusqu'à la validation du client
 * sur son téléphone. Elles sont lancées en arrière-plan et le résultat est publié sur le bus d'événements.
 *
 * ⚠ L'en-tête Origin doit correspondre aux « Trusted Sources » de l'application (IP des serveurs).
 */

export { SANDBOX_PUBLIC_KEY } from './mpesaKeys.js';

/* ---------- Références ----------
 * M-Pesa n'accepte que lettres et chiffres (le tiret de nos identifiants base64url est refusé, et la recherche
 * de statut refuse aussi le « _ »). Les 12 octets aléatoires de l'identifiant (txn_ + 16 caractères base64url)
 * sont donc encodés en base 62 sur 17 caractères : référence courte, alphanumérique et RÉVERSIBLE, pour que le
 * rapprochement retrouve la transaction à partir du relevé M-Pesa. */
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const REF_LEN = 17; // 62^17 > 2^96
const CONV_PREFIX = 'P243';

function toBase62(buf) {
  let n = BigInt(`0x${buf.toString('hex') || '0'}`); let s = '';
  while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n; }
  return s.padStart(REF_LEN, '0');
}
function fromBase62(s) {
  let n = 0n;
  for (const ch of s) { const i = B62.indexOf(ch); if (i < 0) return null; n = n * 62n + BigInt(i); }
  const hex = n.toString(16).padStart(24, '0');
  return hex.length === 24 ? Buffer.from(hex, 'hex') : null;
}

/** Référence de transaction M-Pesa (input_TransactionReference, 1 à 20 caractères alphanumériques). */
export function mpesaReference(txnId) {
  const m = /^txn_([A-Za-z0-9_-]{16})$/.exec(txnId);
  // Identifiant d'un autre format (ancien) : empreinte, non réversible mais toujours valide pour M-Pesa.
  return m ? toBase62(Buffer.from(m[1], 'base64url')) : toBase62(crypto.createHash('sha256').update(txnId).digest().subarray(0, 12));
}
/** input_ThirdPartyConversationID (≤ 40) et clé de recherche du statut (21 à 32 caractères alphanumériques). */
export const mpesaConversationId = (txnId) => CONV_PREFIX + mpesaReference(txnId);
/** Inverse de mpesaReference / mpesaConversationId : identifiant Pay243, ou null. */
export function txnIdFromMpesaReference(ref) {
  let r = String(ref || '').trim();
  if (r.length === REF_LEN + CONV_PREFIX.length && r.startsWith(CONV_PREFIX)) r = r.slice(CONV_PREFIX.length);
  if (r.length !== REF_LEN) return null;
  const buf = fromBase62(r);
  return buf ? `txn_${buf.toString('base64url')}` : null;
}

/** Libellés : M-Pesa n'accepte que lettres non accentuées, chiffres, espaces, « _ » et « + » (1 à 256). */
export function mpesaText(s, fallback) {
  const clean = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^0-9A-Za-z_+ ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  return clean || fallback;
}

// Codes de réponse (portail, nov. 2026).
const UNCERTAIN_CODES = new Set(['INS-1', 'INS-9', 'INS-10']); // erreur interne, délai dépassé, doublon : issue inconnue
const RENEW_SESSION_CODES = new Set(['INS-993', 'INS-994']); // limites de la session atteintes : une nouvelle clé les remet à zéro
const REASONS = {
  'INS-6': 'Transaction refusée (PIN incorrect ou demande annulée)',
  'INS-13': 'Code marchand M-Pesa invalide',
  'INS-15': 'Montant invalide',
  'INS-26': 'Devise non acceptée par M-Pesa',
  'INS-990': 'Limite M-Pesa du client atteinte pour aujourd\'hui (montant)',
  'INS-991': 'Limite M-Pesa du client atteinte pour aujourd\'hui (nombre d\'opérations)',
  'INS-992': 'Plusieurs limites M-Pesa atteintes',
  'INS-995': 'Montant au-delà de la limite M-Pesa par opération',
  'INS-996': 'Service M-Pesa indisponible à cette heure',
  'INS-997': 'Service M-Pesa non activé pour Pay243',
  'INS-998': 'Marché M-Pesa invalide',
  'INS-2051': 'Numéro M-Pesa invalide',
};
const reasonFor = (j, kind) => (j.output_ResponseCode === 'INS-2006'
  ? (kind === 'disburse' ? 'Compte M-Pesa de Pay243 insuffisamment approvisionné' : 'Solde M-Pesa insuffisant')
  : REASONS[j.output_ResponseCode] || j.output_ResponseDesc || 'Échec M-Pesa');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export default function mpesaDriver(_operator, events, c = config.providers.mpesa) {
  const base = `${c.baseUrl}/${c.env === 'live' ? 'openapi' : 'sandbox'}/ipg/v2/${c.market}`;
  const lifetimeMs = c.sessionMinutes * 60_000;
  const headers = (bearer) => ({ Authorization: `Bearer ${bearer}`, Origin: c.origin, 'Content-Type': 'application/json', Accept: 'application/json' });

  function encrypt(value) {
    const b64 = String(c.publicKey || '').replace(/\s+/g, '');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
    return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(value))).toString('base64');
  }

  /* ---------- Clé de session : courante, suivante préparée d'avance, une seule demande à la fois ---------- */
  let current = null; // { id, activeAt, expiresAt }
  let next = null;
  let inflight = null;
  async function fetchSession() {
    const r = await providerFetch(`${base}/getSession/`, { headers: headers(encrypt(c.apiKey)) });
    const j = await r.json().catch(() => ({}));
    if (j.output_ResponseCode !== 'INS-0' || !j.output_SessionID) throw new ProviderError(`Session M-Pesa refusée : ${j.output_ResponseDesc || `HTTP ${r.status}`}`);
    const t = Date.now();
    return { id: j.output_SessionID, activeAt: t + c.sessionWarmupMs, expiresAt: t + lifetimeMs };
  }
  function refresh() {
    inflight ||= fetchSession().then((s) => { next = s; return s; }).finally(() => { inflight = null; });
    return inflight;
  }
  async function getSession() {
    const now = Date.now();
    if (next && next.activeAt <= now) { current = next; next = null; }
    if (current && current.expiresAt - 60_000 > now) {
      // Préparer la suivante pour qu'elle soit active avant l'expiration de celle-ci.
      if (!next && current.expiresAt - now < c.sessionWarmupMs + 120_000) refresh().catch(() => {});
      if (current.activeAt > now) await sleep(current.activeAt - now);
      return current.id;
    }
    const s = next || await refresh();
    next = null; current = s;
    if (s.activeAt > Date.now()) await sleep(s.activeAt - Date.now());
    return s.id;
  }
  function dropSession(id) {
    if (current?.id === id) current = null;
    if (next?.id === id) next = null;
  }

  async function call(path, body, { method = 'POST', timeoutMs = 30_000 } = {}) {
    let sessionId;
    try { sessionId = await getSession(); } catch (e) { throw new ProviderError(e.message); } // rien n'a été envoyé
    const url = method === 'GET' ? `${base}${path}?${new URLSearchParams(body)}` : `${base}${path}`;
    const r = await providerFetch(url, { method, headers: headers(encrypt(sessionId)), body: method === 'GET' ? undefined : JSON.stringify(body) }, timeoutMs);
    if (r.status >= 500) throw new ProviderError(`M-Pesa indisponible (HTTP ${r.status})`, { uncertain: true });
    const j = await r.json().catch(() => ({ output_ResponseDesc: `HTTP ${r.status}` }));
    return { j, sessionId };
  }

  function runInBackground(txnId, kind, path, body) {
    const attempt = async (renewed) => {
      // singleStage : la connexion reste ouverte pendant que le client valide sur son téléphone.
      const { j, sessionId } = await call(path, body, { timeoutMs: 180_000 });
      if (RENEW_SESSION_CODES.has(j.output_ResponseCode) && !renewed) { dropSession(sessionId); return attempt(true); }
      return j;
    };
    attempt(false)
      .then((j) => {
        if (UNCERTAIN_CODES.has(j.output_ResponseCode)) return; // reste "pending" : statut vérifié plus tard
        const ok = j.output_ResponseCode === 'INS-0';
        events.emit('result', { txnId, providerRef: j.output_TransactionID || undefined, status: ok ? 'succeeded' : 'failed', reason: ok ? null : `M-Pesa : ${reasonFor(j, kind)}`, raw: j });
      })
      .catch((e) => {
        if (e.uncertain) return; // coupure ou délai : l'opération a peut-être abouti, on ne conclut pas
        events.emit('result', { txnId, status: 'failed', reason: `M-Pesa : ${e.message}` });
      });
  }

  function common(txnId, phone, amount, currency) {
    if (!c.currencies.includes(currency)) throw new ProviderError(`M-Pesa n'accepte pas le ${currency} pour le moment (devises : ${c.currencies.join(', ')}).`);
    return {
      input_Amount: toMajor(amount),
      input_Country: c.country,
      input_Currency: currency,
      // Bac à sable : numéro de test imposé (ex. 000000000001 = succès), jamais en production.
      input_CustomerMSISDN: c.env !== 'live' && c.sandboxMsisdn ? c.sandboxMsisdn : phone.replace(/^\+/, ''), // 243XXXXXXXXX
      input_ServiceProviderCode: c.serviceProviderCode,
      input_ThirdPartyConversationID: mpesaConversationId(txnId),
      input_TransactionReference: mpesaReference(txnId),
    };
  }

  return {
    name: 'mpesa',
    txnIdFromReference: txnIdFromMpesaReference,
    async collect({ txnId, phone, amount, currency, description }) {
      runInBackground(txnId, 'collect', '/c2bPayment/singleStage/', { ...common(txnId, phone, amount, currency), input_PurchasedItemsDesc: mpesaText(description, 'Recharge Pay243') });
      return { status: 'pending' };
    },
    async disburse({ txnId, phone, amount, currency, description }) {
      runInBackground(txnId, 'disburse', '/b2cPayment/', { ...common(txnId, phone, amount, currency), input_PaymentItemsDesc: mpesaText(description, 'Retrait Pay243') });
      return { status: 'pending' };
    },
    parseCallback() { return []; }, // résultat obtenu de façon synchrone

    /** Statut d'une opération dont la réponse s'est perdue (recherche par n° M-Pesa, sinon par notre référence). */
    async checkStatus(txn) {
      const ref = /^[A-Za-z0-9]{1,32}$/.test(txn.provider_ref || '') ? txn.provider_ref : mpesaConversationId(txn.id);
      const { j } = await call('/queryTransactionStatus/', {
        input_QueryReference: ref,
        input_ServiceProviderCode: c.serviceProviderCode,
        input_ThirdPartyConversationID: `Q${crypto.randomBytes(12).toString('hex')}`,
        input_Country: c.country,
      }, { method: 'GET' });
      if (j.output_ResponseCode !== 'INS-0') return null; // introuvable ou erreur : on réessaiera, le rapprochement tranchera
      if (String(j.output_Reversed).toLowerCase() === 'true') return { status: 'failed', reason: 'M-Pesa : opération annulée (reversal)' };
      const st = String(j.output_ResponseTransactionStatus || '').toLowerCase();
      if (st === 'completed') return { status: 'succeeded', providerRef: j.output_OriginalTransactionID || undefined };
      if (['failed', 'cancelled', 'expired', 'declined', 'reversed'].includes(st)) return { status: 'failed', reason: `M-Pesa : ${j.output_ResponseTransactionStatus}` };
      return null;
    },
  };
}
