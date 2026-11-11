import { config } from '../../config.js';
import mockCards from './mock.js';

/**
 * Contrat d'un processeur de cartes (acquéreur ou PSP certifié PCI DSS) :
 *  retrieveToken(token) -> { brand, last4, exp_month, exp_year }
 *  charge({ token, amount, currency, txnId, description }) -> { status: 'succeeded'|'failed', providerRef?, reason? }
 *  refund({ providerRef, amount, currency }) -> { status }
 *
 * IMPORTANT : le numéro de carte ne transite JAMAIS par les serveurs Pay243. Il est saisi dans
 * les champs hébergés / le SDK du processeur, qui renvoie un jeton. Pay243 ne stocke que ce jeton.
 * En production, branchez ici votre acquéreur local (via CyberSource, Mastercard Gateway, etc.)
 * ou un PSP panafricain, avec authentification 3-D Secure.
 */
const DRIVERS = { mock: mockCards };

let instance;
export function cardProcessor() {
  if (!instance) {
    const factory = DRIVERS[config.cards.driver];
    if (!factory) throw new Error(`Pilote cartes inconnu : ${config.cards.driver}`);
    instance = factory();
  }
  return instance;
}
