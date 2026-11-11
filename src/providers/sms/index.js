import { config } from '../../config.js';

/**
 * Contrat d'un fournisseur SMS :
 *   send({ to, message }) -> Promise<{ providerRef? }>   (lève une erreur si l'envoi échoue)
 * `to` est au format E.164 (+243XXXXXXXXX).
 */

/** Sandbox : aucun SMS réel, le message est affiché dans la console du serveur. */
function mockSms() {
  return {
    name: 'mock',
    async send({ to, message }) {
      if (!process.env.NODE_TEST_CONTEXT) console.log(`[sms:mock] → ${to} : ${message}`);
      return { providerRef: `mock_${Date.now()}` };
    },
  };
}

/**
 * Africa's Talking (couvre Vodacom, Airtel, Orange et Africell en RDC).
 * Doc : https://developers.africastalking.com/docs/sms/sending — à valider lors de l'onboarding
 * (expéditeur alphanumérique, tarifs, routes par opérateur).
 */
function africasTalking() {
  const c = config.sms.africastalking;
  const host = c.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  return {
    name: 'africastalking',
    async send({ to, message }) {
      if (!c.apiKey) throw new Error('AT_API_KEY manquant');
      const body = new URLSearchParams({ username: c.username, to, message });
      if (c.senderId) body.set('from', c.senderId);
      const r = await fetch(`${host}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json().catch(() => ({}));
      const rec = j?.SMSMessageData?.Recipients?.[0];
      if (!r.ok || !rec || ![100, 101, 102].includes(rec.statusCode)) {
        throw new Error(rec?.status || j?.SMSMessageData?.Message || `HTTP ${r.status}`);
      }
      return { providerRef: rec.messageId };
    },
  };
}

const DRIVERS = { mock: mockSms, africastalking: africasTalking };

let instance;
export function smsProvider() {
  if (!instance) {
    const factory = DRIVERS[config.sms.driver];
    if (!factory) throw new Error(`Pilote SMS inconnu : ${config.sms.driver}`);
    instance = factory();
  }
  return instance;
}
