import crypto from 'node:crypto';
import { config } from '../../config.js';
import { ProviderError, providerFetch, toMajor } from './index.js';

/**
 * Pilote "agrégateur" : une seule intégration couvrant Vodacom M-Pesa, Airtel Money et Orange Money RDC.
 * Écrit sur le modèle de l'API Deposits/Payouts de pawaPay (v1) ; adaptez les champs si vous utilisez
 * un autre agrégateur (FlexPay, MaxiCash, CinetPay...). C'est la voie la plus rapide pour Orange Money RDC,
 * dont l'accès API direct se négocie au cas par cas avec l'opérateur.
 *
 * ⚠ Vérifiez les codes "correspondent" et la version d'API auprès de votre agrégateur.
 */
const CORRESPONDENTS = {
  mpesa: 'VODACOM_MPESA_COD',
  airtel: 'AIRTEL_COD',
  orange: 'ORANGE_COD',
};

export default function aggregatorDriver(operator) {
  const a = config.aggregator;

  async function call(path, body, method = 'POST') {
    const r = await providerFetch(`${a.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${a.apiToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status >= 500) throw new ProviderError(`Agrégateur indisponible (HTTP ${r.status})`, { uncertain: true });
    // DUPLICATE_IGNORED : la même référence a déjà été reçue (réessai après coupure) : ce n'est pas un échec.
    if (!r.ok || j.status === 'REJECTED') {
      throw new ProviderError(j?.rejectionReason?.rejectionMessage || `Agrégateur : HTTP ${r.status}`);
    }
    return j;
  }

  /** Référence déterministe (UUID dérivé de l'identifiant Pay243) : connue avant l'envoi, sûre en cas de réessai. */
  const referenceFor = (txnId) => {
    const h = crypto.createHash('sha256').update(`kongowallet:${txnId}`) /* préfixe historique : références déjà transmises */.digest('hex');
    const variant = ((parseInt(h[16], 16) & 3) | 8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  const party = (phone) => ({ type: 'MSISDN', address: { value: phone.replace('+', '') } });

  return {
    name: `aggregator_${operator}`,
    referenceFor,
    async collect({ txnId, phone, amount, currency, description }) {
      const depositId = referenceFor(txnId);
      await call('/deposits', {
        depositId,
        amount: toMajor(amount),
        currency,
        correspondent: CORRESPONDENTS[operator],
        payer: party(phone),
        customerTimestamp: new Date().toISOString(),
        statementDescription: (description || 'Pay243').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22),
      });
      return { providerRef: depositId, status: 'pending' };
    },
    async disburse({ txnId, phone, amount, currency, description }) {
      const payoutId = referenceFor(txnId);
      await call('/payouts', {
        payoutId,
        amount: toMajor(amount),
        currency,
        correspondent: CORRESPONDENTS[operator],
        recipient: party(phone),
        customerTimestamp: new Date().toISOString(),
        statementDescription: (description || 'Pay243').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22),
      });
      return { providerRef: payoutId, status: 'pending' };
    },
    /** Callback : { depositId | payoutId, status: 'COMPLETED' | 'FAILED', failureReason } */
    parseCallback(body) {
      const ref = body?.depositId || body?.payoutId;
      if (!ref || !['COMPLETED', 'FAILED'].includes(body.status)) return [];
      return [{
        providerRef: ref,
        status: body.status === 'COMPLETED' ? 'succeeded' : 'failed',
        reason: body.failureReason?.failureMessage || null,
      }];
    },
    /** GET /deposits/{id} ou /payouts/{id} : renvoie une liste avec le statut courant. */
    async checkStatus(txn) {
      const kind = ['topup', 'payment'].includes(txn.type) ? 'deposits' : 'payouts';
      const j = await call(`/${kind}/${txn.provider_ref || referenceFor(txn.id)}`, null, 'GET');
      const d = Array.isArray(j) ? j[0] : j;
      if (d?.status === 'COMPLETED') return { status: 'succeeded' };
      if (d?.status === 'FAILED') return { status: 'failed', reason: d.failureReason?.failureMessage || 'Échec opérateur' };
      return null;
    },
  };
}
