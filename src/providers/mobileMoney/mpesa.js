import crypto from 'node:crypto';
import { config } from '../../config.js';
import { ProviderError, providerFetch, toMajor } from './index.js';

/**
 * Vodacom M-Pesa RDC via l'M-Pesa Open API (marché "vodacomDRC", pays "DRC").
 * Authentification : la clé API est chiffrée en RSA avec la clé publique du portail pour obtenir
 * une clé de session, elle-même chiffrée à chaque requête.
 * Le C2B "singleStage" est synchrone : l'appel HTTP reste ouvert jusqu'à la validation du client
 * sur son téléphone. Il est donc lancé en arrière-plan et le résultat est publié sur le bus d'événements.
 *
 * ⚠ Vodacom RDC exige le whitelisting de l'IP publique de vos serveurs. Certains marchands sont
 *   encore raccordés à l'ancienne passerelle IPG (SOAP) : dans ce cas, adaptez ce pilote ou
 *   passez par un agrégateur (MPESA_DRIVER=aggregator).
 */
export default function mpesaDriver(_operator, events) {
  const c = config.providers.mpesa;
  const base = `https://${c.host}/${c.env === 'live' ? 'openapi' : 'sandbox'}/ipg/v2/vodacomDRC`;
  let session = null;
  let sessionExp = 0;

  function encrypt(value) {
    const b64 = String(c.publicKey || '').replace(/\s+/g, '');
    const pem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
    return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64');
  }

  async function getSession() {
    if (session && Date.now() < sessionExp) return session;
    const r = await providerFetch(`${base}/getSession/`, {
      headers: { Authorization: `Bearer ${encrypt(c.apiKey)}`, Origin: '*', 'Content-Type': 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (j.output_ResponseCode !== 'INS-0') throw new ProviderError(`Session M-Pesa refusée : ${j.output_ResponseDesc || r.status}`);
    session = j.output_SessionID;
    sessionExp = Date.now() + 50 * 60 * 1000;
    await new Promise((res) => setTimeout(res, 3000)); // la session n'est active qu'après quelques secondes
    return session;
  }

  // Codes dont l'issue est inconnue (délai dépassé, erreur interne) : à confirmer par queryTransactionStatus.
  // ⚠ Liste à valider avec la documentation Vodacom RDC remise à l'onboarding.
  const UNCERTAIN_CODES = ['INS-1', 'INS-9'];

  async function call(path, body, { method = 'POST', timeoutMs = 30_000 } = {}) {
    let sessionId;
    try { sessionId = await getSession(); } catch (e) { throw new ProviderError(e.message); } // rien n'a été envoyé
    const url = method === 'GET' ? `${base}${path}?${new URLSearchParams(body)}` : `${base}${path}`;
    const r = await providerFetch(url, {
      method,
      headers: { Authorization: `Bearer ${encrypt(sessionId)}`, Origin: '*', 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }, timeoutMs);
    if (r.status >= 500) throw new ProviderError(`M-Pesa indisponible (HTTP ${r.status})`, { uncertain: true });
    return r.json().catch(() => ({ output_ResponseDesc: `HTTP ${r.status}` }));
  }

  function runInBackground(txnId, path, body) {
    // singleStage : la connexion reste ouverte pendant que le client valide sur son téléphone.
    call(path, body, { timeoutMs: 180_000 })
      .then((j) => {
        if (UNCERTAIN_CODES.includes(j.output_ResponseCode)) return; // reste "pending" : statut vérifié plus tard
        events.emit('result', {
          txnId,
          providerRef: j.output_TransactionID,
          status: j.output_ResponseCode === 'INS-0' ? 'succeeded' : 'failed',
          reason: j.output_ResponseCode === 'INS-0' ? null : (j.output_ResponseDesc || 'Échec M-Pesa'),
          raw: j,
        });
      })
      .catch((e) => {
        if (e.uncertain) return; // coupure ou délai : l'opération a peut-être abouti, on ne conclut pas
        events.emit('result', { txnId, status: 'failed', reason: `M-Pesa : ${e.message}` });
      });
  }

  const common = (txnId, phone, amount, currency) => ({
    input_Amount: toMajor(amount),
    input_Country: 'DRC',
    input_Currency: currency,
    input_CustomerMSISDN: phone.replace('+', ''), // 243XXXXXXXXX
    input_ServiceProviderCode: c.serviceProviderCode,
    input_ThirdPartyConversationID: txnId,
    input_TransactionReference: txnId.replace(/[^A-Za-z0-9]/g, '').slice(-20),
  });

  return {
    name: 'mpesa',
    async collect({ txnId, phone, amount, currency, description }) {
      runInBackground(txnId, '/c2bPayment/singleStage/', {
        ...common(txnId, phone, amount, currency),
        input_PurchasedItemsDesc: (description || 'Recharge Pay243').slice(0, 64),
      });
      return { status: 'pending' };
    },
    async disburse({ txnId, phone, amount, currency, description }) {
      runInBackground(txnId, '/b2cPayment/singleStage/', {
        ...common(txnId, phone, amount, currency),
        input_PaymentItemsDesc: (description || 'Retrait Pay243').slice(0, 64),
      });
      return { status: 'pending' };
    },
    parseCallback() { return []; }, // résultat obtenu de façon synchrone

    /**
     * Statut d'une opération dont la réponse s'est perdue.
     * ⚠ Valeurs de output_ResponseTransactionStatus à valider avec Vodacom RDC.
     */
    async checkStatus(txn) {
      const j = await call('/queryTransactionStatus/', {
        input_QueryReference: txn.id,
        input_ServiceProviderCode: c.serviceProviderCode,
        input_ThirdPartyConversationID: `${txn.id}_q${Date.now()}`,
        input_Country: 'DRC',
      }, { method: 'GET' });
      if (j.output_ResponseCode !== 'INS-0') return null;
      const st = String(j.output_ResponseTransactionStatus || '').toLowerCase();
      if (st === 'completed') return { status: 'succeeded' };
      if (['failed', 'cancelled', 'expired', 'declined', 'reversed'].includes(st)) return { status: 'failed', reason: `M-Pesa : ${j.output_ResponseTransactionStatus}` };
      return null;
    },
  };
}
