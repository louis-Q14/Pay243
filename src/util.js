import crypto from 'node:crypto';
import { config } from './config.js';

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
export const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalise un numéro congolais au format E.164 : +243XXXXXXXXX.
 * Accepte : 0812345678, 812345678, 243812345678, +243 81 234 5678, 00243...
 */
export function normalizePhone(input) {
  if (!input) throw new HttpError(400, 'invalid_phone', 'Numéro de téléphone requis.');
  let d = String(input).replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('243')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^\d{9}$/.test(d)) {
    throw new HttpError(400, 'invalid_phone', `Numéro invalide : "${input}". Format attendu : 0812345678 ou +243812345678.`);
  }
  return `+243${d}`;
}

// Préfixes mobiles RDC (2 premiers chiffres du numéro national à 9 chiffres).
// À tenir à jour avec le plan de numérotation de l'ARPTC.
const OPERATOR_PREFIXES = {
  mpesa: ['81', '82', '83'], // Vodacom
  airtel: ['97', '98', '99'],
  orange: ['80', '84', '85', '89'],
  africell: ['90', '91'],
};

export function detectOperator(phone) {
  const national = normalizePhone(phone).slice(4, 6);
  for (const [op, prefixes] of Object.entries(OPERATOR_PREFIXES)) {
    if (prefixes.includes(national)) return op;
  }
  return null;
}

export function assertCurrency(currency) {
  const c = String(currency || '').toUpperCase();
  if (!config.currencies.includes(c)) {
    throw new HttpError(400, 'invalid_currency', `Devise non supportée : ${currency}. Devises acceptées : CDF, USD.`);
  }
  return c;
}

/** Les montants sont des entiers en unités mineures (centimes). 1000 USD = 10,00 $ ; 500000 CDF = 5 000 FC. */
export function assertAmount(amount) {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new HttpError(400, 'invalid_amount', 'Le montant doit être un entier positif en unités mineures (ex : 1000 = 10,00).');
  }
  return n;
}

/** Normalise une adresse email (minuscules, sans espaces) et vérifie son format. */
export function normalizeEmail(input) {
  const e = String(input || '').trim().toLowerCase();
  if (!e) throw new HttpError(400, 'invalid_email', 'Adresse email requise.');
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) {
    throw new HttpError(400, 'invalid_email', `Adresse email invalide : "${input}".`);
  }
  return e;
}

export const isEmail = (s) => String(s || '').includes('@');

export function percentFee(amount, percent) {
  return Math.round((amount * percent) / 100);
}

export function formatMoney(amount, currency) {
  const major = amount / 100;
  return currency === 'USD'
    ? `${major.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`
    : `${major.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} FC`;
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function parseJson(s, fallback = null) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
