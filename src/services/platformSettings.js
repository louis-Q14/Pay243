// Paramètres de la plateforme modifiables à chaud depuis le back-office (super administrateur).
// Les valeurs sont stockées en base et appliquées à `config` sur chaque instance (rechargement périodique).
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { HttpError, now, parseJson } from '../util.js';

const num = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, 'invalid_setting', `Valeur attendue entre ${min} et ${max}.`);
  return n;
};
const bool = (v) => {
  if (typeof v !== 'boolean') throw new HttpError(400, 'invalid_setting', 'Valeur attendue : true ou false.');
  return v;
};

/** Paramètres connus : libellé, validation, lecture et application à la configuration. */
export const SETTINGS = {
  'fx.usd_to_cdf': { label: 'Taux USD → CDF', unit: 'FC pour 1 $', parse: num(100, 100000), get: () => config.fx.usdToCdf, set: (v) => { config.fx.usdToCdf = v; } },
  'fx.spread_percent': { label: 'Marge de change', unit: '%', parse: num(0, 10), get: () => config.fx.spreadPercent, set: (v) => { config.fx.spreadPercent = v; } },
  'fees.merchant_percent': { label: 'Commission marchands', unit: '%', parse: num(0, 15), get: () => config.fees.merchantPercent, set: (v) => { config.fees.merchantPercent = v; } },
  'fees.withdrawal_percent': { label: 'Frais de retrait Mobile Money', unit: '%', parse: num(0, 10), get: () => config.fees.withdrawalPercent, set: (v) => { config.fees.withdrawalPercent = v; } },
  ...Object.fromEntries([1, 2, 3].flatMap((lvl) => [
    [`kyc.${lvl}.per_txn_usd`, { label: `Niveau ${lvl} — plafond par opération`, unit: '$', parse: num(1, 1_000_000), get: () => config.kyc[lvl].perTxnUsd, set: (v) => { config.kyc[lvl].perTxnUsd = v; } }],
    [`kyc.${lvl}.daily_usd`, { label: `Niveau ${lvl} — plafond journalier`, unit: '$', parse: num(1, 10_000_000), get: () => config.kyc[lvl].dailyUsd, set: (v) => { config.kyc[lvl].dailyUsd = v; } }],
    [`kyc.${lvl}.max_balance_usd`, { label: `Niveau ${lvl} — solde maximum`, unit: '$', parse: num(1, 100_000_000), get: () => config.kyc[lvl].maxBalanceUsd, set: (v) => { config.kyc[lvl].maxBalanceUsd = v; } }],
  ])),
  'signup.enabled': { label: 'Inscriptions ouvertes', unit: '', parse: bool, get: () => config.registrationsEnabled !== false, set: (v) => { config.registrationsEnabled = v; } },
};

// Valeurs d'origine (variables d'environnement), pour pouvoir revenir au défaut.
const DEFAULTS = Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.get()]));

export async function loadPlatformSettings() {
  const rows = await q.all('SELECT key, value FROM platform_settings');
  const stored = new Map(rows.map((r) => [r.key, parseJson(r.value)]));
  for (const [k, s] of Object.entries(SETTINGS)) {
    if (stored.has(k)) { try { s.set(s.parse(stored.get(k))); } catch { /* valeur invalide ignorée */ } } else s.set(DEFAULTS[k]);
  }
}

export async function listPlatformSettings() {
  const rows = new Map((await q.all('SELECT * FROM platform_settings')).map((r) => [r.key, r]));
  return Object.entries(SETTINGS).map(([key, s]) => ({
    key, label: s.label, unit: s.unit, value: s.get(), default: DEFAULTS[key],
    overridden: rows.has(key), updated_by: rows.get(key)?.updated_by || null, updated_at: rows.get(key)?.updated_at || null,
  }));
}

/** Met à jour plusieurs paramètres d'un coup (null = revenir à la valeur par défaut). Renvoie les changements. */
export async function updatePlatformSettings(patch, actor) {
  const changes = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const s = SETTINGS[k];
    if (!s) throw new HttpError(400, 'unknown_setting', `Paramètre inconnu : ${k}.`);
    changes.push({ key: k, from: s.get(), to: v === null ? DEFAULTS[k] : s.parse(v), reset: v === null });
  }
  if (!changes.length) throw new HttpError(400, 'nothing_to_update', 'Aucune modification.');
  // Cohérence des plafonds : par opération ≤ journalier ≤ … pour chaque niveau.
  const after = (key) => (changes.find((c) => c.key === key)?.to ?? SETTINGS[key].get());
  for (const lvl of [1, 2, 3]) {
    if (after(`kyc.${lvl}.per_txn_usd`) > after(`kyc.${lvl}.daily_usd`)) throw new HttpError(400, 'invalid_setting', `Niveau ${lvl} : le plafond par opération ne peut pas dépasser le plafond journalier.`);
  }
  await tx(async () => {
    for (const c of changes) {
      if (c.reset) await q.run('DELETE FROM platform_settings WHERE key=?', c.key);
      else {
        await q.run(`INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
                     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        c.key, JSON.stringify(c.to), actor, now());
      }
    }
  });
  for (const c of changes) SETTINGS[c.key].set(c.to);
  return changes;
}
