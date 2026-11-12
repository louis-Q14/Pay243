import { HttpError, newId } from '../../util.js';

/**
 * Processeur de cartes simulé (sandbox uniquement).
 * Cartes de test :
 *   4242 4242 4242 4242  Visa       -> accepté
 *   5555 5555 5555 4444  Mastercard -> accepté
 *   4000 0000 0000 0002  Visa       -> refusé par l'émetteur
 * Le jeton encode uniquement des données non sensibles (marque, 4 derniers chiffres, expiration, scénario).
 */
function luhn(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function brandOf(num) {
  if (/^4/.test(num)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'mastercard';
  if (/^3[47]/.test(num)) return 'amex';
  return 'unknown';
}

export default function mockCards() {
  return {
    name: 'mock_cards',

    /** Simule la tokenisation faite côté navigateur par le SDK du processeur. */
    tokenize({ number, exp_month, exp_year, cvc }) {
      const n = String(number || '').replace(/\D/g, '');
      const m = Number(exp_month);
      let y = Number(exp_year);
      if (y < 100) y += 2000;
      if (n.length < 13 || !luhn(n)) throw new HttpError(400, 'invalid_card_number', 'Numéro de carte invalide.');
      // Démonstration : seules les cartes de test sont acceptées, pour qu'aucune vraie carte ne soit saisie ici.
      if (!TEST_CARDS.has(n)) throw new HttpError(400, 'test_card_required', 'Mode démonstration : utilisez une carte de test (4242 4242 4242 4242). Ne saisissez jamais une vraie carte ici.');
      if (!(m >= 1 && m <= 12)) throw new HttpError(400, 'invalid_expiry', "Mois d'expiration invalide.");
      const expEnd = new Date(y, m, 1);
      if (expEnd < new Date()) throw new HttpError(400, 'card_expired', 'Carte expirée.');
      if (!/^\d{3,4}$/.test(String(cvc || ''))) throw new HttpError(400, 'invalid_cvc', 'CVC invalide.');
      const payload = { b: brandOf(n), l: n.slice(-4), m, y, o: n === '4000000000000002' ? 'decline' : 'ok' };
      return `tok_test_${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    },

    retrieveToken(token) {
      const p = decode(token);
      return { brand: p.b, last4: p.l, exp_month: p.m, exp_year: p.y };
    },

    async charge({ token }) {
      const p = decode(token);
      if (p.o === 'decline') return { status: 'failed', reason: "Carte refusée par la banque émettrice." };
      return { status: 'succeeded', providerRef: newId('ch_test') };
    },

    async refund() {
      return { status: 'succeeded', providerRef: newId('re_test') };
    },
  };
}

const TEST_CARDS = new Set(['4242424242424242', '5555555555554444', '4000000000000002']);

/** Décode et valide le jeton : son contenu vient du client, il est donc contrôlé champ par champ. */
function decode(token) {
  const invalid = () => new HttpError(400, 'invalid_card_token', 'Jeton de carte invalide.');
  if (typeof token !== 'string' || !token.startsWith('tok_test_') || token.length > 300) throw invalid();
  let p;
  try { p = JSON.parse(Buffer.from(token.slice(9), 'base64url').toString()); } catch { throw invalid(); }
  if (!p || typeof p !== 'object'
    || !['visa', 'mastercard', 'amex', 'unknown'].includes(p.b) || !/^\d{4}$/.test(String(p.l))
    || !Number.isInteger(p.m) || p.m < 1 || p.m > 12 || !Number.isInteger(p.y) || p.y < 2000 || p.y > 2100
    || !['ok', 'decline'].includes(p.o)) throw invalid();
  return { b: p.b, l: String(p.l), m: p.m, y: p.y, o: p.o };
}
