// Tests de bout en bout : wallet, Mobile Money (simulé), cartes, API marchands, webhooks signés, remboursements.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

process.env.MOCK_DELAY_MS = '30';
process.env.RATE_LIMIT_AUTH = '1000'; // la suite enchaîne beaucoup d'inscriptions et de connexions
process.env.RATE_LIMIT_OTP = '1000';
process.env.RATE_LIMIT_KYC_UPLOAD = '1000';
process.env.RATE_LIMIT_LOGIN_ACCOUNT = '1000';
process.env.RATE_LIMIT_MONEY = '1000';
const ADMIN_KEY = 'adm_test_0123456789abcdefghijkl';
process.env.ADMIN_KEYS = `conformite:${ADMIN_KEY}`;
const fs = await import('node:fs');
const os = await import('node:os');
const pathMod = await import('node:path');
process.env.KYC_STORAGE_DIR = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'kw-kyc-test-'));

const { openDb, closeDb, q } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { auditLedger } = await import('../src/ledger.js');
const { deliverDue } = await import('../src/services/webhooks.js');
const { cardProcessor } = await import('../src/providers/cards/index.js');
const { isPrivateAddress } = await import('../src/netguard.js');
const { sweepPending, localDate, businessDay } = await import('../src/services/reconciliation.js');
const { handleProviderResult } = await import('../src/services/mobileMoney.js');

let server; let base; let hookServer; let hookUrl;
const hooks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error('timeout');
}

const state = {};
const DEVICE_A = 'device-alice-0001-test';

const emailOf = (name) => `${name.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '.')}@test.cd`;

/** Inscription en deux étapes : code envoyé par email (exposé en sandbox) puis création du compte. */
/** Par défaut, le compte est considéré comme validé par l'équipe (activate: false pour tester un compte non activé). */
let rccmSeq = 0;
const businessOf = (name) => ({ rccm: `CD/KNG/RCCM/24-B-${String(++rccmSeq).padStart(5, '0')}`, address: '12, avenue du Commerce, Gombe', city: 'Kinshasa', phone: '0812345678', email: `contact${rccmSeq}@${String(name || 'entreprise').toLowerCase().replace(/[^a-z]/g, '')}.cd` });

async function register({ activate = true, ...body }) {
  if (body.account_type === 'business' && body.business === undefined) body.business = businessOf(body.business_name);
  const email = body.email || emailOf(body.full_name);
  const otp = await api('POST', '/v1/auth/otp', { body: { email, purpose: 'register' } });
  assert.equal(otp.status, 201, JSON.stringify(otp.body));
  assert.equal(otp.body.channel, 'email');
  assert.match(otp.body.sandbox_code, /^\d{6}$/);
  const r = await api('POST', '/v1/auth/register', { body: { account_type: 'personal', ...body, email, otp_code: otp.body.sandbox_code } });
  if (activate && r.status === 201) await q.run('UPDATE users SET activated_at=? WHERE id=?', new Date().toISOString(), r.body.user.id);
  return r;
}

before(async () => {
  // Par défaut : PostgreSQL embarqué (PGlite) en mémoire. TEST_DATABASE_URL : vrai serveur PostgreSQL
  // (pool de connexions, verrous réellement concurrents). La base est vidée : elle doit être dédiée aux tests.
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    assert.match(new URL(url).pathname, /test/i, 'TEST_DATABASE_URL doit viser une base dont le nom contient "test" (elle est réinitialisée).');
    const { default: pg } = await import('pg');
    const c = new pg.Client(url);
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
  }
  await openDb(url ? { url } : {});
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  hookServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { hooks.push({ raw, sig: req.headers['pay243-signature'] }); res.end('ok'); });
  }).listen(0);
  hookUrl = `http://127.0.0.1:${hookServer.address().port}/hooks`;
});

after(async () => { server.close(); hookServer.close(); await closeDb(); fs.rmSync(process.env.KYC_STORAGE_DIR, { recursive: true, force: true }); });

test('inscription par email et wallets CDF/USD créés', async () => {
  const a = await register({ email: 'Grace.Mbuyi@Test.cd', phone: '0812345678', full_name: 'Grace Mbuyi', password: 'motdepasse1', pin: '2580', device_id: DEVICE_A });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.user.email, 'grace.mbuyi@test.cd'); // normalisé en minuscules
  assert.equal(a.body.user.email_verified, true);
  assert.equal(a.body.user.account_type, 'personal');
  assert.equal(a.body.user.phone, '+243812345678');
  assert.equal(a.body.user.operator, 'mpesa');
  assert.equal(a.body.merchant, undefined);
  state.alice = a.body.token;
  const b = await register({ phone: '+243 97 111 2222', full_name: 'Patrick Ilunga', password: 'motdepasse2', pin: '9137' });
  state.bob = b.body.token;
  // Email déjà utilisé (quelle que soit la casse) : refusé dès l'envoi du code et à l'inscription
  const dupOtp = await api('POST', '/v1/auth/otp', { body: { email: 'GRACE.MBUYI@test.cd' } });
  assert.equal(dupOtp.status, 409);
  assert.equal(dupOtp.body.error.code, 'email_taken');
  const dup = await api('POST', '/v1/auth/register', { body: { account_type: 'personal', email: 'grace.mbuyi@test.cd', full_name: 'X Y Z', password: 'motdepasse1', pin: '2580', otp_code: '123456' } });
  assert.equal(dup.status, 409);
  // Numéro déjà associé à un autre compte
  const dupPhone = await register({ email: 'autre@test.cd', phone: '0812345678', full_name: 'Autre Personne', password: 'motdepasse1', pin: '2580' });
  assert.equal(dupPhone.body.error.code, 'phone_taken');
  const w = await api('GET', '/v1/wallets', { token: state.alice });
  assert.deepEqual(w.body.data.map((x) => x.currency), ['CDF', 'USD']);
});

test('type de compte obligatoire, email valide exigé', async () => {
  const base1 = { email: 'type@test.cd', full_name: 'Sans Type', password: 'motdepasse3', pin: '4826', otp_code: '123456' };
  assert.equal((await api('POST', '/v1/auth/register', { body: base1 })).body.error.code, 'invalid_account_type');
  assert.equal((await api('POST', '/v1/auth/register', { body: { ...base1, account_type: 'vip' } })).body.error.code, 'invalid_account_type');
  assert.equal((await api('POST', '/v1/auth/otp', { body: { email: 'pas-un-email' } })).body.error.code, 'invalid_email');
  const biz = await api('POST', '/v1/auth/register', { body: { ...base1, account_type: 'business' } });
  assert.equal(biz.body.error.code, 'invalid_business_name');
});

test('compte entreprise : RCCM, adresse et contact obligatoires, site web facultatif', async () => {
  const base = { account_type: 'business', business_name: 'Kin Bureautique', full_name: 'Aline Ngalula', password: 'motdepasse8', pin: '6402' };
  const without = await register({ ...base, email: 'sans.rccm@kinbureau.cd', business: { ...businessOf('x'), rccm: '' } });
  assert.equal(without.body.error.code, 'invalid_rccm');
  const noPhone = await register({ ...base, email: 'sans.tel@kinbureau.cd', business: { ...businessOf('x'), phone: 'abc' } });
  assert.equal(noPhone.body.error.code, 'invalid_business_phone');
  const badSite = await register({ ...base, email: 'site@kinbureau.cd', business: { ...businessOf('x'), website: 'pas un site' } });
  assert.equal(badSite.body.error.code, 'invalid_website');

  const profile = { ...businessOf('kinbureau'), rccm: 'cd/kng/rccm/23-b-07777', fax: '+243 81 000 0000', website: 'kinbureau.cd' };
  const ok = await register({ ...base, email: 'aline@kinbureau.cd', business: profile });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const m = await api('GET', '/v1/merchants/me', { token: ok.body.token });
  assert.equal(m.body.business.rccm, 'CD/KNG/RCCM/23-B-07777');
  assert.equal(m.body.business.city, 'Kinshasa');
  assert.equal(m.body.business.fax, '+243 81 000 0000');
  assert.equal(m.body.business.website, 'https://kinbureau.cd/');

  const dup = await register({ ...base, email: 'autre@kinbureau.cd', business: { ...businessOf('y'), rccm: 'CD/KNG/RCCM/23-B-07777' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'rccm_taken');
});

test('compte entreprise : espace marchand et clé API créés à l\'inscription', async () => {
  const r = await register({ account_type: 'business', email: 'contact@kinmode.cd', business_name: 'Kin Mode SARL', full_name: 'Mamie Lukusa', password: 'motdepasse7', pin: '6291' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.account_type, 'business');
  assert.equal(r.body.user.phone, null); // téléphone facultatif
  assert.equal(r.body.merchant.name, 'Kin Mode SARL');
  assert.match(r.body.merchant.secret_key, /^sk_test_/);
  const m = await api('GET', '/v1/merchants/me', { token: r.body.token });
  assert.equal(m.body.id, r.body.merchant.id);
  const pay = await api('POST', '/v1/payments', { token: r.body.merchant.secret_key, body: { amount: 1000, currency: 'USD' } });
  assert.equal(pay.status, 201);
  state.bizToken = r.body.token;
});

test('connexion par email ; numéro Mobile Money demandé seulement quand il manque', async () => {
  const login = await api('POST', '/v1/auth/login', { body: { identifier: 'CONTACT@kinmode.cd', password: 'motdepasse7' } });
  assert.equal(login.status, 403); // aucun appareil fourni : code de vérification
  assert.equal(login.body.error.details.channel, 'email');
  assert.match(login.body.error.message, /par email à co•••@kinmode\.cd/);
  const ok = await api('POST', '/v1/auth/login', { body: { email: 'contact@kinmode.cd', password: 'motdepasse7', otp_code: login.body.error.details.sandbox_code } });
  assert.equal(ok.status, 200);
  const wrong = await api('POST', '/v1/auth/login', { body: { identifier: 'contact@kinmode.cd', password: 'mauvais-mdp' } });
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  const noPhone = await api('POST', '/v1/topups', { token: state.bizToken, body: { amount: 1000, currency: 'CDF' } });
  assert.equal(noPhone.body.error.code, 'missing_phone');
  const withPhone = await api('POST', '/v1/topups', { token: state.bizToken, body: { amount: 1000, currency: 'CDF', phone: '0821234500' } });
  assert.equal(withPhone.status, 202);
});

test('OTP : inscription refusée sans code valide, essais limités, renvoi temporisé', async () => {
  const body = { account_type: 'personal', email: 'jeanne.kabila@test.cd', full_name: 'Jeanne Kabila', password: 'motdepasse3', pin: '4826' };
  const none = await api('POST', '/v1/auth/register', { body });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'invalid_otp');
  const otp = await api('POST', '/v1/auth/otp', { body: { email: body.email } });
  assert.equal(otp.status, 201);
  const tooSoon = await api('POST', '/v1/auth/otp', { body: { email: body.email } });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.body.error.code, 'otp_too_soon');
  const wrong = otp.body.sandbox_code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/v1/auth/register', { body: { ...body, otp_code: wrong } });
    assert.equal(r.body.error.code, 'invalid_otp');
  }
  const locked = await api('POST', '/v1/auth/register', { body: { ...body, otp_code: otp.body.sandbox_code } });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'otp_locked');
  assert.equal((await q.get('SELECT COUNT(*) AS n FROM users WHERE email=?', 'jeanne.kabila@test.cd')).n, 0);
  // Seul un HMAC du code est stocké
  assert.ok(!JSON.stringify(await q.all('SELECT * FROM otp_codes')).includes(`"${otp.body.sandbox_code}"`));
});

test('connexion par téléphone : appareil connu direct, nouvel appareil -> code par email puis appareil de confiance', async () => {
  const known = await api('POST', '/v1/auth/login', { body: { phone: '0812345678', password: 'motdepasse1', device_id: DEVICE_A } });
  assert.equal(known.status, 200);
  assert.ok(known.body.token);

  const badPwd = await api('POST', '/v1/auth/login', { body: { phone: '0812345678', password: 'mauvais!!', device_id: 'device-inconnu-9999' } });
  assert.equal(badPwd.status, 401); // aucun SMS envoyé sans le bon mot de passe

  const newDev = { phone: '0812345678', password: 'motdepasse1', device_id: 'device-alice-telephone-2' };
  const challenge = await api('POST', '/v1/auth/login', { body: newDev });
  assert.equal(challenge.status, 403);
  assert.equal(challenge.body.error.code, 'otp_required');
  const code = challenge.body.error.details.sandbox_code;
  assert.match(code, /^\d{6}$/);
  const ok = await api('POST', '/v1/auth/login', { body: { ...newDev, otp_code: code } });
  assert.equal(ok.status, 200);
  const again = await api('POST', '/v1/auth/login', { body: newDev });
  assert.equal(again.status, 200, 'appareil désormais de confiance');

  const noDevice = await api('POST', '/v1/auth/login', { body: { phone: '0812345678', password: 'motdepasse1' } });
  assert.equal(noDevice.body.error.code, 'otp_required');
});

test('recharge M-Pesa (simulée) créditée après confirmation', async () => {
  const t = await api('POST', '/v1/topups', { token: state.alice, body: { amount: 20000, currency: 'USD' } });
  assert.equal(t.status, 202);
  assert.equal(t.body.status, 'pending');
  assert.equal(t.body.operator, 'mpesa');
  await waitFor(async () => (await api('GET', `/v1/transactions/${t.body.id}`, { token: state.alice })).body.status === 'succeeded');
  const w = await api('GET', '/v1/wallets', { token: state.alice });
  assert.equal(w.body.data.find((x) => x.currency === 'USD').balance, 20000);
});

test('recharge Airtel refusée par le client -> wallet non crédité', async () => {
  const t = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 500000, currency: 'CDF', phone: '0970000000' } });
  assert.equal(t.body.operator, 'airtel');
  const done = await waitFor(async () => { const r = await api('GET', `/v1/transactions/${t.body.id}`, { token: state.bob }); return r.body.status !== 'pending' && r.body; });
  assert.equal(done.status, 'failed');
  assert.match(done.failure_reason, /refusé/);
});

test('opérateur incohérent avec le numéro rejeté', async () => {
  const t = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 1000, currency: 'USD', phone: '0971112222', operator: 'orange' } });
  assert.equal(t.status, 400);
  assert.equal(t.body.error.code, 'operator_mismatch');
});

test('transfert P2P avec PIN + idempotence', async () => {
  const bad = await api('POST', '/v1/transfers', { token: state.alice, body: { to_phone: '0971112222', amount: 1000, currency: 'USD', pin: '0000' } });
  assert.equal(bad.status, 401);
  const key = crypto.randomUUID();
  const body = { to_phone: '0971112222', amount: 2500, currency: 'USD', pin: '2580', note: 'Loyer' };
  const t1 = await api('POST', '/v1/transfers', { token: state.alice, body, headers: { 'Idempotency-Key': key } });
  const t2 = await api('POST', '/v1/transfers', { token: state.alice, body, headers: { 'Idempotency-Key': key } });
  assert.equal(t1.status, 201);
  assert.equal(t2.body.id, t1.body.id);
  const w = await api('GET', '/v1/wallets', { token: state.bob });
  assert.equal(w.body.data.find((x) => x.currency === 'USD').balance, 2500);
});

test('transfert vers une adresse email', async () => {
  const t = await api('POST', '/v1/transfers', { token: state.bob, body: { to: 'Grace.Mbuyi@test.cd', amount: 500, currency: 'USD', pin: '9137' } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const unknown = await api('POST', '/v1/transfers', { token: state.bob, body: { to: 'personne@nulle-part.cd', amount: 100, currency: 'USD', pin: '9137' } });
  assert.equal(unknown.body.error.code, 'recipient_not_found');
  const back = await api('POST', '/v1/transfers', { token: state.alice, body: { to_email: 'patrick.ilunga@test.cd', amount: 500, currency: 'USD', pin: '2580' } });
  assert.equal(back.status, 201);
});

test('plafond KYC niveau 1 appliqué', async () => {
  const t = await api('POST', '/v1/transfers', { token: state.alice, body: { to_phone: '0971112222', amount: 15000, currency: 'USD', pin: '2580' } });
  assert.equal(t.status, 403);
  assert.equal(t.body.error.code, 'limit_per_transaction');
});

test('carte : tokenisation, enregistrement, recharge, refus', async () => {
  const tok = await api('POST', '/sandbox/cards/tokenize', { body: { number: '4242 4242 4242 4242', exp_month: 12, exp_year: 2030, cvc: '123' } });
  const card = await api('POST', '/v1/cards', { token: state.bob, body: { token: tok.body.token } });
  assert.equal(card.status, 201);
  assert.equal(card.body.last4, '4242');
  assert.ok(!JSON.stringify(card.body).includes('4242424242424242'));
  const top = await api('POST', '/v1/topups', { token: state.bob, body: { method: 'card', card_id: card.body.id, amount: 5000, currency: 'USD' } });
  assert.equal(top.status, 201);
  assert.equal(top.body.status, 'succeeded');
  const dtok = await api('POST', '/sandbox/cards/tokenize', { body: { number: '4000000000000002', exp_month: 1, exp_year: 2031, cvc: '123' } });
  const dcard = await api('POST', '/v1/cards', { token: state.bob, body: { token: dtok.body.token } });
  const fail = await api('POST', '/v1/topups', { token: state.bob, body: { method: 'card', card_id: dcard.body.id, amount: 5000, currency: 'USD' } });
  assert.equal(fail.status, 402);
});

test('conversion USD -> CDF', async () => {
  const c = await api('POST', '/v1/conversions', { token: state.bob, body: { from_currency: 'USD', to_currency: 'CDF', amount: 1000, pin: '9137' } });
  assert.equal(c.status, 201);
  assert.equal(c.body.metadata.to_amount, Math.floor(1000 * 2850 * 0.99));
});

test('marchand : création, paiement via wallet, webhook signé, remboursement', async () => {
  const m = await api('POST', '/v1/merchants', { token: state.alice, body: { name: 'Boutique Kin Mode', webhook_url: hookUrl } });
  assert.equal(m.status, 201);
  assert.match(m.body.secret_key, /^sk_test_/);
  state.sk = m.body.secret_key;
  state.whsec = m.body.webhook_secret;

  const unauth = await api('POST', '/v1/payments', { body: { amount: 1000, currency: 'USD' } });
  assert.equal(unauth.status, 401);

  const pay = await api('POST', '/v1/payments', { token: state.sk, body: { amount: 4000, currency: 'USD', description: 'Robe pagne wax', reference: 'CMD-1001', return_url: 'https://kinmode.cd/merci' } });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.status, 'requires_payment');
  assert.match(pay.body.checkout_url, /\/checkout\/pay_/);

  const view = await api('GET', `/v1/checkout/${pay.body.id}`);
  assert.equal(view.body.merchant.name, 'Boutique Kin Mode');

  const paid = await api('POST', `/v1/checkout/${pay.body.id}/pay`, { token: state.bob, body: { method: 'wallet', pin: '9137' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, 'succeeded');

  const again = await api('POST', `/v1/checkout/${pay.body.id}/pay`, { token: state.bob, body: { method: 'wallet', pin: '9137' } });
  assert.equal(again.status, 409);

  const got = await api('GET', `/v1/payments/${pay.body.id}`, { token: state.sk });
  assert.equal(got.body.fee, 100); // 2,5 %
  assert.equal(got.body.net, 3900);

  await deliverDue();
  const hook = await waitFor(() => hooks.find((h) => JSON.parse(h.raw).type === 'payment.succeeded'));
  const { t, v1 } = Object.fromEntries(hook.sig.split(',').map((kv) => kv.split('=')));
  const expected = crypto.createHmac('sha256', state.whsec).update(`${t}.${hook.raw}`).digest('hex');
  assert.equal(v1, expected);

  const ref = await api('POST', `/v1/payments/${pay.body.id}/refunds`, { token: state.sk, body: { amount: 1500, reason: 'Taille indisponible' } });
  assert.equal(ref.status, 201);
  const after1 = await api('GET', `/v1/payments/${pay.body.id}`, { token: state.sk });
  assert.equal(after1.body.status, 'partially_refunded');
  const tooMuch = await api('POST', `/v1/payments/${pay.body.id}/refunds`, { token: state.sk, body: { amount: 5000 } });
  assert.equal(tooMuch.status, 400);
});

test('marchand : versement des ventes sur le wallet personnel', async () => {
  const before = await api('GET', '/v1/merchants/me', { token: state.alice });
  const sales = before.body.balances.find((b) => b.currency === 'USD').balance;
  assert.ok(sales >= 400);
  const wallet = async () => (await api('GET', '/v1/wallets', { token: state.alice })).body.data.find((w) => w.currency === 'USD').balance;
  const w0 = await wallet();

  const badPin = await api('POST', '/v1/merchants/me/transfer-to-wallet', { token: state.alice, body: { currency: 'USD', amount: 400, pin: '0000' } });
  assert.equal(badPin.status, 401);
  const tooMuch = await api('POST', '/v1/merchants/me/transfer-to-wallet', { token: state.alice, body: { currency: 'USD', amount: sales + 1, pin: '2580' } });
  assert.equal(tooMuch.status, 402);
  const noMerchant = await api('POST', '/v1/merchants/me/transfer-to-wallet', { token: state.bob, body: { currency: 'USD', amount: 100, pin: '9137' } });
  assert.equal(noMerchant.status, 404);

  const t = await api('POST', '/v1/merchants/me/transfer-to-wallet', { token: state.alice, body: { currency: 'USD', amount: 400, pin: '2580' } });
  assert.equal(t.status, 201);
  assert.equal(t.body.type, 'payout');
  assert.equal(t.body.direction, 'credit');
  assert.equal(await wallet(), w0 + 400);
  const after = await api('GET', '/v1/merchants/me', { token: state.alice });
  assert.equal(after.body.balances.find((b) => b.currency === 'USD').balance, sales - 400);
  const hist = await api('GET', '/v1/transactions', { token: state.alice });
  assert.ok(hist.body.data.some((x) => x.id === t.body.id && x.description.startsWith('Versement des ventes')));
});

test('checkout invité : paiement Orange Money direct', async () => {
  const pay = await api('POST', '/v1/payments', { token: state.sk, body: { amount: 2500000, currency: 'CDF', description: 'Sac' } });
  const r = await api('POST', `/v1/checkout/${pay.body.id}/pay`, { body: { method: 'mobile_money', phone: '0841234567' } });
  assert.equal(r.body.status, 'processing');
  const done = await waitFor(async () => { const v = await api('GET', `/v1/payments/${pay.body.id}`, { token: state.sk }); return v.body.status === 'succeeded' && v.body; });
  assert.equal(done.payer.operator, 'orange');
  assert.equal(done.method, 'mobile_money');
  // remboursement Mobile Money (décaissement)
  // remboursement total impossible : la commission n'est pas restituée, le solde net ne suffit pas
  const full = await api('POST', `/v1/payments/${pay.body.id}/refunds`, { token: state.sk, body: {} });
  assert.equal(full.status, 402);
  const ref = await api('POST', `/v1/payments/${pay.body.id}/refunds`, { token: state.sk, body: { amount: 2000000 } });
  assert.equal(ref.status, 201);
  await waitFor(async () => (await q.get('SELECT status FROM transactions WHERE id=?', ref.body.id)).status === 'succeeded');
});

test('checkout invité : carte refusée puis réessai réussi', async () => {
  const pay = await api('POST', '/v1/payments', { token: state.sk, body: { amount: 1200, currency: 'USD' } });
  const dtok = await api('POST', '/sandbox/cards/tokenize', { body: { number: '4000000000000002', exp_month: 1, exp_year: 2031, cvc: '123' } });
  const fail = await api('POST', `/v1/checkout/${pay.body.id}/pay`, { body: { method: 'card', token: dtok.body.token } });
  assert.equal(fail.status, 402);
  const tok = await api('POST', '/sandbox/cards/tokenize', { body: { number: '5555555555554444', exp_month: 1, exp_year: 2031, cvc: '123' } });
  const ok = await api('POST', `/v1/checkout/${pay.body.id}/pay`, { body: { method: 'card', token: tok.body.token } });
  assert.equal(ok.body.status, 'succeeded');
  state.cardPay = pay.body.id;
});

test('remboursement carte : pas de dépassement en concurrence, restitution si le processeur refuse', async () => {
  const id = state.cardPay; // 1200 USD payés par carte
  const [r1, r2] = await Promise.all([
    api('POST', `/v1/payments/${id}/refunds`, { token: state.sk, body: { amount: 1000 } }),
    api('POST', `/v1/payments/${id}/refunds`, { token: state.sk, body: { amount: 1000 } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 400]);
  assert.equal((await api('GET', `/v1/payments/${id}`, { token: state.sk })).body.refunded_amount, 1000);

  const usdBalance = async () => (await api('GET', '/v1/balance', { token: state.sk })).body.available.find((b) => b.currency === 'USD').amount;
  const balBefore = await usdBalance();
  const proc = cardProcessor();
  const original = proc.refund;
  proc.refund = async () => ({ status: 'failed', reason: 'Refus acquéreur (test)' });
  try {
    const fail = await api('POST', `/v1/payments/${id}/refunds`, { token: state.sk, body: { amount: 200 } });
    assert.equal(fail.status, 502);
  } finally {
    proc.refund = original;
  }
  const p = (await api('GET', `/v1/payments/${id}`, { token: state.sk })).body;
  assert.equal(p.refunded_amount, 1000);
  assert.equal(p.status, 'partially_refunded');
  assert.equal(await usdBalance(), balBefore);
});

test('SSRF : adresses internes reconnues', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:10a', '::', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', '::7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '41.243.1.1', '172.32.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '2a00:1450:4007::200e']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('sécurité : outil sandbox réservé à l\'équipe, jetons invalides, cartes de test, mots de passe courants', async () => {
  // L'outil qui change le niveau KYC (et active un compte) n'est plus accessible sans authentification de l'équipe.
  const open = await api('POST', '/sandbox/users/0811111111/kyc', { body: { level: 3 } });
  assert.equal(open.status, 401);
  const asUser = await api('POST', '/sandbox/users/0811111111/kyc', { token: state.bob, body: { level: 3 } });
  assert.equal(asUser.status, 401);

  // Jetons de session malformés ou falsifiés : refus propre (401), jamais d'erreur interne.
  for (const bad of ['a.b.c', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c3JfeCJ9.', `${state.bob.split('.').slice(0, 2).join('.')}.AAAA`, 'x'.repeat(5000)]) {
    assert.equal((await api('GET', '/v1/me', { token: bad })).status, 401, bad.slice(0, 20));
    assert.equal((await api('GET', '/v1/admin/me', { token: bad })).status, 401, bad.slice(0, 20));
  }

  // Réponses de l'API jamais mises en cache.
  const me = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${state.bob}` } });
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.match(me.headers.get('content-security-policy'), /object-src 'none'/);

  // Démonstration : seules les cartes de test sont acceptées ; un jeton fabriqué à la main est refusé.
  const real = await api('POST', '/sandbox/cards/tokenize', { body: { number: '4111 1111 1111 1111', exp_month: 12, exp_year: 2030, cvc: '123' } });
  assert.equal(real.body.error.code, 'test_card_required');
  const forged = `tok_test_${Buffer.from(JSON.stringify({ b: '<img src=x onerror=alert(1)>', l: '<b>1</b>', m: 12, y: 2030, o: 'ok' })).toString('base64url')}`;
  const add = await api('POST', '/v1/cards', { token: state.bob, body: { token: forged } });
  assert.equal(add.body.error.code, 'invalid_card_token');

  // Mots de passe trop courants refusés à l'inscription.
  const otp = await api('POST', '/v1/auth/otp', { body: { email: 'mdp.faible@test.cd', purpose: 'register' } });
  const weak = await api('POST', '/v1/auth/register', { body: { account_type: 'personal', email: 'mdp.faible@test.cd', otp_code: otp.body.sandbox_code, full_name: 'Mot Depasse', password: 'Password1', pin: '4826' } });
  assert.equal(weak.body.error.code, 'weak_password');

  // Résolution DNS contrôlée : une destination interne est refusée au moment de la connexion.
  const { guardedLookup } = await import('../src/netguard.js');
  const err = await new Promise((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
  assert.equal(err?.code, 'EFORBIDDEN');
});

test('retrait Mobile Money échoué -> fonds et frais restitués', async () => {
  const before = (await api('GET', '/v1/wallets', { token: state.bob })).body.data.find((x) => x.currency === 'USD').balance;
  const w = await api('POST', '/v1/withdrawals', { token: state.bob, body: { amount: 1000, currency: 'USD', pin: '9137', phone: '0990000000' } });
  assert.equal(w.status, 202);
  const mid = (await api('GET', '/v1/wallets', { token: state.bob })).body.data.find((x) => x.currency === 'USD').balance;
  assert.equal(mid, before - 1010);
  await waitFor(async () => (await api('GET', `/v1/transactions/${w.body.id}`, { token: state.bob })).body.status === 'failed');
  const afterBal = (await api('GET', '/v1/wallets', { token: state.bob })).body.data.find((x) => x.currency === 'USD').balance;
  assert.equal(afterBal, before);
});

test('versement marchand + solde', async () => {
  const bal = await api('GET', '/v1/balance', { token: state.sk });
  const usd = bal.body.available.find((b) => b.currency === 'USD').amount;
  assert.ok(usd > 0);
  const p = await api('POST', '/v1/payouts', { token: state.sk, body: { amount: 1000, currency: 'USD', phone: '0812345678' } });
  assert.equal(p.status, 202);
});

test('PIN bloqué après 5 erreurs', async () => {
  for (let i = 0; i < 5; i++) await api('POST', '/v1/transfers', { token: state.alice, body: { to_phone: '0971112222', amount: 100, currency: 'USD', pin: '1111' } });
  const r = await api('POST', '/v1/transfers', { token: state.alice, body: { to_phone: '0971112222', amount: 100, currency: 'USD', pin: '2580' } });
  assert.equal(r.status, 423);
});

// ---------------- KYC niveau 2 ----------------
/** Faux JPEG (signature FF D8 FF + octets aléatoires) : le serveur vérifie la signature, pas le contenu. */
const fakeJpeg = (size = 20_000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(size)]);
async function upload(token, kind, buf, type = 'image/jpeg') {
  const r = await fetch(`${base}/v1/kyc/files/${kind}`, { method: 'POST', headers: { 'Content-Type': type, Authorization: `Bearer ${token}` }, body: buf });
  return { status: r.status, body: await r.json() };
}
async function uploadSet(token, kinds = ['id_front', 'id_back', 'selfie']) {
  const files = {};
  for (const k of kinds) {
    const r = await upload(token, k, fakeJpeg());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    files[k] = r.body.id;
  }
  return files;
}
const admin = (method, path, body) => api(method, `/v1/admin${path}`, { token: ADMIN_KEY, body });

test('KYC : envoi des pièces, chiffrement, refus puis validation au back-office', async () => {
  const st = await api('GET', '/v1/kyc', { token: state.bob });
  assert.equal(st.body.kyc_level, 1);
  assert.equal(st.body.can_submit, true);

  assert.equal((await upload(state.bob, 'id_front', Buffer.from('pas une image'.repeat(2000)), 'image/png')).status, 415);
  assert.equal((await upload(state.bob, 'id_front', fakeJpeg(100))).body.error.code, 'image_too_small');
  assert.equal((await upload(state.bob, 'passeport', fakeJpeg())).status, 400);
  assert.equal((await upload(state.bob, 'id_front', fakeJpeg(6 * 1024 * 1024))).status, 413);

  // Fichier chiffré au repos : le contenu en clair n'apparaît pas sur le disque
  const clear = fakeJpeg();
  const up = await upload(state.bob, 'id_front', clear);
  const row = await q.get('SELECT storage_key FROM kyc_files WHERE id=?', up.body.id);
  const onDisk = fs.readFileSync(pathMod.join(process.env.KYC_STORAGE_DIR, `${row.storage_key}.enc`));
  assert.equal(onDisk.includes(clear.subarray(100, 132)), false);

  const files = await uploadSet(state.bob);
  const base1 = { document_type: 'voter_card', document_number: 'cd-1234 5678', date_of_birth: '1990-04-12' };
  const noBack = await api('POST', '/v1/kyc/submissions', { token: state.bob, body: { ...base1, files: { id_front: files.id_front, selfie: files.selfie } } });
  assert.equal(noBack.body.error.code, 'missing_file');
  const minor = await api('POST', '/v1/kyc/submissions', { token: state.bob, body: { ...base1, date_of_birth: `${new Date().getFullYear() - 15}-01-01`, files } });
  assert.equal(minor.body.error.code, 'underage');
  const stolen = await api('POST', '/v1/kyc/submissions', { token: state.alice, body: { ...base1, files } });
  assert.equal(stolen.body.error.code, 'invalid_file'); // fichiers d'un autre utilisateur

  const sub = await api('POST', '/v1/kyc/submissions', { token: state.bob, body: { ...base1, files } });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.status, 'pending');
  assert.equal(sub.body.document_number, '•••678'); // masqué côté utilisateur
  const twice = await api('POST', '/v1/kyc/submissions', { token: state.bob, body: { ...base1, files: await uploadSet(state.bob) } });
  assert.equal(twice.status, 409);

  // Back-office : accès protégé
  assert.equal((await api('GET', '/v1/admin/kyc/submissions')).status, 401);
  assert.equal((await api('GET', '/v1/admin/kyc/submissions', { token: state.bob })).status, 401);
  const list = await admin('GET', '/kyc/submissions');
  const item = list.body.data.find((x) => x.id === sub.body.id);
  assert.equal(item.document_number, 'CD12345678');
  const img = await fetch(`${base}/v1/admin/kyc/submissions/${sub.body.id}/files/id_front`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('cache-control'), 'no-store');
  const got = Buffer.from(await img.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), (await q.get('SELECT sha256 FROM kyc_files WHERE id=?', files.id_front)).sha256);

  assert.equal((await admin('POST', `/kyc/submissions/${sub.body.id}/reject`, {})).body.error.code, 'reason_required');
  const rej = await admin('POST', `/kyc/submissions/${sub.body.id}/reject`, { reason: 'Photo floue ou illisible' });
  assert.equal(rej.body.status, 'rejected');
  assert.equal(rej.body.reviewer, 'conformite (clé)'); // clé de service : distinguée des comptes nominatifs
  const st2 = await api('GET', '/v1/kyc', { token: state.bob });
  assert.equal(st2.body.last_submission.review_note, 'Photo floue ou illisible');
  assert.equal(st2.body.can_submit, true);

  const reused = await api('POST', '/v1/kyc/submissions', { token: state.bob, body: { ...base1, files } });
  assert.equal(reused.body.error.code, 'file_already_used');
  const sub2 = await api('POST', '/v1/kyc/submissions', { token: state.bob, body: { ...base1, files: await uploadSet(state.bob) } });
  assert.equal(sub2.status, 201);
  const ok = await admin('POST', `/kyc/submissions/${sub2.body.id}/approve`, {});
  assert.equal(ok.body.status, 'approved');
  assert.equal((await admin('POST', `/kyc/submissions/${sub2.body.id}/approve`, {})).status, 409);

  const me = await api('GET', '/v1/me', { token: state.bob });
  assert.equal(me.body.limits.kyc_level, 2);
  assert.equal(me.body.limits.perTxnUsd, 1000);
  assert.equal((await upload(state.bob, 'selfie', fakeJpeg())).body.error.code, 'already_verified');

  const audit = await admin('GET', '/audit');
  const actions = audit.body.data.map((a) => a.action);
  for (const a of ['kyc.approve', 'kyc.reject', 'kyc.view_file']) assert.ok(actions.includes(a), a);
});

test('KYC : pièce déjà validée sur un autre compte -> alerte et validation bloquée', async () => {
  const c = await register({ phone: '0891234567', full_name: 'Usurpateur Test', password: 'motdepasse5', pin: '7391' });
  assert.equal(c.status, 201);
  const sub = await api('POST', '/v1/kyc/submissions', {
    token: c.body.token,
    body: { document_type: 'voter_card', document_number: 'CD12345678', date_of_birth: '1985-01-01', files: await uploadSet(c.body.token) },
  });
  assert.equal(sub.status, 201);
  const list = await admin('GET', '/kyc/submissions');
  assert.equal(list.body.data.find((x) => x.id === sub.body.id).flagged, true);
  const view = await admin('GET', `/kyc/submissions/${sub.body.id}`);
  assert.equal(view.body.duplicates.same_document_number[0].phone, '+243971112222');
  const blocked = await admin('POST', `/kyc/submissions/${sub.body.id}/approve`, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'duplicate_document');
  const noNote = await admin('POST', `/kyc/submissions/${sub.body.id}/approve`, { override_duplicates: true });
  assert.equal(noNote.body.error.code, 'note_required');
  await admin('POST', `/kyc/submissions/${sub.body.id}/reject`, { reason: 'Pièce déjà utilisée par un autre compte' });
  assert.equal((await q.get('SELECT kyc_level FROM users WHERE phone=?', '+243891234567')).kyc_level, 1);
});

// ---------------- Rapprochement ----------------
const MIN = 60_000;
const bobCdf = async () => (await api('GET', '/v1/wallets', { token: state.bob })).body.data.find((x) => x.currency === 'CDF').balance;
const txnStatus = async (id) => (await q.get('SELECT status FROM transactions WHERE id=?', id)).status;

test('transactions en attente : callback perdu et appel incertain récupérés, blocages signalés', async () => {
  // Callback perdu : l'opérateur a encaissé mais ne prévient pas
  const lost = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 100000, currency: 'CDF', phone: '0821119999', operator: 'mpesa' } });
  // Délai dépassé côté Pay243 alors que l'opérateur a exécuté : la transaction doit rester en attente, pas échouer
  const uncertain = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 150000, currency: 'CDF', phone: '0821118888', operator: 'mpesa' } });
  assert.equal(uncertain.status, 202);
  assert.equal(uncertain.body.status, 'pending');
  // Opérateur muet : ni callback ni statut
  const stuckIn = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 120000, currency: 'CDF', phone: '0821117777', operator: 'mpesa' } });
  const before = await bobCdf();
  const stuckOut = await api('POST', '/v1/withdrawals', { token: state.bob, body: { amount: 50000, currency: 'CDF', pin: '9137', phone: '0821117777', operator: 'mpesa' } });
  assert.equal(stuckOut.status, 202);
  state.recon = { lost: lost.body.id, uncertain: uncertain.body.id, stuckIn: stuckIn.body.id, stuckOut: stuckOut.body.id, beforeOut: before };
  await sleep(60);

  const r1 = await sweepPending({ nowMs: Date.now() + 3 * MIN });
  assert.ok(r1.resolved >= 2);
  assert.equal(await txnStatus(lost.body.id), 'succeeded');
  assert.equal(await txnStatus(uncertain.body.id), 'succeeded');
  assert.equal(await txnStatus(stuckIn.body.id), 'pending'); // trop tôt pour conclure

  const r2 = await sweepPending({ nowMs: Date.now() + 31 * MIN });
  assert.ok(r2.expired >= 1);
  assert.equal(await txnStatus(stuckIn.body.id), 'failed');
  assert.equal(await txnStatus(stuckOut.body.id), 'pending'); // un décaissement n'échoue jamais d'office

  const r3 = await sweepPending({ nowMs: Date.now() + 61 * MIN });
  assert.ok(r3.flagged >= 1);
  assert.equal(await txnStatus(stuckOut.body.id), 'pending');
  const again = await sweepPending({ nowMs: Date.now() + 62 * MIN });
  assert.equal(again.flagged, 0); // pas de doublon d'alerte

  const exc = (await admin('GET', '/reconciliation/exceptions')).body.data;
  assert.ok(exc.find((e) => e.kind === 'collection_expired' && e.transaction.id === stuckIn.body.id));
  assert.ok(exc.find((e) => e.kind === 'payout_stuck' && e.transaction.id === stuckOut.body.id));
});

test('traitement des écarts : validation tardive d\'un encaissement, échec confirmé d\'un retrait', async () => {
  const exc = (await admin('GET', '/reconciliation/exceptions')).body.data;
  const expired = exc.find((e) => e.kind === 'collection_expired' && e.transaction.id === state.recon.stuckIn);
  const stuck = exc.find((e) => e.kind === 'payout_stuck' && e.transaction.id === state.recon.stuckOut);

  assert.equal((await admin('POST', `/reconciliation/exceptions/${expired.id}/resolve`, { action: 'apply_success' })).body.error.code, 'note_required');
  const cdf0 = await bobCdf();
  const ok = await admin('POST', `/reconciliation/exceptions/${expired.id}/resolve`, { action: 'apply_success', note: 'Confirmé sur le portail M-Pesa, réf. vue par la finance' });
  assert.equal(ok.body.status, 'resolved');
  assert.equal(ok.body.resolution, 'applied_success');
  assert.equal(await txnStatus(state.recon.stuckIn), 'succeeded');
  assert.equal(await bobCdf(), cdf0 + 120000);
  assert.equal((await admin('POST', `/reconciliation/exceptions/${expired.id}/resolve`, { action: 'acknowledge', note: 'deuxième traitement' })).status, 409);

  const out = await admin('POST', `/reconciliation/exceptions/${stuck.id}/resolve`, { action: 'apply_failure', note: 'Opérateur confirme : jamais exécuté' });
  assert.equal(out.body.resolution, 'applied_failure');
  assert.equal(await txnStatus(state.recon.stuckOut), 'failed');
  assert.equal(await bobCdf(), cdf0 + 120000 + 50000 + 500); // montant + frais restitués

  const actions = (await admin('GET', '/audit')).body.data.map((a) => a.action);
  assert.ok(actions.includes('recon.applied_success') && actions.includes('recon.applied_failure'));
});

test('rapprochement avec le relevé M-Pesa : écarts détectés, réimport contrôlé', async () => {
  const date = localDate();
  const { start, end } = businessDay(date);
  // Encaissement que l'opérateur a réussi mais que Pay243 attend encore
  const pending = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 70000, currency: 'CDF', phone: '0831117777', operator: 'mpesa' } });

  const ours = await q.all("SELECT * FROM transactions WHERE operator='mpesa' AND method='mobile_money' AND status='succeeded' AND created_at >= ? AND created_at < ? ORDER BY created_at", start, end);
  assert.ok(ours.length >= 4, `au moins 4 opérations M-Pesa réussies (${ours.length})`);
  const dir = (t) => (['topup', 'payment'].includes(t.type) ? 'collect' : 'disburse');
  const line = (ref, id, type, minor, cur, st) => `${ref},${id},${type},${(minor / 100).toFixed(2)},${cur},${st},${new Date().toISOString()}`;
  const [dropped, altered, ...rest] = ours;
  const rows = [
    line(altered.provider_ref, altered.id, dir(altered), altered.amount + 100, altered.currency, 'COMPLETED'),
    ...rest.map((t) => line(t.provider_ref || '', t.id, dir(t), t.amount, t.currency, 'succeeded')),
    line(`mock_mpesa_${pending.body.id}`, pending.body.id, 'collect', 70000, 'CDF', 'succeeded'),
    line('MP-INCONNU-001', '', 'collect', 25000, 'CDF', 'succeeded'),
    line('MP-ECHEC-002', '', 'collect', 10000, 'CDF', 'failed'),
  ];
  const csv = ['provider_ref,reference,type,amount,currency,status,timestamp', ...rows].join('\n');
  const send = (body, qs) => fetch(`${base}/v1/admin/reconciliation/statements?${qs}`, { method: 'POST', headers: { 'Content-Type': 'text/csv', Authorization: `Bearer ${ADMIN_KEY}` }, body })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  assert.equal((await send(csv, 'operator=mpesa&date=2026-13-45')).status, 400);
  assert.equal((await send('provider_ref,amount\nX,1', `operator=mpesa&date=${date}`)).body.error.code, 'invalid_statement');
  assert.equal((await fetch(`${base}/v1/admin/reconciliation/statements?operator=mpesa&date=${date}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv })).status, 401);

  const run = await send(csv, `operator=mpesa&date=${date}`);
  assert.equal(run.status, 201, JSON.stringify(run.body));
  assert.equal(run.body.rows, rows.length);
  assert.equal(run.body.matched, rest.length);
  assert.deepEqual(run.body.summary.exceptions_by_kind, { amount_mismatch: 1, not_at_operator: 1, not_credited: 1, unknown_operator_txn: 1 });
  assert.notEqual(run.body.summary.totals.CDF.difference ?? run.body.summary.totals.USD.difference, undefined);

  const exc = (await admin('GET', '/reconciliation/exceptions')).body.data.filter((e) => e.run_id === run.body.id);
  assert.equal(exc.find((e) => e.kind === 'not_at_operator').transaction.id, dropped.id);
  const notCredited = exc.find((e) => e.kind === 'not_credited');
  const mismatch = exc.find((e) => e.kind === 'amount_mismatch');
  assert.equal((await admin('POST', `/reconciliation/exceptions/${mismatch.id}/resolve`, { action: 'apply_success', note: 'tentative de validation' })).body.error.code, 'amount_mismatch');
  const unknown = exc.find((e) => e.kind === 'unknown_operator_txn');
  assert.equal((await admin('POST', `/reconciliation/exceptions/${unknown.id}/resolve`, { action: 'apply_success', note: 'tentative de validation' })).body.error.code, 'no_transaction');
  const cdf0 = await bobCdf();
  await admin('POST', `/reconciliation/exceptions/${notCredited.id}/resolve`, { action: 'apply_success', note: 'Relevé M-Pesa fait foi : crédit du client' });
  assert.equal(await bobCdf(), cdf0 + 70000);

  const dup = await send(csv, `operator=mpesa&date=${date}`);
  assert.equal(dup.status, 409);
  const replaced = await send(csv, `operator=mpesa&date=${date}&replace=1`);
  assert.equal(replaced.status, 201);
  assert.equal((await q.get('SELECT status FROM recon_runs WHERE id=?', run.body.id)).status, 'superseded');
  assert.equal((await q.get("SELECT COUNT(*) AS n FROM recon_exceptions WHERE run_id=? AND status='open'", run.body.id)).n, 0);
});

test('cantonnement : monnaie électronique en circulation et couverture', async () => {
  const r = await admin('GET', '/reconciliation/safeguarding?trust_USD=999999999');
  const usd = r.body.data.find((x) => x.currency === 'USD');
  const sum = async (owner) => (await q.get('SELECT COALESCE(SUM(balance),0) AS s FROM wallets WHERE owner_type=? AND currency=?', owner, 'USD')).s;
  const inFlight = (await q.get("SELECT COALESCE(SUM(balance),0) AS s FROM wallets WHERE owner_type='system' AND owner_id='payout_pending' AND currency='USD'")).s;
  assert.equal(usd.e_money_outstanding, (await sum('user')) + (await sum('merchant')) + inFlight);
  assert.equal(usd.covered, true);
  assert.equal(usd.coverage, 999999999 - usd.e_money_outstanding);
  assert.equal(r.body.data.find((x) => x.currency === 'CDF').covered, null); // solde bancaire non fourni
  assert.equal((await admin('GET', '/reconciliation/safeguarding?trust_USD=abc')).status, 400);
});

// ---------------- Concurrence (garanties PostgreSQL : verrous de ligne, mises à jour conditionnelles) ----------------
test('concurrence : transferts simultanés au-delà du solde -> un seul passe', async () => {
  const c = await register({ phone: '0821230001', full_name: 'Carine Concurrence', password: 'motdepasse6', pin: '3917' });
  state.carol = c.body.token;
  const top = await api('POST', '/v1/topups', { token: state.carol, body: { amount: 200000, currency: 'CDF' } });
  await waitFor(async () => (await api('GET', `/v1/transactions/${top.body.id}`, { token: state.carol })).body.status === 'succeeded');
  const send = () => api('POST', '/v1/transfers', { token: state.carol, body: { to_phone: '0971112222', amount: 120000, currency: 'CDF', pin: '3917' } });
  const results = await Promise.all([send(), send(), send()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 402, 402]);
  const cdf = (await api('GET', '/v1/wallets', { token: state.carol })).body.data.find((x) => x.currency === 'CDF').balance;
  assert.equal(cdf, 80000);
});

test('concurrence : même Idempotency-Key envoyée deux fois en même temps -> un seul débit', async () => {
  const headers = { 'Idempotency-Key': `idem-${crypto.randomUUID()}` };
  const send = () => api('POST', '/v1/transfers', { token: state.carol, headers, body: { to_phone: '0971112222', amount: 10000, currency: 'CDF', pin: '3917' } });
  const [a, b] = await Promise.all([send(), send()]);
  const codes = [a.status, b.status].sort();
  assert.ok(codes[0] === 201 && [201, 409].includes(codes[1]), `statuts : ${codes}`);
  const replay = await send();
  assert.equal(replay.status, 201);
  const cdf = (await api('GET', '/v1/wallets', { token: state.carol })).body.data.find((x) => x.currency === 'CDF').balance;
  assert.equal(cdf, 70000, 'débité une seule fois');
});

test('concurrence : un lien payé simultanément par wallet et par carte -> un seul encaissement', async () => {
  const pay = await api('POST', '/v1/payments', { token: state.sk, body: { amount: 30000, currency: 'CDF', description: 'Course simultanée' } });
  const tok = await api('POST', '/sandbox/cards/tokenize', { body: { number: '4242 4242 4242 4242', exp_month: 12, exp_year: 2030, cvc: '123' } });
  const [w, c, m] = await Promise.all([
    api('POST', `/v1/checkout/${pay.body.id}/pay`, { token: state.carol, body: { method: 'wallet', pin: '3917' } }),
    api('POST', `/v1/checkout/${pay.body.id}/pay`, { body: { method: 'card', token: tok.body.token } }),
    api('POST', `/v1/checkout/${pay.body.id}/pay`, { body: { method: 'mobile_money', phone: '0841230002' } }),
  ]);
  const ok = [w, c, m].filter((r) => r.status === 200);
  assert.equal(ok.length, 1, `réussites : ${[w, c, m].map((r) => r.status)}`);
  await sleep(80); // laisse un éventuel encaissement Mobile Money se dénouer
  const settled = await q.all("SELECT id FROM transactions WHERE payment_id=? AND type='payment' AND status='succeeded'", pay.body.id);
  assert.equal(settled.length, 1);
});

test('concurrence : callback et interrogation de statut simultanés -> crédité une seule fois', async () => {
  const before = await bobCdf();
  const t = await api('POST', '/v1/topups', { token: state.bob, body: { amount: 40000, currency: 'CDF', phone: '0821237777', operator: 'mpesa' } });
  await Promise.all(Array.from({ length: 5 }, () => handleProviderResult({ txnId: t.body.id, status: 'succeeded' })));
  assert.equal(await bobCdf(), before + 40000);
  const entries = await q.all('SELECT * FROM ledger_entries WHERE txn_id=?', t.body.id);
  assert.equal(entries.length, 2);
});

test('base : un solde client ne peut pas devenir négatif, même par une requête directe', async () => {
  const w = await q.get("SELECT id FROM wallets WHERE owner_type='user' ORDER BY balance ASC LIMIT 1");
  await assert.rejects(q.run('UPDATE wallets SET balance = -1 WHERE id=?', w.id), (e) => e.code === '23514');
  const p = await q.get("SELECT id, amount FROM payments WHERE status='succeeded' LIMIT 1");
  await assert.rejects(q.run('UPDATE payments SET refunded_amount = ? WHERE id=?', p.amount + 1, p.id), (e) => e.code === '23514');
});

// ---------------------------------------------------------------------
//  Paramètres du compte
// ---------------------------------------------------------------------
test('paramètres : profil, identifiant @, fuseau, photo, nom verrouillé après KYC', async () => {
  const r = await register({ email: 'sarah.mwamba@test.cd', full_name: 'Sarah Mwamba', password: 'motdepasse8', pin: '7351', device_id: 'device-sarah-0001-test' });
  const tok = r.body.token;
  state.sarah = tok;
  const s = await api('GET', '/v1/me/settings', { token: tok, headers: { 'X-Device-Id': 'device-sarah-0001-test' } });
  assert.equal(s.status, 200);
  assert.equal(s.body.user.timezone, 'Africa/Kinshasa');
  assert.equal(s.body.devices.length, 1);
  assert.equal(s.body.devices[0].current, true);
  assert.equal(s.body.user.notifications.security_email, true);

  const p = await api('PATCH', '/v1/me', { token: tok, body: { full_name: '  Sarah   Mwamba Kalala ', handle: '@Sarah.Mwamba', timezone: 'Africa/Lubumbashi', nationality: 'cd' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.user.full_name, 'Sarah Mwamba Kalala');
  assert.equal(p.body.user.handle, 'sarah.mwamba');
  assert.equal(p.body.user.timezone, 'Africa/Lubumbashi');
  assert.equal((await api('PATCH', '/v1/me', { token: state.bob, body: { handle: 'sarah.mwamba' } })).body.error.code, 'handle_taken');
  assert.equal((await api('PATCH', '/v1/me', { token: tok, body: { handle: 'a!' } })).body.error.code, 'invalid_handle');
  assert.equal((await api('PATCH', '/v1/me', { token: tok, body: { timezone: 'Mars/Olympus' } })).body.error.code, 'invalid_timezone');

  // Transfert vers @identifiant
  const t = await api('POST', '/v1/transfers', { token: state.bob, body: { to: '@Sarah.Mwamba', amount: 100, currency: 'USD', pin: '9137' } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const back = await api('POST', '/v1/transfers', { token: tok, body: { to: 'patrick.ilunga@test.cd', amount: 100, currency: 'USD', pin: '7351' } });
  assert.equal(back.status, 201);

  // Photo : contrôle du contenu réel, pas seulement du Content-Type
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const put = await fetch(`${base}/v1/me/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'image/jpeg' }, body: jpeg });
  assert.equal(put.status, 200);
  assert.match((await put.json()).user.avatar_url, /^data:image\/jpeg;base64,/);
  const fake = await fetch(`${base}/v1/me/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'image/png' }, body: Buffer.from('<svg onload=alert(1)>') });
  assert.equal(fake.status, 400);

  // Après vérification d'identité, le nom et la nationalité ne se changent plus librement
  await q.run('UPDATE users SET kyc_level=2 WHERE email=?', 'sarah.mwamba@test.cd');
  assert.equal((await api('PATCH', '/v1/me', { token: tok, body: { full_name: 'Autre Nom' } })).body.error.code, 'name_locked');
  assert.equal((await api('PATCH', '/v1/me', { token: tok, body: { nationality: 'BE' } })).body.error.code, 'nationality_locked');
  assert.equal((await api('PATCH', '/v1/me', { token: tok, body: { timezone: 'Africa/Kinshasa' } })).status, 200);
  await q.run('UPDATE users SET kyc_level=1 WHERE email=?', 'sarah.mwamba@test.cd');
});

test('paramètres : changement d\'email et de numéro vérifiés par code', async () => {
  const tok = state.sarah;
  assert.equal((await api('POST', '/v1/me/email/otp', { token: tok, body: { email: 'grace.mbuyi@test.cd' } })).body.error.code, 'email_taken');
  const otp = await api('POST', '/v1/me/email/otp', { token: tok, body: { email: 'Sarah.K@Test.cd' } });
  assert.equal(otp.status, 201);
  assert.equal(otp.body.channel, 'email');
  assert.equal((await api('POST', '/v1/me/email', { token: tok, body: { email: 'sarah.k@test.cd', otp_code: otp.body.sandbox_code, password: 'faux-mdp' } })).body.error.code, 'invalid_password');
  const ok = await api('POST', '/v1/me/email', { token: tok, body: { email: 'sarah.k@test.cd', otp_code: otp.body.sandbox_code, password: 'motdepasse8' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.email, 'sarah.k@test.cd');
  // Le code ne sert qu'une fois
  assert.notEqual((await api('POST', '/v1/me/email', { token: tok, body: { email: 'sarah.k@test.cd', otp_code: otp.body.sandbox_code, password: 'motdepasse8' } })).status, 200);
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'sarah.k@test.cd', password: 'motdepasse8', device_id: 'device-sarah-0001-test' } })).status, 200);

  assert.equal((await api('POST', '/v1/me/phone/otp', { token: tok, body: { phone: '0812345678' } })).body.error.code, 'phone_taken');
  const sms = await api('POST', '/v1/me/phone/otp', { token: tok, body: { phone: '0991234567' } });
  assert.equal(sms.body.channel, 'sms');
  const ph = await api('POST', '/v1/me/phone', { token: tok, body: { phone: '+243 99 123 4567', otp_code: sms.body.sandbox_code } });
  assert.equal(ph.status, 200, JSON.stringify(ph.body));
  assert.equal(ph.body.user.phone, '+243991234567');
  assert.equal(ph.body.user.phone_verified, true);
  assert.equal(ph.body.user.operator, 'airtel');
});

test('paramètres : adresses, une seule principale', async () => {
  const tok = state.sarah;
  const a1 = await api('POST', '/v1/me/addresses', { token: tok, body: { line1: '12 avenue du Commerce', city: 'Kinshasa', province: 'Kinshasa' } });
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.is_primary, true); // la première devient principale
  const a2 = await api('POST', '/v1/me/addresses', { token: tok, body: { line1: '5 boulevard Kamanyola', city: 'Lubumbashi', country: 'cd' } });
  assert.equal(a2.body.is_primary, false);
  assert.equal((await api('POST', '/v1/me/addresses', { token: tok, body: { city: 'Goma' } })).body.error.code, 'invalid_line1');
  await api('PATCH', `/v1/me/addresses/${a2.body.id}`, { token: tok, body: { is_primary: true, line2: 'Appartement 3' } });
  let list = (await api('GET', '/v1/me/addresses', { token: tok })).body.data;
  assert.deepEqual(list.map((a) => [a.id, a.is_primary]), [[a2.body.id, true], [a1.body.id, false]]);
  assert.equal(list[0].line2, 'Appartement 3');
  await api('DELETE', `/v1/me/addresses/${a2.body.id}`, { token: tok });
  list = (await api('GET', '/v1/me/addresses', { token: tok })).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].is_primary, true); // la restante est promue
  assert.equal((await api('DELETE', `/v1/me/addresses/${a2.body.id}`, { token: state.bob })).status, 404);
});

test('paramètres : mot de passe changé -> autres sessions déconnectées ; PIN ; appareils', async () => {
  const old = state.sarah;
  const other = (await api('POST', '/v1/auth/login', { body: { identifier: 'sarah.k@test.cd', password: 'motdepasse8', device_id: 'device-sarah-0001-test' } })).body.token;
  assert.equal((await api('POST', '/v1/me/password', { token: old, body: { current_password: 'mauvais', new_password: 'nouveau-mdp-1' } })).body.error.code, 'invalid_password');
  const ch = await api('POST', '/v1/me/password', { token: old, body: { current_password: 'motdepasse8', new_password: 'nouveau-mdp-1' } });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal((await api('GET', '/v1/me', { token: old })).status, 401);
  assert.equal((await api('GET', '/v1/me', { token: other })).status, 401);
  assert.equal((await api('GET', '/v1/me', { token: ch.body.token })).status, 200);
  state.sarah = ch.body.token;
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'sarah.k@test.cd', password: 'motdepasse8' } })).status, 401);

  assert.equal((await api('POST', '/v1/me/pin', { token: state.sarah, body: { current_pin: '7351', new_pin: '1111' } })).body.error.code, 'weak_pin');
  assert.equal((await api('POST', '/v1/me/pin', { token: state.sarah, body: { current_pin: '7351', new_pin: '8264' } })).status, 200);
  assert.equal((await api('POST', '/v1/transfers', { token: state.sarah, body: { to: '@nobody', amount: 1, currency: 'USD', pin: '7351' } })).body.error.code, 'recipient_not_found');

  // Révocation globale : seule la session qui la demande reste ouverte
  const rev = await api('POST', '/v1/me/sessions/revoke', { token: state.sarah, headers: { 'X-Device-Id': 'device-sarah-0001-test' } });
  assert.equal(rev.status, 200);
  assert.equal((await api('GET', '/v1/me', { token: state.sarah })).status, 401);
  state.sarah = rev.body.token;
  const devs = (await api('GET', '/v1/me/devices', { token: state.sarah, headers: { 'X-Device-Id': 'device-sarah-0001-test' } })).body.data;
  assert.deepEqual(devs.map((d) => d.current), [true]);
  assert.equal((await api('DELETE', `/v1/me/devices/${devs[0].id}`, { token: state.sarah })).status, 200);
});

test('paramètres : notifications, relevé CSV, export, passage en entreprise, fermeture', async () => {
  const tok = state.sarah;
  const n = await api('PUT', '/v1/me/notifications', { token: tok, body: { payments_email: false, product_email: true, security_email: false, inconnu: true } });
  assert.deepEqual(n.body.user.notifications, { payments_email: false, payments_sms: false, security_email: true, product_email: true });

  const months = (await api('GET', '/v1/me/statements', { token: tok })).body.data;
  assert.ok(months.length >= 1);
  const csv = await fetch(`${base}/v1/me/statements/${months[0].month}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const raw = Buffer.from(await csv.arrayBuffer());
  assert.equal(raw.subarray(0, 3).toString('hex'), 'efbbbf'); // BOM UTF-8 : accents corrects dans Excel
  const text = raw.subarray(3).toString('utf8');
  assert.match(text, /^Date;Référence;Type/);
  assert.match(text, /;transfer;/);
  assert.match(text, /;-1,00;/); // débit de 1,00 $
  const exp = await api('GET', '/v1/me/export', { token: tok });
  assert.equal(exp.body.profile.email, 'sarah.k@test.cd');
  assert.equal(exp.body.addresses.length, 1);
  assert.ok(exp.body.transactions.length >= 2);

  const biz = await api('POST', '/v1/me/business', { token: tok, body: { business_name: 'Sarah Couture' } });
  assert.equal(biz.status, 200, JSON.stringify(biz.body));
  assert.equal(biz.body.user.account_type, 'business');
  assert.match(biz.body.merchant.secret_key, /^sk_test_/);
  const again = await api('POST', '/v1/me/business', { token: tok, body: { business_name: 'Sarah Couture' } });
  assert.equal(again.body.merchant.secret_key, undefined); // pas de second marchand

  // Fermeture refusée tant qu'il reste de l'argent
  await api('POST', '/v1/transfers', { token: state.bob, body: { to: '@sarah.mwamba', amount: 250, currency: 'USD', pin: '9137' } });
  assert.equal((await api('POST', '/v1/me/close', { token: tok, body: { password: 'nouveau-mdp-1', confirm: 'FERMER' } })).body.error.code, 'balance_not_zero');
  await api('POST', '/v1/transfers', { token: tok, body: { to: 'patrick.ilunga@test.cd', amount: 250, currency: 'USD', pin: '8264' } });
  assert.equal((await api('POST', '/v1/me/close', { token: tok, body: { password: 'nouveau-mdp-1' } })).body.error.code, 'confirmation_required');
  const closed = await api('POST', '/v1/me/close', { token: tok, body: { password: 'nouveau-mdp-1', confirm: 'FERMER', reason: 'test' } });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal((await api('GET', '/v1/me', { token: tok })).status, 401);
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'sarah.k@test.cd', password: 'nouveau-mdp-1' } })).body.error.code, 'account_closed');
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 100, currency: 'USD' } })).status, 401);
  assert.equal((await api('POST', '/v1/transfers', { token: state.bob, body: { to: '@sarah.mwamba', amount: 100, currency: 'USD', pin: '9137' } })).body.error.code, 'recipient_not_found');
});

// ---------------------------------------------------------------------
//  Emails transactionnels et mot de passe oublié
// ---------------------------------------------------------------------
test('emails : bienvenue, nouvel appareil, préférences de paiement respectées', async () => {
  const { outbox } = await import('../src/providers/email/index.js');
  const mails = (to) => outbox.filter((m) => m.to === to);
  const r = await register({ email: 'nadia.kasongo@test.cd', full_name: 'Nadia Kasongo', password: 'motdepasse4', pin: '5173' });
  assert.equal(r.status, 201);
  const welcome = mails('nadia.kasongo@test.cd').find((m) => m.tag === 'account');
  assert.match(welcome.subject, /Bienvenue sur Pay243/);
  assert.match(welcome.html, /Vérifier mon identité/); // l'activation passe par la vérification d'identité
  assert.match(welcome.text, /Bienvenue, Nadia/);
  const biz = await register({ account_type: 'business', email: 'vente@kinshoes.cd', business_name: 'Kin Shoes', full_name: 'Rachel Mbala', password: 'motdepasse4', pin: '5173' });
  const bizWelcome = mails('vente@kinshoes.cd').find((m) => m.tag === 'account');
  assert.match(bizWelcome.subject, /Kin Shoes/);
  assert.doesNotMatch(bizWelcome.html + bizWelcome.text, new RegExp(biz.body.merchant.secret_key)); // la clé ne part jamais par email

  // Nouvel appareil : code, puis alerte de sécurité une fois l'appareil validé
  const first = await api('POST', '/v1/auth/login', { body: { identifier: 'nadia.kasongo@test.cd', password: 'motdepasse4', device_id: 'nadia-new-laptop-0001', device_label: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' } });
  assert.equal(first.status, 403);
  const ok = await api('POST', '/v1/auth/login', { body: { identifier: 'nadia.kasongo@test.cd', password: 'motdepasse4', device_id: 'nadia-new-laptop-0001', device_label: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', otp_code: first.body.error.details.sandbox_code } });
  assert.equal(ok.status, 200);
  const alert = mails('nadia.kasongo@test.cd').find((m) => m.tag === 'security');
  assert.match(alert.subject, /Nouvelle connexion/);
  assert.match(alert.text, /Chrome sur Windows/);

  // Argent reçu : email selon les préférences
  await api('POST', '/v1/transfers', { token: state.bob, body: { to: 'nadia.kasongo@test.cd', amount: 100, currency: 'USD', pin: '9137', note: 'Remboursement' } });
  const recu = mails('nadia.kasongo@test.cd').filter((m) => m.tag === 'payments');
  assert.equal(recu.length, 1);
  assert.match(recu[0].text, /Remboursement/);
  await api('PUT', '/v1/me/notifications', { token: ok.body.token, body: { payments_email: false } });
  await api('POST', '/v1/transfers', { token: state.bob, body: { to: 'nadia.kasongo@test.cd', amount: 100, currency: 'USD', pin: '9137' } });
  assert.equal(mails('nadia.kasongo@test.cd').filter((m) => m.tag === 'payments').length, 1);
  state.nadia = ok.body.token;
});

test('mot de passe oublié : code par email, sessions fermées, aucune fuite d\'information', async () => {
  const { outbox } = await import('../src/providers/email/index.js');
  const unknown = await api('POST', '/v1/auth/password/forgot', { body: { email: 'inconnu@test.cd' } });
  assert.equal(unknown.status, 200); // même réponse qu'un compte existant
  assert.equal(unknown.body.sandbox_code, undefined);
  assert.equal(outbox.filter((m) => m.to === 'inconnu@test.cd').length, 0);

  const f = await api('POST', '/v1/auth/password/forgot', { body: { email: 'Nadia.Kasongo@test.cd' } });
  assert.equal(f.status, 200);
  assert.match(f.body.sandbox_code, /^\d{6}$/);
  assert.match(outbox.at(-1).subject, /réinitialisation/);
  assert.equal((await api('POST', '/v1/auth/password/reset', { body: { email: 'nadia.kasongo@test.cd', otp_code: '000000', new_password: 'nouveau-mdp-9' } })).body.error.code, 'invalid_otp');
  assert.equal((await api('POST', '/v1/auth/password/reset', { body: { email: 'nadia.kasongo@test.cd', otp_code: f.body.sandbox_code, new_password: 'court' } })).body.error.code, 'weak_password');
  const r = await api('POST', '/v1/auth/password/reset', { body: { email: 'nadia.kasongo@test.cd', otp_code: f.body.sandbox_code, new_password: 'nouveau-mdp-9', device_id: 'nadia-phone-000000001' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api('GET', '/v1/me', { token: state.nadia })).status, 401); // ancienne session fermée
  assert.equal((await api('GET', '/v1/me', { token: r.body.token })).status, 200);
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'nadia.kasongo@test.cd', password: 'motdepasse4' } })).status, 401);
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'nadia.kasongo@test.cd', password: 'nouveau-mdp-9', device_id: 'nadia-phone-000000001' } })).status, 200);
  assert.match(outbox.filter((m) => m.to === 'nadia.kasongo@test.cd').at(-1).subject, /réinitialisé/);
  // Le code ne sert qu'une fois
  assert.notEqual((await api('POST', '/v1/auth/password/reset', { body: { email: 'nadia.kasongo@test.cd', otp_code: f.body.sandbox_code, new_password: 'encore-un-mdp' } })).status, 200);
});

test('codes jamais renvoyés par l\'API quand un vrai fournisseur envoie les messages', async () => {
  const { config, exposesCodes } = await import('../src/config.js');
  assert.equal(exposesCodes('email'), true); // pilote mock : démo et tests
  const saved = { email: config.email.driver, mode: config.mode };
  try {
    config.email.driver = 'resend';
    assert.equal(exposesCodes('email'), false);
    assert.equal(exposesCodes('sms'), true); // SMS toujours simulé
    config.email.driver = 'mock'; config.mode = 'live';
    assert.equal(exposesCodes('email'), false);
  } finally { config.email.driver = saved.email; config.mode = saved.mode; }
});

// ---------------------------------------------------------------------
//  Back-office : équipe, rôles et permissions
// ---------------------------------------------------------------------
const bo = (token) => (method, path, body) => api(method, `/v1/admin${path}`, { token, body });

/** Connexion d'un membre : mot de passe, puis code envoyé par email. */
async function staffLogin(email, password) {
  const step1 = await api('POST', '/v1/admin/auth/login', { body: { email, password } });
  assert.equal(step1.status, 200, JSON.stringify(step1.body));
  assert.equal(step1.body.otp_required, true);
  const step2 = await api('POST', '/v1/admin/auth/login', { body: { email, password, otp_code: step1.body.sandbox_code } });
  assert.equal(step2.status, 200, JSON.stringify(step2.body));
  return step2.body;
}

test('back-office : super administrateur, code à chaque connexion, mot de passe provisoire à changer', async () => {
  const { createStaff } = await import('../src/staff.js');
  await createStaff({ email: 'chef@pay243.com', full_name: 'Chef Plateforme', role: 'super_admin', password: 'provisoire-2026' });
  assert.equal((await api('POST', '/v1/admin/auth/login', { body: { email: 'chef@pay243.com', password: 'mauvais' } })).status, 401);
  const s = await staffLogin('chef@pay243.com', 'provisoire-2026');
  assert.equal(s.must_change_password, true);
  const sa = bo(s.token);
  assert.equal((await sa('GET', '/dashboard')).body.error.code, 'password_change_required');
  assert.equal((await sa('GET', '/me')).body.role, 'super_admin');
  assert.equal((await sa('POST', '/auth/password', { current_password: 'provisoire-2026', new_password: 'court-123' })).body.error.code, 'weak_password');
  const ch = await sa('POST', '/auth/password', { current_password: 'provisoire-2026', new_password: 'Chef-Pay243-2026!' });
  assert.equal(ch.status, 200);
  assert.equal((await sa('GET', '/dashboard')).status, 401); // ancienne session fermée
  state.superToken = ch.body.token;
  const dash = await bo(state.superToken)('GET', '/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.users.total >= 1);
  assert.equal(dash.body.mode, 'sandbox');
  // Jetons cloisonnés : un jeton de l'équipe n'ouvre pas le wallet, et inversement
  assert.equal((await api('GET', '/v1/me', { token: state.superToken })).status, 401);
  assert.equal((await api('GET', '/v1/admin/me', { token: state.bob })).status, 401);
});

test('back-office : hiérarchie des rôles et permissions', async () => {
  const { outbox } = await import('../src/providers/email/index.js');
  const sa = bo(state.superToken);
  const adm = await sa('POST', '/staff', { email: 'admin@pay243.com', full_name: 'Amani Admin', role: 'admin' });
  assert.equal(adm.status, 201, JSON.stringify(adm.body));
  const invite = outbox.filter((m) => m.to === 'admin@pay243.com' && m.tag === 'staff').at(-1);
  assert.match(invite.text, new RegExp(adm.body.temporary_password));
  const sup = await sa('POST', '/staff', { email: 'support@pay243.com', full_name: 'Sam Support', role: 'support' });
  assert.equal(sup.status, 201);
  assert.equal((await sa('POST', '/staff', { email: 'admin@pay243.com', full_name: 'Doublon', role: 'support' })).body.error.code, 'staff_exists');

  // Administrateur : gère les rangs inférieurs, pas les administrateurs ni le super administrateur
  const a1 = await staffLogin('admin@pay243.com', adm.body.temporary_password);
  state.adminToken = (await bo(a1.token)('POST', '/auth/password', { current_password: adm.body.temporary_password, new_password: 'Amani-Admin-2026!' })).body.token;
  const a = bo(state.adminToken);
  assert.equal((await a('POST', '/staff', { email: 'admin2@pay243.com', full_name: 'Autre Admin', role: 'admin' })).status, 403);
  assert.equal((await a('POST', '/staff', { email: 'kyc@pay243.com', full_name: 'Clara Conformité', role: 'compliance' })).status, 201);
  const chef = (await sa('GET', '/staff')).body.data.find((x) => x.email === 'chef@pay243.com');
  assert.equal((await a('PATCH', `/staff/${chef.id}`, { status: 'suspended' })).status, 403);
  assert.equal((await a('PUT', '/settings', { 'fx.usd_to_cdf': 3000 })).status, 403); // paramètres : super administrateur uniquement
  const roles = (await a('GET', '/roles')).body.data;
  assert.equal(roles.find((r) => r.id === 'admin').assignable, false);
  assert.equal(roles.find((r) => r.id === 'support').assignable, true);

  // Support : consultation et aide, sans suspension, KYC ni équipe
  const s1 = await staffLogin('support@pay243.com', sup.body.temporary_password);
  state.supportToken = (await bo(s1.token)('POST', '/auth/password', { current_password: sup.body.temporary_password, new_password: 'Sam-Support-2026!' })).body.token;
  const s = bo(state.supportToken);
  const found = await s('GET', '/users?q=patrick.ilunga');
  assert.equal(found.status, 200);
  const patrick = found.body.data[0];
  assert.equal(patrick.email, 'patrick.ilunga@test.cd');
  assert.equal((await s('GET', `/users/${patrick.id}`)).body.wallets.length, 2);
  assert.equal((await s('POST', `/users/${patrick.id}/unlock-pin`, {})).status, 200);
  assert.equal((await s('POST', `/users/${patrick.id}/suspend`, { reason: 'Test de permission' })).status, 403);
  assert.equal((await s('GET', '/kyc/submissions')).status, 403);
  assert.equal((await s('GET', '/staff')).status, 403);
  assert.equal((await s('GET', '/audit')).status, 403);
  assert.ok((await s('GET', '/transactions?limit=5')).body.data.length > 0);
});

test('back-office : suspension d\'un compte et de son espace marchand', async () => {
  const a = bo(state.adminToken);
  const biz = await register({ account_type: 'business', email: 'boutique.suspendue@test.cd', business_name: 'Boutique Suspendue', full_name: 'Paul Kabeya', password: 'motdepasse6', pin: '3816', device_id: 'paul-device-000000001' });
  const uid = biz.body.user.id;
  assert.equal((await a('POST', `/users/${uid}/suspend`, { reason: 'x' })).body.error.code, 'reason_required');
  assert.equal((await a('POST', `/users/${uid}/suspend`, { reason: 'Activité suspecte signalée' })).status, 200);
  assert.equal((await api('GET', '/v1/me', { token: biz.body.token })).status, 401);
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'boutique.suspendue@test.cd', password: 'motdepasse6', device_id: 'paul-device-000000001' } })).body.error.code, 'account_disabled');
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 100, currency: 'USD' } })).body.error.code, 'merchant_suspended');
  assert.equal((await api('POST', '/v1/transfers', { token: state.bob, body: { to: 'boutique.suspendue@test.cd', amount: 100, currency: 'USD', pin: '9137' } })).body.error.code, 'recipient_not_found');
  assert.equal((await a('POST', `/users/${uid}/reactivate`, { reason: 'Vérification faite, rien à signaler' })).status, 200);
  assert.equal((await api('POST', '/v1/auth/login', { body: { identifier: 'boutique.suspendue@test.cd', password: 'motdepasse6', device_id: 'paul-device-000000001' } })).status, 200);
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 100, currency: 'USD' } })).status, 201);
  const m = (await a('GET', '/merchants?q=Boutique Suspendue')).body.data[0];
  assert.equal((await a('POST', `/merchants/${m.id}/revoke-keys`, { reason: 'Clé exposée publiquement' })).body.revoked, 1);
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 100, currency: 'USD' } })).status, 401);
  const audit = (await bo(state.superToken)('GET', '/audit?action=user.')).body.data;
  assert.ok(audit.some((x) => x.action === 'user.suspend' && x.actor === 'Amani Admin <admin@pay243.com>' && x.details.reason === 'Activité suspecte signalée'));
});

test('back-office : paramètres de la plateforme appliqués à chaud (super administrateur)', async () => {
  const sa = bo(state.superToken);
  const before = (await api('GET', '/v1/wallets', { token: state.bob })).body.fx.usd_to_cdf;
  const up = await sa('PUT', '/settings', { 'fx.usd_to_cdf': 3100, 'fees.withdrawal_percent': 1.5 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await api('GET', '/v1/wallets', { token: state.bob })).body.fx.usd_to_cdf, 3100);
  assert.equal((await sa('PUT', '/settings', { 'kyc.1.per_txn_usd': 999999 })).body.error.code, 'invalid_setting'); // > plafond journalier
  assert.equal((await sa('PUT', '/settings', { 'inconnu': 1 })).body.error.code, 'unknown_setting');
  assert.equal((await sa('PUT', '/settings', { 'signup.enabled': false })).status, 200);
  assert.equal((await api('POST', '/v1/auth/otp', { body: { email: 'ferme@test.cd' } })).body.error.code, 'signup_closed');
  // Retour aux valeurs par défaut
  await sa('PUT', '/settings', { 'fx.usd_to_cdf': null, 'fees.withdrawal_percent': null, 'signup.enabled': null });
  assert.equal((await api('GET', '/v1/wallets', { token: state.bob })).body.fx.usd_to_cdf, before);
  assert.equal((await api('POST', '/v1/auth/otp', { body: { email: 'ouvert@test.cd' } })).status, 201);
  const audit = (await sa('GET', '/audit?action=settings')).body.data;
  assert.ok(audit.length >= 2);
});

test('back-office : toujours un super administrateur actif, verrouillage après 5 erreurs', async () => {
  const key = bo(ADMIN_KEY); // clé de service (super administrateur)
  const chef = (await key('GET', '/staff')).body.data.find((x) => x.email === 'chef@pay243.com');
  assert.equal((await key('PATCH', `/staff/${chef.id}`, { role: 'admin' })).body.error.code, 'last_super_admin');
  assert.equal((await bo(state.superToken)('PATCH', `/staff/${chef.id}`, { status: 'suspended' })).body.error.code, 'self_edit');
  for (let i = 0; i < 5; i++) await api('POST', '/v1/admin/auth/login', { body: { email: 'kyc@pay243.com', password: 'faux-mot-de-passe' } });
  assert.equal((await api('POST', '/v1/admin/auth/login', { body: { email: 'kyc@pay243.com', password: 'faux-mot-de-passe' } })).body.error.code, 'staff_locked');
  // Un membre suspendu perd immédiatement l'accès
  const sup = (await key('GET', '/staff')).body.data.find((x) => x.email === 'support@pay243.com');
  const supToken = state.supportToken;
  assert.equal((await bo(supToken)('GET', '/users')).status, 200);
  assert.equal((await bo(state.adminToken)('PATCH', `/staff/${sup.id}`, { status: 'suspended' })).status, 200);
  assert.equal((await bo(supToken)('GET', '/users')).status, 401);
});

// ---------------------------------------------------------------------
//  Activation : aucune opération avant la validation de l'identité
// ---------------------------------------------------------------------
test('compte non activé : aucune opération avant la validation de l\'identité par l\'équipe', async () => {
  const r = await register({ activate: false, email: 'nouveau.client@test.cd', full_name: 'Nouveau Client', password: 'motdepasse7', pin: '5926', phone: '0823456781' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.activated, false);
  const tok = r.body.token;
  const me = await api('GET', '/v1/me', { token: tok });
  assert.equal(me.body.verification.status, 'required');
  // Toutes les opérations sont refusées
  for (const [path, body] of [
    ['/v1/topups', { amount: 1000, currency: 'CDF' }],
    ['/v1/transfers', { to: 'patrick.ilunga@test.cd', amount: 100, currency: 'USD', pin: '5926' }],
    ['/v1/withdrawals', { amount: 100, currency: 'CDF', pin: '5926' }],
    ['/v1/conversions', { from_currency: 'USD', to_currency: 'CDF', amount: 100, pin: '5926' }],
    ['/v1/merchants', { name: 'Boutique Avant Activation' }],
  ]) {
    const x = await api('POST', path, { token: tok, body });
    assert.equal(x.status, 403, `${path} ${JSON.stringify(x.body)}`);
    assert.equal(x.body.error.code, 'account_not_verified');
  }
  // On ne peut pas non plus lui envoyer d'argent
  const toHim = await api('POST', '/v1/transfers', { token: state.bob, body: { to: 'nouveau.client@test.cd', amount: 100, currency: 'USD', pin: '9137' } });
  assert.equal(toHim.body.error.code, 'recipient_not_verified');
  // Consultation, paramètres et vérification d'identité restent possibles
  assert.equal((await api('GET', '/v1/wallets', { token: tok })).status, 200);
  assert.equal((await api('PATCH', '/v1/me', { token: tok, body: { handle: 'nouveau.client' } })).status, 200);

  // Envoi de la pièce : statut « en cours »
  const sub = await api('POST', '/v1/kyc/submissions', { token: tok, body: { document_type: 'passport', document_number: 'OB7654321', date_of_birth: '1992-04-12', files: await uploadSet(tok) } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal((await api('GET', '/v1/me', { token: tok })).body.verification.status, 'pending');
  const pending = await api('POST', '/v1/topups', { token: tok, body: { amount: 1000, currency: 'CDF' } });
  assert.match(pending.body.error.message, /en cours de vérification/);

  // Un compte entreprise non activé ne peut pas encaisser par API
  const biz = await register({ activate: false, account_type: 'business', email: 'atelier.nouveau@test.cd', business_name: 'Atelier Nouveau', full_name: 'Joseph Mutombo', password: 'motdepasse7', pin: '5926' });
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 500, currency: 'USD' } })).body.error.code, 'account_not_verified');

  // Validation par l'équipe : le compte est activé et l'utilisateur prévenu
  const { outbox } = await import('../src/providers/email/index.js');
  const ok = await api('POST', `/v1/admin/kyc/submissions/${sub.body.id}/approve`, { token: ADMIN_KEY, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = await api('GET', '/v1/me', { token: tok });
  assert.equal(after.body.user.activated, true);
  assert.equal(after.body.verification.status, 'verified');
  assert.match(outbox.filter((m) => m.to === 'nouveau.client@test.cd').at(-1).subject, /activé/);
  assert.equal((await api('POST', '/v1/topups', { token: tok, body: { amount: 1000, currency: 'CDF' } })).status, 202);

  // Activation manuelle par un administrateur (niveau KYC 2), et retrait de l'activation
  const bizId = biz.body.user.id;
  assert.equal((await api('POST', `/v1/admin/users/${bizId}/kyc-level`, { token: ADMIN_KEY, body: { level: 2, reason: 'Dossier vérifié en agence' } })).body.user.activated, true);
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 500, currency: 'USD' } })).status, 201);
  assert.equal((await api('POST', `/v1/admin/users/${bizId}/kyc-level`, { token: ADMIN_KEY, body: { level: 1, reason: 'Pièce expirée, nouvelle vérification requise' } })).body.user.activated, false);
  assert.equal((await api('POST', '/v1/payments', { token: biz.body.merchant.secret_key, body: { amount: 500, currency: 'USD' } })).body.error.code, 'account_not_verified');
});

test('grand livre équilibré (partie double)', async () => {
  await sleep(100);
  for (const row of await auditLedger()) assert.equal(row.total, 0, `devise ${row.currency} déséquilibrée`);
  const sums = await q.all('SELECT e.txn_id FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id GROUP BY e.txn_id, w.currency HAVING SUM(e.amount) != 0');
  assert.equal(sums.length, 0);
});
