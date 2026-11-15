import { config } from '../../config.js';
import { detectOperator } from '../../util.js';

/**
 * Détection des changements de carte SIM (CAMARA « SIM Swap »).
 * Un numéro dont la SIM vient d'être remplacée est le signe classique d'un vol de compte : l'escroc obtient
 * une nouvelle SIM au nom de la victime, reçoit ses codes SMS, puis vide le wallet.
 *
 * Contrat d'un pilote :
 *   supports(phone) -> boolean              le pilote sait-il interroger ce numéro ?
 *   check({ phone, maxAgeHours }) -> Promise<{ swapped: boolean } | { unsupported: true }>
 *     swapped : la SIM a changé dans les `maxAgeHours` dernières heures.
 *     Lève une erreur si l'opérateur ne répond pas (le service appelant décide quoi faire).
 * `phone` est au format E.164 (+243XXXXXXXXX).
 */

/** Sandbox : aucun appel externe. Les numéros listés dans SIMSWAP_MOCK_SWAPPED sont considérés comme « SIM changée ». */
function mockSimSwap() {
  return {
    name: 'mock',
    supports: () => true,
    async check({ phone }) {
      return { swapped: config.simSwap.mockSwapped.includes(phone) };
    },
  };
}

/**
 * Orange Network APIs (GSMA Open Gateway / CAMARA), aujourd'hui dans leur Playground :
 * https://docs.developer.orange.com/network-apis/api-catalog/sim-swap/playground/current/getting-started
 * Jeton OAuth2 « client_credentials » (valable 1 h), puis POST /sim-swap/v1/check { phoneNumber, maxAge (heures) }.
 *
 * ⚠ Le Playground ne connaît que des numéros fictifs (+990…) : les numéros des clients ne lui sont jamais envoyés.
 * ⚠ En production, Orange exige l'OAuth2 « 3 étapes » (consentement de l'abonné) pour SIM Swap : ce pilote
 *   devra être adapté le jour où l'API sera ouverte chez Orange RDC (à confirmer avec Orange).
 */
export function orangeSimSwap(c = config.simSwap.orange) {
  const playground = /\/playground\b/.test(c.baseUrl);
  let token = null; // { value, expiresAt }

  async function getToken() {
    if (token && token.expiresAt > Date.now()) return token.value;
    if (!c.clientId || !c.clientSecret) throw new Error('ORANGE_NETAPI_CLIENT_ID / ORANGE_NETAPI_CLIENT_SECRET manquants');
    const r = await fetch(c.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(c.timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`jeton Orange refusé (HTTP ${r.status}${j.error ? ` ${j.error}` : ''})`);
    // marge d'une minute : un jeton qui expire pendant l'appel déclencherait un 401
    token = { value: j.access_token, expiresAt: Date.now() + Math.max(0, (Number(j.expires_in) || 3600) - 60) * 1000 };
    return token.value;
  }

  async function call(phone, maxAgeHours, retry = true) {
    const r = await fetch(`${c.baseUrl}/sim-swap/v1/check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, maxAge: maxAgeHours }),
      signal: AbortSignal.timeout(c.timeoutMs),
    });
    if (r.status === 401 && retry) { token = null; return call(phone, maxAgeHours, false); } // jeton révoqué ou expiré
    const j = await r.json().catch(() => ({}));
    if (r.status === 422) return { unsupported: true }; // NOT_SUPPORTED : numéro hors du réseau couvert
    if (!r.ok || typeof j.swapped !== 'boolean') throw new Error(`SIM Swap Orange : HTTP ${r.status}${j.code ? ` ${j.code}` : ''}`);
    return { swapped: j.swapped };
  }

  return {
    name: 'orange',
    playground,
    // Playground : uniquement ses numéros fictifs. Réseau réel : uniquement les abonnés Orange RDC.
    supports: (phone) => (playground ? /^\+990\d+$/.test(phone) : safeOperator(phone) === 'orange'),
    check: ({ phone, maxAgeHours }) => call(phone, maxAgeHours),
  };
}

function safeOperator(phone) {
  try { return detectOperator(phone); } catch { return null; }
}

/** Contrôle désactivé. */
function off() {
  return { name: 'off', supports: () => false, async check() { return { unsupported: true }; } };
}

const DRIVERS = { off, mock: mockSimSwap, orange: () => orangeSimSwap() };

let instance;
export function simSwapProvider() {
  if (!instance) {
    const factory = DRIVERS[config.simSwap.driver];
    if (!factory) throw new Error(`Pilote SIM Swap inconnu : ${config.simSwap.driver}`);
    instance = factory();
  }
  return instance;
}
