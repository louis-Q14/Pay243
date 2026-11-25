// Démarrage du serveur (src/server.js) : regroupement des comptes d'entreprise sur une base PGlite réelle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openDb, closeDb, q } = await import('../src/db.js');
const { createTxn, getWallet, move, systemWallet } = await import('../src/ledger.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('au démarrage, le solde personnel d\'une entreprise passe sur son compte marchand', { timeout: 120_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay243-startup-'));
  await openDb({ dataDir });
  await q.run("INSERT INTO users (id, email, account_type, full_name, password_hash, pin_hash, created_at) VALUES ('usr_boot_biz','boot@test.cd','business','Entreprise Démarrage','x','x',?)", new Date().toISOString());
  await q.run('INSERT INTO merchants (id, owner_user_id, name, webhook_secret, created_at) VALUES (?,?,?,?,?)', 'mer_boot_biz', 'usr_boot_biz', 'Entreprise Démarrage', 'whsec_test', new Date().toISOString());
  const old = await getWallet('user', 'usr_boot_biz', 'CDF');
  const float = await systemWallet('float_card', 'CDF');
  const fund = await createTxn({ type: 'topup', status: 'succeeded', amount: 82875000, currency: 'CDF', method: 'card', from_wallet: float.id, to_wallet: old.id });
  await move(fund.id, float.id, old.id, 82875000);
  await closeDb();

  const port = 3197;
  const p = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PGLITE_DIR: dataDir, DATABASE_URL: '', PORT: String(port), BASE_URL: `http://localhost:${port}`, PAY243_MODE: 'sandbox', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try { ready = (await fetch(`http://localhost:${port}/health`)).ok; } catch { await sleep(250); }
  }
  p.kill();
  await new Promise((r) => p.once('exit', r));
  assert.ok(ready, 'le serveur doit démarrer');

  await openDb({ dataDir });
  try {
    assert.equal(Number((await getWallet('user', 'usr_boot_biz', 'CDF')).balance), 0,
      'src/server.js doit appeler consolidateBusinessWallets() au démarrage');
    assert.equal(Number((await getWallet('merchant', 'mer_boot_biz', 'CDF')).balance), 82875000);
  } finally {
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
