import { config } from '../config.js';
import { simSwapProvider } from '../providers/simSwap/index.js';
import { HttpError } from '../util.js';
import { notifyUser } from './notify.js';

// Résultats récents par numéro : évite un appel opérateur à chaque opération d'une même session.
const CACHE_MS = 10 * 60_000;
const cache = new Map(); // phone -> { swapped, at }
// Une seule alerte par numéro et par jour, même si l'utilisateur (ou l'escroc) réessaie.
const ALERT_MS = 24 * 3600_000;
const alerted = new Map(); // phone -> at

const ACTIONS = { withdrawal: 'Retrait', transfer: 'Envoi', payment: 'Paiement' };
const log = (msg) => { if (!process.env.NODE_TEST_CONTEXT) console.warn(msg); };

/**
 * Refuse une sortie d'argent si la carte SIM du numéro du compte a changé récemment.
 * Ne bloque jamais quand le contrôle est impossible (pas de numéro, opérateur non couvert, panne) :
 * c'est une protection supplémentaire, pas une condition pour utiliser Pay243.
 * À appeler APRÈS la vérification du PIN : sans le bon PIN, on ne révèle rien et on n'interroge pas l'opérateur.
 */
export async function assertNoRecentSimSwap(user, action) {
  const phone = user.phone;
  const provider = simSwapProvider();
  if (!phone || !provider.supports(phone)) return;
  const maxAgeHours = config.simSwap.maxAgeHours;

  let hit = cache.get(phone);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    try {
      const r = await provider.check({ phone, maxAgeHours });
      if (r.unsupported) return;
      hit = { swapped: r.swapped, at: Date.now() };
      cache.set(phone, hit);
    } catch (e) {
      log(`[sim-swap] contrôle impossible pour ${phone.slice(0, 7)}… (${e.message}) : opération autorisée`);
      return;
    }
  }
  if (!hit.swapped) return;

  log(`[sim-swap] ${ACTIONS[action] || action} bloqué : SIM changée depuis moins de ${maxAgeHours} h (utilisateur ${user.id})`);
  if (!(Date.now() - (alerted.get(phone) || 0) < ALERT_MS)) {
    alerted.set(phone, Date.now());
    notifyUser(user, 'security', 'Opérations suspendues : changement de carte SIM',
      `La carte SIM de votre numéro ${phone} a été changée récemment. Par sécurité, les retraits, envois et paiements depuis votre wallet sont suspendus pendant ${maxAgeHours} h. Si vous n'avez pas changé de SIM, contactez immédiatement Pay243 et votre opérateur.`, {
        title: 'Opérations suspendues par sécurité',
        paragraphs: [
          `Votre opérateur nous indique que la carte SIM du ${phone} a été changée il y a moins de ${maxAgeHours} heures.`,
          'Pour protéger votre argent, les retraits, envois et paiements depuis votre wallet sont suspendus pendant ce délai. Vos fonds restent en sécurité et les recharges fonctionnent normalement.',
          "Si vous n'avez pas changé de carte SIM vous-même, quelqu'un tente peut-être de prendre le contrôle de votre compte : contactez immédiatement le support Pay243 et votre opérateur.",
        ],
      });
  }
  throw new HttpError(403, 'sim_swap_hold',
    `Par sécurité, les retraits, envois et paiements sont suspendus pendant ${maxAgeHours} h après un changement de carte SIM sur votre numéro. Si vous n'avez pas changé de SIM, contactez le support Pay243.`);
}

/** Pour les tests : oublie les résultats et alertes en mémoire. */
export function resetSimSwapCache() { cache.clear(); alerted.clear(); }
