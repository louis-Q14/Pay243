import { config } from '../../config.js';
import { ProviderError, providerFetch, toMajor } from './index.js';

/**
 * Airtel Money RDC via l'Airtel Africa Open API (developers.airtel.africa).
 * Le pays et la devise sont passés dans les en-têtes X-Country / X-Currency (CD + CDF ou USD).
 * Collecte : push USSD vers le client, qui valide avec son PIN ; Airtel notifie ensuite le callback.
 *
 * ⚠ Les chemins et charges utiles suivent la documentation publique de l'Open API ; vérifiez-les
 *   contre la documentation remise lors de votre onboarding marchand Airtel RDC.
 */
export default function airtelDriver(_operator, events) {
  const c = config.providers.airtel;
  let token = null;
  let tokenExp = 0;

  async function auth() {
    if (token && Date.now() < tokenExp) return token;
    const r = await providerFetch(`${c.baseUrl}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new ProviderError(`Authentification Airtel échouée (${r.status})`);
    token = j.access_token;
    tokenExp = Date.now() + (Number(j.expires_in || 3600) - 60) * 1000;
    return token;
  }

  async function call(method, path, currency, body) {
    // Échec d'authentification : la demande n'a jamais été transmise, l'erreur est donc définitive.
    let bearer;
    try { bearer = await auth(); } catch (e) { throw new ProviderError(e.message); }
    const r = await providerFetch(`${c.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'X-Country': 'CD',
        'X-Currency': currency,
        Authorization: `Bearer ${bearer}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500) throw new ProviderError(`Airtel indisponible (HTTP ${r.status})`, { uncertain: true });
    if (!r.ok || j?.status?.success === false) {
      throw new ProviderError(j?.status?.message || `Erreur Airtel HTTP ${r.status}`);
    }
    return j;
  }

  const msisdn = (phone) => phone.replace('+243', ''); // Airtel attend le numéro sans indicatif pays

  return {
    name: 'airtel',

    async collect({ txnId, phone, amount, currency, description }) {
      const j = await call('POST', '/merchant/v1/payments/', currency, {
        reference: (description || 'Pay243').slice(0, 64),
        subscriber: { country: 'CD', currency, msisdn: msisdn(phone) },
        transaction: { amount: Number(toMajor(amount)), country: 'CD', currency, id: txnId },
      });
      return { providerRef: j?.data?.transaction?.id || txnId, status: 'pending' };
    },

    async disburse({ txnId, phone, amount, currency, description }) {
      const j = await call('POST', '/standard/v1/disbursements/', currency, {
        payee: { msisdn: msisdn(phone) },
        reference: (description || 'Retrait Pay243').slice(0, 64),
        pin: c.encryptedPin, // PIN chiffré avec la clé publique Airtel
        transaction: { amount: Number(toMajor(amount)), id: txnId },
      });
      const status = j?.data?.transaction?.status;
      if (status === 'TS') {
        setImmediate(() => events.emit('result', { txnId, providerRef: j.data.transaction.airtel_money_id, status: 'succeeded' }));
      }
      return { providerRef: j?.data?.transaction?.reference_id || null, status: 'pending' };
    },

    /** Callback Airtel : { transaction: { id, message, status_code: 'TS'|'TF', airtel_money_id } } */
    parseCallback(body) {
      const t = body?.transaction;
      if (!t?.id) return [];
      return [{
        txnId: t.id,
        providerRef: t.airtel_money_id,
        status: t.status_code === 'TS' ? 'succeeded' : 'failed',
        reason: t.status_code === 'TS' ? null : t.message,
      }];
    },

    /** Interrogation de statut (filet de sécurité si le callback n'arrive pas). */
    async checkStatus(txn) {
      const path = ['topup', 'payment'].includes(txn.type) ? `/standard/v1/payments/${txn.id}` : `/standard/v1/disbursements/${txn.id}`;
      const j = await call('GET', path, txn.currency);
      const s = j?.data?.transaction?.status;
      if (s === 'TS') return { status: 'succeeded' };
      if (s === 'TF') return { status: 'failed', reason: j?.data?.transaction?.message || 'Échec Airtel' };
      return null; // TIP / TA : toujours en cours
    },
  };
}
