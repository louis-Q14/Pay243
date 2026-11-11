// Test de charge : deux instances Pay243 sur la même base PostgreSQL, sollicitées en parallèle.
// Vérifie : pas de découvert, pas de double encaissement, idempotence et limitation de débit partagées,
// deadlocks rejoués, grand livre équilibré et soldes = somme des écritures.
//
// Usage : LOAD_DATABASE_URL=postgres://user:mdp@hote:5432/pay243_load npm run test:load
// ⚠ La base est VIDÉE : son nom doit contenir "test", "load" ou "stress".
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';

const projectDir = process.cwd();
const dbUrl = process.env.LOAD_DATABASE_URL;
if (!dbUrl || !/test|load|stress/i.test(new URL(dbUrl).pathname)) {
  console.error('Définissez LOAD_DATABASE_URL vers une base dédiée (nom contenant "test", "load" ou "stress") : elle sera vidée.');
  process.exit(1);
}
const ports = [3101, 3102];
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'ÉCHEC'} ${msg}`); if (!cond) failures++; };

// --- Réinitialise la base de charge
{
  const c = new pg.Client(dbUrl); await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
}

// --- Démarre deux instances (la première applique les migrations, la seconde attend le verrou)
for (const port of ports) {
  const p = spawn(process.execPath, ['src/server.js'], {
    cwd: projectDir,
    env: { ...process.env, DATABASE_URL: dbUrl, PORT: String(port), BASE_URL: `http://localhost:${port}`, MOCK_DELAY_MS: '50', PAY243_MODE: 'sandbox', DB_POOL_MAX: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errOut = '';
  p.stderr.on('data', (d) => { errOut += d; });
  p.stdout.on('data', (d) => { if (/Error|error/.test(String(d))) process.stdout.write(`[${port}] ${d}`); });
  p.on('exit', (code) => { if (code) console.log(`[${port}] arrêt code ${code}\n${errOut}`); });
  procs.push(p);
}
const base = (i) => `http://localhost:${ports[i % 2]}`;
for (const port of ports) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${port}/health`)).ok) break; } catch {} await sleep(250); }
}
console.log('Deux instances démarrées sur la même base.');

const api = async (i, method, p, { token, body, headers = {} } = {}) => {
  const r = await fetch(base(i) + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function register(i, phone, full_name, pin) {
  const email = `${full_name.toLowerCase().replace(/[^a-z]+/g, '.')}@charge.test`;
  const otp = await api(i, 'POST', '/v1/auth/otp', { body: { email } });
  const r = await api(i, 'POST', '/v1/auth/register', { body: { account_type: 'personal', email, phone, full_name, password: 'motdepasse1', pin, otp_code: otp.body.sandbox_code } });
  return r.body.token;
}
const cdf = async (i, token) => (await api(i, 'GET', '/v1/wallets', { token })).body.data.find((x) => x.currency === 'CDF').balance;

try {
  const alice = await register(0, '0821110001', 'Alice Charge', '3917');
  const bob = await register(1, '0971110002', 'Bob Charge', '5824');
  for (const [i, tok] of [[0, alice], [1, bob]]) {
    const t = await api(i, 'POST', '/v1/topups', { token: tok, body: { amount: 1_000_000, currency: 'CDF' } });
    for (let k = 0; k < 100; k++) { if ((await api(i, 'GET', `/v1/transactions/${t.body.id}`, { token: tok })).body.status === 'succeeded') break; await sleep(50); }
  }
  check((await cdf(0, alice)) === 1_000_000 && (await cdf(1, bob)) === 1_000_000, 'recharges créditées (1 000 000 chacun)');

  // --- Phase 1 : 120 transferts croisés simultanés répartis sur les deux instances
  const N = 60; const AMT = 30_000;
  const jobs = [];
  for (let k = 0; k < N; k++) {
    jobs.push(api(k, 'POST', '/v1/transfers', { token: alice, body: { to_phone: '0971110002', amount: AMT, currency: 'CDF', pin: '3917' } }).then((r) => ({ dir: 'a2b', r })));
    jobs.push(api(k + 1, 'POST', '/v1/transfers', { token: bob, body: { to_phone: '0821110001', amount: AMT, currency: 'CDF', pin: '5824' } }).then((r) => ({ dir: 'b2a', r })));
  }
  const t0 = Date.now();
  const res = await Promise.all(jobs);
  const ms = Date.now() - t0;
  const codes = res.reduce((acc, { r }) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  console.log(`Phase 1 : ${jobs.length} transferts en ${ms} ms, statuts ${JSON.stringify(codes)}`);
  check(!res.some(({ r }) => r.status >= 500), 'aucune erreur 500 (deadlocks rejoués correctement)');
  check(res.every(({ r }) => [201, 402].includes(r.status)), 'seulement des succès ou des refus « solde insuffisant »');
  const sA = res.filter((x) => x.dir === 'a2b' && x.r.status === 201).length;
  const sB = res.filter((x) => x.dir === 'b2a' && x.r.status === 201).length;
  const a = await cdf(0, alice); const b = await cdf(1, bob);
  check(a === 1_000_000 - AMT * sA + AMT * sB && b === 1_000_000 - AMT * sB + AMT * sA, `soldes exacts : Alice ${a}, Bob ${b} (${sA} A→B, ${sB} B→A réussis)`);
  check(a >= 0 && b >= 0 && a + b === 2_000_000, 'aucun découvert, total conservé (2 000 000)');

  // --- Phase 1b : découvert à sens unique — 60 transferts de 30 000 sur un solde de 1 000 000 -> exactement 33 passent
  const one = await Promise.all(Array.from({ length: N }, (_, k) => api(k, 'POST', '/v1/transfers', { token: alice, body: { to_phone: '0971110002', amount: AMT, currency: 'CDF', pin: '3917' } })));
  const ok1 = one.filter((r) => r.status === 201).length;
  console.log(`Phase 1b : statuts ${JSON.stringify(one.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}))}`);
  check(ok1 === 33 && (await cdf(0, alice)) === 10_000, `exactement 33 transferts acceptés, solde restant 10 000 (${ok1} acceptés, solde ${await cdf(0, alice)})`);
  check(!one.some((r) => r.status >= 500), 'aucune erreur 500');

  // --- Phase 2 : 3 liens payés chacun 4 fois en parallèle sur les deux instances (sous la limite de 15/min)
  const m = await api(0, 'POST', '/v1/merchants', { token: alice, body: { name: 'Boutique Charge' } });
  const sk = m.body.secret_key;
  let exactlyOne = 0;
  const links = await Promise.all(Array.from({ length: 3 }, (_, k) => api(k, 'POST', '/v1/payments', { token: sk, body: { amount: 1_000, currency: 'CDF' } })));
  await Promise.all(links.map(async (l) => {
    const tries = await Promise.all([0, 1, 2, 3].map((k) => api(k, 'POST', `/v1/checkout/${l.body.id}/pay`, { token: bob, body: { method: 'wallet', pin: '5824' } })));
    if (tries.filter((t) => t.status === 200).length === 1 && tries.every((t) => [200, 409].includes(t.status))) exactlyOne++;
    else console.log('   statuts', tries.map((t) => `${t.status}:${t.body.error?.code || ''}`).join(' '));
  }));
  check(exactlyOne === 3, `chaque lien encaissé exactement une fois (${exactlyOne}/3)`);

  // --- Phase 2b : limiteur de débit partagé — 12 requêtes déjà faites, 10 de plus réparties sur les 2 serveurs
  const extra = await Promise.all(Array.from({ length: 10 }, (_, k) => api(k, 'POST', `/v1/checkout/${links[0].body.id}/pay`, { body: { method: 'card', token: 'x' } })));
  const limited = extra.filter((r) => r.status === 429).length;
  check(limited >= 7, `limite de 15/min appliquée globalement aux deux serveurs (${limited} requêtes sur 10 bloquées, 7 attendues si même minute)`);

  // --- Phase 3 : même Idempotency-Key envoyée 6 fois à la fois aux deux instances
  const before = await cdf(1, bob);
  const key = `stress-${crypto.randomUUID()}`;
  const idem = await Promise.all(Array.from({ length: 6 }, (_, k) => api(k, 'POST', '/v1/transfers', { token: bob, headers: { 'Idempotency-Key': key }, body: { to_phone: '0821110001', amount: 5_000, currency: 'CDF', pin: '5824' } })));
  console.log(`Phase 3 : statuts ${idem.map((r) => r.status).join(' ')}`);
  check((await cdf(1, bob)) === before - 5_000, 'débité une seule fois malgré 6 envois sur 2 serveurs');

  // --- Invariants du grand livre
  const c = new pg.Client(dbUrl); await c.connect();
  const totals = (await c.query('SELECT currency, SUM(balance)::bigint AS t FROM wallets GROUP BY currency')).rows;
  check(totals.every((t) => Number(t.t) === 0), `grand livre équilibré par devise ${JSON.stringify(totals)}`);
  const bad = (await c.query('SELECT e.txn_id FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id GROUP BY e.txn_id, w.currency HAVING SUM(e.amount) <> 0')).rows;
  check(bad.length === 0, 'chaque transaction équilibrée (partie double)');
  const drift = (await c.query('SELECT w.id FROM wallets w LEFT JOIN (SELECT wallet_id, SUM(amount) s FROM ledger_entries GROUP BY wallet_id) l ON l.wallet_id = w.id WHERE w.balance <> COALESCE(l.s, 0)')).rows;
  check(drift.length === 0, 'chaque solde = somme de ses écritures (aucune mise à jour perdue)');
  const negatives = (await c.query("SELECT COUNT(*)::int n FROM wallets WHERE owner_type <> 'system' AND balance < 0")).rows[0].n;
  check(negatives === 0, 'aucun solde client/marchand négatif');
  await c.end();
} catch (e) {
  failures++;
  console.error('ERREUR', e);
} finally {
  for (const p of procs) p.kill();
  console.log(failures ? `\n${failures} contrôle(s) en échec` : '\nTous les contrôles sont passés.');
  process.exitCode = failures ? 1 : 0;
}
