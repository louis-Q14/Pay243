import { config } from '../../config.js';
import { ProviderError } from './index.js';

/**
 * Opérateur simulé pour le sandbox. Conventions de test (fin du numéro) :
 *  - 0000 -> le client refuse / solde opérateur insuffisant (échec)
 *  - 9999 -> succès, mais le callback se perd : seule l'interrogation de statut le révèle
 *  - 8888 -> l'appel « expire » côté Pay243 alors que l'opérateur a bien exécuté l'opération
 *  - 7777 -> aucune réponse ni statut connu : la transaction reste bloquée (rapprochement requis)
 *  - autre -> succès après MOCK_DELAY_MS
 */
export default function mockDriver(operator, events) {
  const outcomes = new Map(); // txnId -> { status, reason } tel que l'opérateur le connaît

  function simulate(txnId, phone, kind) {
    const providerRef = `mock_${operator}_${txnId}`;
    const fails = phone.endsWith('0000');
    const outcome = {
      status: fails ? 'failed' : 'succeeded',
      reason: fails
        ? (kind === 'collect' ? 'Le client a refusé la demande ou son solde opérateur est insuffisant.' : "Numéro bénéficiaire invalide chez l'opérateur.")
        : null,
    };
    if (phone.endsWith('7777')) return { providerRef, status: 'pending' };
    // Le statut n'est définitif chez l'opérateur qu'après la validation (simulée) du client.
    outcomes.set(txnId, { ...outcome, at: Date.now() + config.mockDelayMs });
    if (phone.endsWith('8888')) throw new ProviderError('Opérateur injoignable (délai de 30 s dépassé)', { uncertain: true });
    if (!phone.endsWith('9999')) {
      setTimeout(() => events.emit('result', { txnId, providerRef, ...outcome }), config.mockDelayMs).unref?.();
    }
    return { providerRef, status: 'pending' };
  }

  return {
    name: `mock_${operator}`,
    referenceFor: (txnId) => `mock_${operator}_${txnId}`,
    async collect({ txnId, phone }) { return simulate(txnId, phone, 'collect'); },
    async disburse({ txnId, phone }) { return simulate(txnId, phone, 'disburse'); },
    parseCallback() { return []; },
    async checkStatus(txn) {
      const o = outcomes.get(txn.id);
      return o && Date.now() >= o.at ? { status: o.status, reason: o.reason } : null;
    },
  };
}
