import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

/*
 * Accès à PostgreSQL.
 *  - Production : serveur PostgreSQL via le pilote `pg` (DATABASE_URL), pool de connexions.
 *  - Développement / tests : PGlite, le vrai moteur PostgreSQL compilé en WebAssembly, embarqué
 *    (aucune installation). Même SQL, même comportement transactionnel.
 *
 * Transactions : tx(fn) ouvre une transaction et la rend implicite pour toutes les requêtes q.*
 * exécutées dans fn (AsyncLocalStorage). Les mouvements de fonds verrouillent les lignes concernées
 * (SELECT … FOR UPDATE) : les garanties tiennent avec plusieurs instances de l'application.
 */

const als = new AsyncLocalStorage();
let driver = null;
export const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// "?" -> "$1, $2…" (en ignorant les "?" situés dans des chaînes SQL entre apostrophes)
const sqlCache = new Map();
function toPg(sql) {
  let out = sqlCache.get(sql);
  if (out) return out;
  let n = 0; let quoted = false; out = '';
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  sqlCache.set(sql, out);
  return out;
}

async function pgDriver(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT : montants en unités mineures (< 2^53)
  pg.types.setTypeParser(1700, (v) => Number(v)); // NUMERIC (SUM d'entiers)
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX || 10) });
  pool.on('error', (e) => console.error('[db] connexion inactive en erreur', e.message));
  const wrap = (r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 });
  return {
    kind: 'postgres',
    query: async (sql, params) => wrap(await pool.query(sql, params)),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const res = await fn({ query: async (sql, params) => wrap(await c.query(sql, params)) });
        await c.query('COMMIT');
        return res;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    async withLock(key, fn) {
      const c = await pool.connect();
      try {
        await c.query('SELECT pg_advisory_lock($1)', [key]);
        return await fn({ query: async (sql, params) => wrap(await c.query(sql, params)), exec: (sql) => c.query(sql) });
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir) {
  const { PGlite, types } = await import('@electric-sql/pglite');
  if (dataDir) fs.mkdirSync(path.resolve(dataDir), { recursive: true });
  const db = await PGlite.create(dataDir ? path.resolve(dataDir) : undefined, {
    parsers: { [types.INT8]: (v) => Number(v), [types.NUMERIC]: (v) => Number(v) },
  });
  const wrap = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? 0 });
  return {
    kind: 'pglite',
    query: async (sql, params) => wrap(await db.query(sql, params)),
    transaction: (fn) => db.transaction((t) => fn({ query: async (sql, params) => wrap(await t.query(sql, params)) })),
    withLock: (_key, fn) => fn({ query: async (sql, params) => wrap(await db.query(sql, params)), exec: (sql) => db.exec(sql) }),
    close: () => db.close(),
  };
}

/**
 * Ouvre la base et applique les migrations.
 *  - { url: 'postgres://…' } : serveur PostgreSQL
 *  - { dataDir: './data/pglite' } : PGlite persistant
 *  - {} : PGlite en mémoire (tests)
 */
export async function openDb({ url, dataDir } = {}) {
  driver = url ? await pgDriver(url) : await pgliteDriver(dataDir);
  await migrate();
  return driver.kind;
}

export async function closeDb() {
  if (driver) await driver.close();
  driver = null;
}

async function migrate() {
  // Verrou consultatif : deux instances qui démarrent ensemble n'appliquent pas deux fois la même migration.
  await driver.withLock(727_001, async (c) => {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await c.exec(`BEGIN; ${m.sql}; COMMIT;`).catch(async (e) => { await c.exec('ROLLBACK').catch(() => {}); throw e; });
      await c.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [m.version, m.name, new Date().toISOString()]);
      console.log(`[db] migration ${m.version} appliquée : ${m.name}`);
    }
  });
}

function exec(sql, params) {
  if (!driver) throw new Error('Base de données non ouverte (openDb).');
  const ctx = als.getStore();
  return (ctx ? ctx.client : driver).query(toPg(sql), params);
}

export const q = {
  get: async (sql, ...p) => (await exec(sql, p)).rows[0],
  all: async (sql, ...p) => (await exec(sql, p)).rows,
  run: async (sql, ...p) => ({ changes: (await exec(sql, p)).rowCount }),
};

/**
 * Exécute fn dans une transaction. Imbriquée, elle réutilise la transaction englobante.
 * Rejouée automatiquement (2 fois) en cas de deadlock ou de conflit de sérialisation.
 */
export async function tx(fn) {
  if (als.getStore()) return fn();
  for (let attempt = 1; ; attempt++) {
    const ctx = { client: null, after: [] };
    try {
      const result = await driver.transaction((client) => { ctx.client = client; return als.run(ctx, fn); });
      for (const cb of ctx.after) als.exit(() => setImmediate(cb));
      return result;
    } catch (e) {
      if (['40P01', '40001'].includes(e.code) && attempt < 3) continue;
      throw e;
    }
  }
}

/** Exécute cb après la validation de la transaction courante (ou tout de suite hors transaction). */
export function afterCommit(cb) {
  const ctx = als.getStore();
  if (ctx) ctx.after.push(cb);
  else setImmediate(cb);
}

export const inTransaction = () => !!als.getStore();

/** Violation d'unicité PostgreSQL (23505). */
export const isUniqueViolation = (e) => e?.code === '23505';

/** Bail d'une tâche de fond partagée entre instances. Renvoie true si cette instance l'obtient. */
export async function acquireLease(name, ms) {
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + ms).toISOString();
  const r = await q.run(
    `INSERT INTO job_locks (name, owner, locked_until) VALUES (?,?,?)
     ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
     WHERE job_locks.locked_until < ?`,
    name, INSTANCE_ID, until, nowIso,
  );
  return r.changes > 0;
}

export async function releaseLease(name) {
  await q.run('UPDATE job_locks SET locked_until = ? WHERE name = ? AND owner = ?', new Date(0).toISOString(), name, INSTANCE_ID);
}
