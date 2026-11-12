import { q } from './db.js';
import { HttpError, now } from './util.js';

/**
 * Idempotence : si le client envoie "Idempotency-Key", une requête rejouée renvoie la même réponse
 * au lieu de déplacer l'argent deux fois (indispensable sur réseaux mobiles instables).
 * La clé est réservée en base AVANT le traitement : deux requêtes identiques arrivant sur deux serveurs
 * ne peuvent pas être traitées toutes les deux.
 */
const ABANDONED_AFTER_MS = 5 * 60_000;

export function idempotent(scopeOf) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (key.length > 255) throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key trop long (255 max).');
    const scope = `${scopeOf(req)}:${req.method}:${req.originalUrl.split('?')[0]}`;

    const claimed = await q.run(
      "INSERT INTO idempotency_keys (scope, key, status_code, response, created_at) VALUES (?,?,0,'',?) ON CONFLICT DO NOTHING",
      scope, key, now(),
    );
    if (!claimed.changes) {
      const row = await q.get('SELECT * FROM idempotency_keys WHERE scope=? AND key=?', scope, key);
      if (row && row.status_code > 0) {
        res.set('Idempotent-Replayed', 'true');
        return res.status(row.status_code).json(JSON.parse(row.response));
      }
      if (row && Date.parse(row.created_at) < Date.now() - ABANDONED_AFTER_MS) {
        // Traitement interrompu (arrêt du serveur) : on ne rejoue pas à l'aveugle, l'argent a pu bouger.
        throw new HttpError(409, 'idempotency_abandoned', "Une requête précédente avec cette Idempotency-Key a été interrompue. Vérifiez l'historique, puis utilisez une nouvelle clé.");
      }
      throw new HttpError(409, 'idempotency_in_progress', 'Une requête avec cette Idempotency-Key est déjà en cours.');
    }

    let settled = false;
    const json = res.json.bind(res);
    res.json = (body) => {
      settled = true;
      const store = res.statusCode < 500
        ? q.run('UPDATE idempotency_keys SET status_code=?, response=? WHERE scope=? AND key=?', res.statusCode, JSON.stringify(body), scope, key)
        : q.run('DELETE FROM idempotency_keys WHERE scope=? AND key=?', scope, key); // erreur serveur : nouvel essai permis
      store.catch((e) => console.error('[idempotency]', e.message)).finally(() => json(body));
      return res;
    };
    res.on('close', () => {
      if (!settled) q.run('DELETE FROM idempotency_keys WHERE scope=? AND key=?', scope, key).catch(() => {});
    });
    next();
  };
}

/**
 * Limiteur de débit à fenêtre fixe, partagé entre instances via PostgreSQL.
 * `name` distingue les limiteurs (connexion, paiement…).
 */
export function rateLimit({ name, windowMs = 60_000, max = 20, keyOf = (req) => req.ip, message = 'Trop de requêtes. Réessayez dans une minute.' } = {}) {
  if (!name) throw new Error('rateLimit : name requis');
  return async (req, _res, next) => {
    const win = Math.floor(Date.now() / windowMs);
    const row = await q.get(
      `INSERT INTO rate_limits (key, window_start, hits, expires_at) VALUES (?,?,1,?)
       ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`,
      `${name}:${keyOf(req)}`, win, new Date((win + 2) * windowMs).toISOString(),
    );
    if (row.hits > max) throw new HttpError(429, 'rate_limited', message);
    next();
  };
}

/** Nettoyage périodique des tables techniques (fenêtres expirées, clés d'idempotence de plus de 24 h). */
export async function purgeTechnicalTables() {
  await q.run('DELETE FROM rate_limits WHERE expires_at < ?', now());
  await q.run('DELETE FROM idempotency_keys WHERE created_at < ?', new Date(Date.now() - 24 * 3600e3).toISOString());
}

export function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), payment=(), usb=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
}

/** CORS ouvert uniquement pour le SDK navigateur (lecture publique du checkout). */
export function publicCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
