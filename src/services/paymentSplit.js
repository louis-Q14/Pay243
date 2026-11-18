/**
 * Répartition des paiements d'une plateforme (place de marché) : chaque paiement peut porter le détail de ses
 * lignes de vente — montant, part de la plateforme (commission, frais…), part du vendeur, vente libérée ou non.
 *
 *  - argent des vendeurs réservé = part vendeur des lignes ni libérées ni remboursées ; il ne sort jamais du solde ;
 *  - revenus de la plateforme    = net encaissé (après frais Pay243 et remboursements) − part des vendeurs ;
 *  - retirable                   = min(revenus − revenus déjà retirés, solde − argent réservé).
 *
 * Un marchand qui n'envoie aucune répartition n'est pas concerné : tout son solde reste retirable.
 * Montants en unités mineures.
 */
import { q } from '../db.js';
import { HttpError, parseJson } from '../util.js';

const REF_RE = /^[\w.\-/#:]{1,64}$/;
const FEE_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const KEPT = ['succeeded', 'partially_refunded']; // paiements dont l'argent est encore chez le marchand
export const PURPOSES = ['platform_revenue', 'seller_payout'];

const bad = (msg) => new HttpError(400, 'invalid_breakdown', `breakdown : ${msg}`);
const minor = (v, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw bad(`${field} doit être un entier positif (unités mineures).`);
  return n;
};

/** Valide la répartition envoyée par le marchand. null si absente ; [] l'efface. */
export function parseBreakdown(raw, paymentAmount) {
  if (raw === undefined) return null;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw bad('tableau de lignes attendu.');
  if (raw.length > 50) throw bad('50 lignes au maximum.');
  const lines = raw.map((l, i) => {
    if (typeof l !== 'object' || l === null) throw bad(`ligne ${i + 1} invalide.`);
    const ref = String(l.ref ?? '').trim();
    if (!REF_RE.test(ref)) throw bad(`ligne ${i + 1} : ref invalide (1 à 64 caractères : lettres, chiffres, - _ . / # :).`);
    const amount = minor(l.amount, `ligne ${i + 1} amount`);
    const platform = minor(l.platform_amount ?? 0, `ligne ${i + 1} platform_amount`);
    const seller = minor(l.seller_amount ?? 0, `ligne ${i + 1} seller_amount`);
    if (platform + seller > amount) throw bad(`ligne ${i + 1} : platform_amount + seller_amount dépasse amount.`);
    const fees = {};
    if (l.fees != null) {
      if (typeof l.fees !== 'object' || Array.isArray(l.fees) || Object.keys(l.fees).length > 10) throw bad(`ligne ${i + 1} : fees doit être un objet de 10 clés maximum.`);
      for (const [k, v] of Object.entries(l.fees)) {
        if (!FEE_KEY_RE.test(k)) throw bad(`ligne ${i + 1} : nom de frais « ${k.slice(0, 40)} » invalide.`);
        fees[k] = minor(v, `ligne ${i + 1} fees.${k}`);
      }
    }
    return {
      ref,
      label: l.label ? String(l.label).slice(0, 120) : null,
      seller: l.seller ? String(l.seller).slice(0, 120) : null,
      amount, platform_amount: platform, seller_amount: seller, fees,
      released: !!l.released,
      refunded: !!l.refunded,
    };
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (paymentAmount != null && total > Number(paymentAmount)) throw bad(`le total des lignes (${total}) dépasse le montant du paiement (${paymentAmount}).`);
  return lines;
}

/** Répartition calculée d'un paiement (null s'il n'en a pas). */
export function splitOf(p) {
  const lines = parseJson(p.breakdown, null);
  if (!Array.isArray(lines) || !lines.length) return null;
  const kept = KEPT.includes(p.status);
  const paid = kept || p.status === 'refunded';
  const active = lines.filter((l) => !l.refunded);
  const sellerTotal = kept ? active.reduce((s, l) => s + l.seller_amount, 0) : 0;
  const sellerDue = kept ? active.filter((l) => !l.released).reduce((s, l) => s + l.seller_amount, 0) : 0;
  const linesTotal = lines.reduce((s, l) => s + l.amount, 0);
  const feeTotals = {};
  for (const l of active) for (const [k, v] of Object.entries(l.fees || {})) feeTotals[k] = (feeTotals[k] || 0) + v;
  const net = paid ? Number(p.amount) - Number(p.fee) - Number(p.refunded_amount || 0) : null;
  return {
    lines,
    lines_total: linesTotal,
    extra: Number(p.amount) - linesTotal, // frais ajoutés au panier (ex. frais de paiement refacturés à l'acheteur)
    pay243_fee: Number(p.fee),
    platform_gross: active.reduce((s, l) => s + l.platform_amount, 0),
    fees: feeTotals,
    seller_total: sellerTotal,
    seller_due: sellerDue,
    seller_released: sellerTotal - sellerDue,
    platform_net: net == null ? null : net - sellerTotal,
  };
}

/** État des revenus d'un marchand dans une devise ; walletBalance permet de passer un solde verrouillé. */
export async function revenueState(merchantId, currency, walletBalance) {
  const balance = walletBalance ?? Number((await q.get("SELECT balance FROM wallets WHERE owner_type='merchant' AND owner_id=? AND currency=?", merchantId, currency))?.balance || 0);
  const split = await q.all(`SELECT id, amount, fee, refunded_amount, status, breakdown FROM payments
                              WHERE merchant_id=? AND currency=? AND breakdown IS NOT NULL AND breakdown <> '[]'
                                AND status IN ('succeeded','partially_refunded','refunded')`, merchantId, currency);
  if (!split.length) return { currency, has_split: false, balance, seller_due: 0, available: balance };
  const kept = await q.get(`SELECT COALESCE(SUM(amount - fee - refunded_amount),0)::bigint AS net FROM payments
                             WHERE merchant_id=? AND currency=? AND status IN ('succeeded','partially_refunded','refunded')`, merchantId, currency);
  const withdrawn = await q.get(`SELECT COALESCE(SUM(amount + fee),0)::bigint AS total FROM transactions
                                  WHERE merchant_id=? AND currency=? AND type='payout' AND status <> 'failed'
                                    AND metadata LIKE '%"purpose":"platform_revenue"%'`, merchantId, currency);
  let sellerTotal = 0, sellerDue = 0;
  for (const p of split) {
    const s = splitOf(p);
    if (s) { sellerTotal += s.seller_total; sellerDue += s.seller_due; }
  }
  const earned = Number(kept.net) - sellerTotal;
  const platformWithdrawn = Number(withdrawn.total);
  const free = balance - sellerDue;
  return {
    currency,
    has_split: true,
    balance,
    seller_due: sellerDue,                       // argent des vendeurs réservé (ventes non libérées)
    shortfall: Math.max(0, -free),               // argent des vendeurs qui manque dans le solde
    platform_earned: earned,                     // revenus plateforme cumulés
    platform_withdrawn: platformWithdrawn,       // revenus déjà retirés
    available: Math.max(0, Math.min(free, earned - platformWithdrawn)), // revenus retirables maintenant
    seller_payable: Math.max(0, free),           // utilisable pour reverser des vendeurs (ventes libérées)
  };
}

/**
 * Contrôle d'une sortie d'argent du solde marchand (versement vers le wallet, payout Mobile Money).
 * debit = montant + frais. purpose : 'platform_revenue' (par défaut) ou 'seller_payout'.
 */
export async function assertWithdrawal(merchantId, currency, debit, purpose, walletBalance) {
  const st = await revenueState(merchantId, currency, walletBalance);
  if (!st.has_split) return st;
  const fmt = (n) => `${(n / 100).toFixed(2).replace('.', ',')} ${currency}`;
  if (purpose === 'seller_payout') {
    if (debit > st.seller_payable) {
      throw new HttpError(402, 'seller_funds_reserved', `Reversement impossible : ${fmt(st.seller_due)} sont réservés aux ventes non libérées ; ${fmt(st.seller_payable)} utilisables.`);
    }
  } else if (debit > st.available) {
    throw new HttpError(402, 'seller_funds_reserved', st.shortfall
      ? `Retrait impossible : il manque ${fmt(st.shortfall)} pour couvrir l'argent des vendeurs (${fmt(st.seller_due)} réservés).`
      : `Retrait limité à vos revenus disponibles : ${fmt(st.available)} (${fmt(st.seller_due)} réservés aux vendeurs).`);
  }
  return st;
}

export const purposeOf = (v) => (PURPOSES.includes(String(v)) ? String(v) : 'platform_revenue');
