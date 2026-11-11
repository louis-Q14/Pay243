import { config, toUsdMinor } from './config.js';
import { q } from './db.js';
import { HttpError, formatMoney } from './util.js';

function limitsFor(user) {
  return config.kyc[user.kyc_level] || config.kyc[1];
}

/**
 * Verrouille les utilisateurs (ordre d'identifiant) jusqu'à la fin de la transaction courante.
 * À appeler dans tx() avant les contrôles de plafonds : deux opérations simultanées d'un même
 * utilisateur, même sur deux serveurs, ne peuvent pas dépasser ensemble le plafond journalier.
 */
export async function lockUsers(...ids) {
  const unique = [...new Set(ids.filter(Boolean))].sort();
  for (const id of unique) await q.get('SELECT id FROM users WHERE id=? FOR UPDATE', id);
}

/** Vérifie les plafonds par transaction et journaliers (glissants sur 24 h) pour une sortie de fonds. */
export async function checkOutgoing(user, currency, amount) {
  const lim = limitsFor(user);
  const usd = toUsdMinor(amount, currency);
  if (usd > lim.perTxnUsd * 100) {
    throw new HttpError(403, 'limit_per_transaction',
      `Plafond par opération dépassé (${formatMoney(lim.perTxnUsd * 100, 'USD')} pour le niveau "${lim.label}"). Complétez votre KYC pour l'augmenter.`);
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await q.all(
    `SELECT t.amount, t.currency FROM transactions t
       JOIN wallets w ON w.id = t.from_wallet
      WHERE w.owner_type='user' AND w.owner_id=?
        AND t.type IN ('transfer','payment','withdrawal')
        AND t.status IN ('pending','succeeded') AND t.created_at >= ?`,
    user.id, since,
  );
  const spent = rows.reduce((s, r) => s + toUsdMinor(r.amount, r.currency), 0);
  if (spent + usd > lim.dailyUsd * 100) {
    throw new HttpError(403, 'limit_daily',
      `Plafond journalier atteint (${formatMoney(lim.dailyUsd * 100, 'USD')}). Déjà utilisé : ${formatMoney(spent, 'USD')}.`);
  }
}

/** Vérifie que le solde total (contre-valeur USD) ne dépasse pas le plafond de détention. */
export async function checkIncoming(user, currency, amount) {
  const lim = limitsFor(user);
  const wallets = await q.all("SELECT balance, currency FROM wallets WHERE owner_type='user' AND owner_id=?", user.id);
  const total = wallets.reduce((s, w) => s + toUsdMinor(w.balance, w.currency), 0) + toUsdMinor(amount, currency);
  if (total > lim.maxBalanceUsd * 100) {
    throw new HttpError(403, 'limit_balance',
      `Plafond de solde dépassé (${formatMoney(lim.maxBalanceUsd * 100, 'USD')} pour le niveau "${lim.label}").`);
  }
}

export function describeLimits(user) {
  return { kyc_level: user.kyc_level, ...limitsFor(user) };
}
