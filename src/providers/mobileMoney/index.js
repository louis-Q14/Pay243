import { EventEmitter } from 'node:events';
import { config } from '../../config.js';
import { HttpError } from '../../util.js';
import mockDriver from './mock.js';
import mpesaDriver from './mpesa.js';
import airtelDriver from './airtel.js';
import aggregatorDriver from './aggregator.js';

/**
 * Bus d'événements : chaque pilote émet 'result' quand une opération se dénoue
 * (callback opérateur, réponse synchrone M-Pesa, simulation sandbox...).
 * Payload : { txnId?, providerRef?, status: 'succeeded'|'failed', reason?, raw? }
 */
export const providerEvents = new EventEmitter();

const DRIVERS = { mock: mockDriver, mpesa: mpesaDriver, airtel: airtelDriver, aggregator: aggregatorDriver };
const cache = new Map();

/**
 * Contrat d'un pilote Mobile Money :
 *  collect({ txnId, phone, amount, currency, description }) -> { providerRef?, status: 'pending' }
 *  disburse({ txnId, phone, amount, currency, description }) -> { providerRef?, status: 'pending' }
 *  parseCallback(body, query) -> [{ txnId?, providerRef?, status, reason }]
 *  checkStatus?(txn) -> { status, reason? } | null        (null = toujours en cours / inconnu)
 *  referenceFor?(txnId) -> string   référence opérateur connue AVANT l'appel (enregistrée avant envoi,
 *                                   pour qu'un callback très rapide retrouve toujours sa transaction)
 * Les erreurs levées sont des ProviderError ; `uncertain` indique un résultat inconnu.
 */
export function getProvider(operator) {
  const conf = config.providers[operator];
  if (!conf) throw new HttpError(400, 'unsupported_operator', `Opérateur inconnu : ${operator}`);
  const key = `${operator}:${conf.driver}`;
  if (!cache.has(key)) {
    const factory = DRIVERS[conf.driver];
    if (!factory) throw new Error(`Pilote inconnu "${conf.driver}" pour ${operator}`);
    cache.set(key, factory(operator, providerEvents));
  }
  return cache.get(key);
}

export function listOperators() {
  return Object.entries(config.providers).map(([id, p]) => ({ id, label: p.label, driver: p.driver }));
}

/**
 * Erreur d'un pilote. `uncertain: true` signifie que la demande a PEUT-ÊTRE été exécutée par l'opérateur
 * (coupure réseau, délai dépassé, erreur 5xx) : la transaction doit rester "pending" et être vérifiée
 * plus tard (checkStatus, puis rapprochement avec le relevé), jamais déclarée échouée d'office.
 */
export class ProviderError extends Error {
  constructor(message, { uncertain = false } = {}) {
    super(message);
    this.uncertain = uncertain;
  }
}

/** fetch avec délai maximal ; toute erreur de transport devient une ProviderError incertaine. */
export async function providerFetch(url, options = {}, timeoutMs = 30_000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `délai de ${Math.round(timeoutMs / 1000)} s dépassé` : e.message;
    throw new ProviderError(`Opérateur injoignable (${why})`, { uncertain: true });
  }
}

/** Convertit des unités mineures en montant "majeur" attendu par les API opérateurs. */
export const toMajor = (amount) => (amount / 100).toFixed(2).replace(/\.00$/, '');
