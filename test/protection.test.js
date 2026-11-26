// Protection des achats Pay243 : 1,2 % payés par le marchand sur chaque vente, litiges entre acheteur et vendeur,
// argent retenu chez le vendeur pendant le litige, décision de l'équipe au back-office.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_OTP = '1000';
process.env.RATE_LIMIT_MONEY = '1000';
const ADMIN_KEY = 'adm_test_protection_0123456789abc';
process.env.ADMIN_KEYS = `litiges:${ADMIN_KEY}`;

const { openDb, closeDb, q } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { auditLedger, createTxn, move, getWallet, systemWallet } = await import('../src/ledger.js');

let server; let base;
before(async () => { await openDb({}); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.close(); await closeDb(); });

async function api(method, path, { token, body } = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const admin = (method, path, body) => api(method, `/v1/admin${path}`, { token: ADMIN_KEY, body });

let seq = 0;
async function register(body) {
  const email = `${body.full_name.toLowerCase().replace(/[^a-z]+/g, '.')}@test.cd`;
  if (body.account_type === 'business') {
    seq += 1;
    body.business = { rccm: `CD/KNG/RCCM/24-B-9${String(seq).padStart(4, '0')}`, address: '1, avenue du Port, Gombe', city: 'Kinshasa', phone: '0812345678', email: `contact${seq}@kinelectro.cd` };
  }
  const otp = await api('POST', '/v1/auth/otp', { body: { email, purpose: 'register' } });
  const r = await api('POST', '/v1/auth/register', { body: { account_type: 'personal', ...body, email, otp_code: otp.body.sandbox_code } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await q.run('UPDATE users SET activated_at=? WHERE id=?', new Date().toISOString(), r.body.user.id);
  return r.body;
}

/** Une boutique (Kin Électro) et une acheteuse (Esther, 300 $ sur son wallet). */
const S = {};
async function shop() {
  if (S.sk) return S;
  const seller = await register({ account_type: 'business', business_name: 'Kin Électro', full_name: 'Jean Mukendi', password: 'motdepasse7', pin: '7391' });
  const buyer = await register({ full_name: 'Esther Kalala', password: 'motdepasse8', pin: '6284' });
  const m = (await api('GET', '/v1/merchants/me', { token: seller.token })).body;
  assert.equal((await admin('POST', `/merchants/${m.id}/access`, { action: 'enable', reason: 'Dossier vérifié' })).status, 200);
  const k = await api('POST', '/v1/merchants/me/keys', { token: seller.token, body: { mode: 'test' } });
  const w = await getWallet('user', buyer.user.id, 'USD');
  const t = await createTxn({ type: 'topup', status: 'succeeded', amount: 30000, currency: 'USD', method: 'mobile_money', from_wallet: (await systemWallet('float_mpesa', 'USD')).id, to_wallet: w.id });
  await move(t.id, t.from_wallet, w.id, 30000);
  Object.assign(S, { seller: seller.token, buyer: buyer.token, buyerId: buyer.user.id, sk: k.body.secret_key, merchantId: m.id });
  return S;
}
/** Achat payé depuis le wallet de l'acheteuse ; renvoie l'identifiant du paiement. */
async function purchase(amount, description) {
  await shop();
  const pay = await api('POST', '/v1/payments', { token: S.sk, body: { amount, currency: 'USD', description } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const paid = await api('POST', `/v1/checkout/${pay.body.id}/pay`, { token: S.buyer, body: { method: 'wallet', pin: '6284' } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  return pay.body.id;
}

test('protection des achats : 1,2 % payés par l’acheteur connecté en plus du prix, le marchand ne paie que sa commission', async () => {
  const setting = (await admin('GET', '/settings')).body.data.find((s) => s.key === 'fees.protection_percent');
  assert.ok(setting, 'paramètre fees.protection_percent manquant (src/services/platformSettings.js)');
  assert.equal(setting.value, 1.2, 'protection des achats : 1,2 % par défaut');
  await shop();
  const usd = async () => (await api('GET', '/v1/wallets', { token: S.buyer })).body.data.find((w) => w.currency === 'USD').balance;
  const b0 = await usd();
  const pay = await api('POST', '/v1/payments', { token: S.sk, body: { amount: 5000, currency: 'USD', description: 'Téléphone reconditionné' } });
  const view = (await api('GET', `/v1/checkout/${pay.body.id}`, { token: S.buyer })).body;
  assert.equal(view.customer?.protection_fee, 60, 'GET /v1/checkout/:id (src/routes/checkout.js) doit annoncer à l’acheteur connecté ses 1,2 % de protection');
  assert.equal((await api('POST', `/v1/checkout/${pay.body.id}/pay`, { token: S.buyer, body: { method: 'wallet', pin: '6284' } })).status, 200);
  assert.equal(await usd(), b0 - 5060, 'l’acheteur paie le prix + 1,2 % de protection');
  const id = pay.body.id;
  const got = (await api('GET', `/v1/payments/${id}`, { token: S.sk })).body;
  assert.equal(got.protection_fee, 60, 'serializePayment (src/services/payments.js) doit indiquer protection_fee : 1,2 % de 50 $');
  assert.equal(got.fee, 125, 'le marchand ne paie que sa commission de 2,5 %');
  assert.equal(got.net, 5000 - 125);
  const fund = await q.get("SELECT balance FROM wallets WHERE owner_type='system' AND owner_id='protection_fund' AND currency='USD'");
  assert.equal(Number(fund?.balance), 60, 'les 1,2 % vont au fonds de protection des achats (compte système protection_fund)');
  for (const row of await auditLedger()) assert.equal(Number(row.total), 0, `grand livre ${row.currency} déséquilibré`);
});

const sellerUsd = async () => (await api('GET', '/v1/merchants/me', { token: S.seller })).body.balances.find((b) => b.currency === 'USD').balance;

test('litige : l’acheteuse ouvre un litige, le montant est retenu sur le compte du vendeur', async () => {
  const id = await purchase(8000, 'Enceinte Bluetooth');
  const b0 = await sellerUsd();
  const d = await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: id, reason: 'not_received', message: 'Commande payée il y a dix jours, rien reçu.' } });
  assert.equal(d.status, 201, `POST /v1/disputes (src/routes/disputes.js) : ${JSON.stringify(d.body)}`);
  assert.equal(d.body.status, 'open', 'un litige ouvert commence par une conversation avec le vendeur');
  assert.equal(d.body.amount, 8000, 'par défaut, tout le montant payé est contesté');
  assert.equal(d.body.held_amount, 8000, 'le montant contesté est retenu');
  assert.equal(await sellerUsd(), b0 - 8000, 'le montant contesté quitte le solde disponible du vendeur');
  const again = await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: id, reason: 'not_received', message: 'Toujours rien.' } });
  assert.equal(again.status, 409, 'un seul litige ouvert par achat');
  const stranger = await api('POST', '/v1/disputes', { token: S.seller, body: { payment_id: id, reason: 'not_received', message: 'x' } });
  assert.equal(stranger.status, 404, 'seul l’acheteur peut ouvrir un litige sur son achat');
  S.dispute = d.body.id; S.disputedPay = id;
});

test('litige : conversation entre l’acheteuse et le vendeur, invisible des autres', async () => {
  const list = await api('GET', '/v1/disputes', { token: S.seller });
  assert.equal(list.status, 200, `GET /v1/disputes (src/routes/disputes.js) : ${JSON.stringify(list.body)}`);
  const row = list.body.data.find((x) => x.id === S.dispute);
  assert.ok(row, 'le vendeur voit le litige ouvert sur sa vente');
  assert.equal(row.role, 'seller');
  const r = await api('POST', `/v1/disputes/${S.dispute}/messages`, { token: S.seller, body: { message: 'Le colis est parti mardi, je vérifie avec le livreur.' } });
  assert.equal(r.status, 201, `POST /v1/disputes/:id/messages : ${JSON.stringify(r.body)}`);
  const d = await api('GET', `/v1/disputes/${S.dispute}`, { token: S.buyer });
  assert.equal(d.body.role, 'buyer');
  assert.deepEqual(d.body.messages.map((m) => m.author), ['buyer', 'seller'], 'l’acheteuse lit la réponse du vendeur');
  const outsider = await register({ full_name: 'Paul Mbala', password: 'motdepasse6', pin: '1593' });
  assert.equal((await api('GET', `/v1/disputes/${S.dispute}`, { token: outsider.token })).status, 404, 'un tiers ne voit pas le litige');
  assert.equal((await api('POST', `/v1/disputes/${S.dispute}/messages`, { token: outsider.token, body: { message: 'Bonjour à tous' } })).status, 404, 'un tiers ne peut pas écrire');
});

const buyerUsd = async () => (await api('GET', '/v1/wallets', { token: S.buyer })).body.data.find((w) => w.currency === 'USD').balance;

test('litige : remonté à Pay243 après 7 jours, l’équipe donne raison à l’acheteuse et la rembourse', async () => {
  const early = await api('POST', `/v1/disputes/${S.dispute}/escalate`, { token: S.buyer });
  assert.equal(early.body.error?.code, 'escalation_too_early', `POST /v1/disputes/:id/escalate : objet non reçu, 7 jours après le paiement (${JSON.stringify(early.body)})`);
  await q.run('UPDATE payments SET paid_at=? WHERE id=?', new Date(Date.now() - 8 * 86400e3).toISOString(), S.disputedPay);
  const up = await api('POST', `/v1/disputes/${S.dispute}/escalate`, { token: S.buyer });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.status, 'claim', 'le litige devient une réclamation examinée par Pay243');

  const queue = await admin('GET', '/disputes?status=claim');
  assert.equal(queue.status, 200, `GET /v1/admin/disputes (src/routes/admin.js) : ${JSON.stringify(queue.body)}`);
  assert.ok(queue.body.data.some((x) => x.id === S.dispute), 'la réclamation arrive au back-office');

  const b0 = await buyerUsd(); const s0 = await sellerUsd();
  const dec = await admin('POST', `/disputes/${S.dispute}/decide`, { winner: 'buyer', note: 'Aucune preuve de livraison fournie par le vendeur.' });
  assert.equal(dec.status, 200, `POST /v1/admin/disputes/:id/decide : ${JSON.stringify(dec.body)}`);
  assert.equal(dec.body.status, 'won_buyer');
  assert.equal(await buyerUsd(), b0 + 8000, 'l’acheteuse est remboursée sur son wallet Pay243');
  assert.equal(await sellerUsd(), s0, 'le remboursement vient de la retenue, pas du solde disponible du vendeur');
  const pay = (await api('GET', `/v1/payments/${S.disputedPay}`, { token: S.sk })).body;
  assert.equal(pay.status, 'refunded', 'le paiement est marqué remboursé');
  assert.equal((await api('POST', `/v1/disputes/${S.dispute}/messages`, { token: S.buyer, body: { message: 'Merci beaucoup !' } })).status, 409, 'un litige tranché est clos');
  for (const row of await auditLedger()) assert.equal(Number(row.total), 0, `grand livre ${row.currency} déséquilibré`);
});

test('litige : l’équipe donne raison au vendeur, la retenue lui revient et la décision est définitive', async () => {
  const id = await purchase(3000, 'Coque de téléphone');
  const s0 = await sellerUsd();
  const d = (await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: id, reason: 'not_as_described', message: 'La couleur ne correspond pas à la photo.' } })).body;
  assert.equal(await sellerUsd(), s0 - 3000);
  const up = await api('POST', `/v1/disputes/${d.id}/escalate`, { token: S.buyer });
  assert.equal(up.body.status, 'claim', 'objet non conforme : remontée possible sans attendre 7 jours');
  const b0 = await buyerUsd();
  const dec = await admin('POST', `/disputes/${d.id}/decide`, { winner: 'seller', note: 'La couleur exacte figurait dans la description.' });
  assert.equal(dec.body.status, 'won_seller', JSON.stringify(dec.body));
  assert.equal(await sellerUsd(), s0, 'la retenue revient au vendeur');
  assert.equal(await buyerUsd(), b0, 'l’acheteuse n’est pas remboursée');
  assert.equal((await admin('POST', `/disputes/${d.id}/decide`, { winner: 'buyer', note: 'Nouvel examen du dossier' })).status, 409, 'une décision est définitive');
});

test('litige : le vendeur rembourse lui-même depuis la conversation, avec son PIN', async () => {
  const id = await purchase(2000, 'Chargeur USB');
  const d = (await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: id, reason: 'not_as_described', message: 'Le chargeur ne fonctionne pas du tout.' } })).body;
  const b0 = await buyerUsd(); const s0 = await sellerUsd();
  assert.equal((await api('POST', `/v1/disputes/${d.id}/refund`, { token: S.buyer, body: { pin: '6284' } })).status, 404, 'seul le vendeur rembourse');
  assert.equal((await api('POST', `/v1/disputes/${d.id}/refund`, { token: S.seller, body: { pin: '0000' } })).status, 401, 'PIN du vendeur exigé');
  const r = await api('POST', `/v1/disputes/${d.id}/refund`, { token: S.seller, body: { pin: '7391' } });
  assert.equal(r.status, 200, `POST /v1/disputes/:id/refund : ${JSON.stringify(r.body)}`);
  assert.equal(r.body.status, 'closed', 'le litige est clos par le remboursement');
  assert.equal(await buyerUsd(), b0 + 2000, 'l’acheteuse est remboursée');
  assert.equal(await sellerUsd(), s0, 'le remboursement est pris sur la retenue');
});

test('litige : l’acheteuse peut le retirer ; sans remontée sous 20 jours il se clôt seul ; la retenue revient au vendeur', async () => {
  const s0 = await sellerUsd();
  const a = await purchase(1000, 'Écouteurs');
  const da = (await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: a, reason: 'not_received', message: 'Pas encore livré.' } })).body;
  const c = await api('POST', `/v1/disputes/${da.id}/close`, { token: S.buyer });
  assert.equal(c.status, 200, `POST /v1/disputes/:id/close : ${JSON.stringify(c.body)}`);
  assert.equal(c.body.status, 'closed', 'l’acheteuse retire son litige');
  const b = await purchase(1500, 'Câble HDMI');
  const db = (await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: b, reason: 'not_received', message: 'Pas encore livré.' } })).body;
  await q.run('UPDATE disputes SET created_at=? WHERE id=?', new Date(Date.now() - 21 * 86400e3).toISOString(), db.id);
  const { expireDisputes } = await import('../src/services/disputes.js');
  assert.equal(typeof expireDisputes, 'function', 'src/services/disputes.js doit exporter expireDisputes (clôture automatique)');
  await expireDisputes();
  assert.equal((await api('GET', `/v1/disputes/${db.id}`, { token: S.buyer })).body.status, 'closed', 'clos automatiquement après 20 jours sans remontée');
  const net = (x) => x - Math.round(x * 0.025);
  assert.equal(await sellerUsd(), s0 + net(1000) + net(1500), 'les deux retenues sont rendues au vendeur');
  for (const row of await auditLedger()) assert.equal(Number(row.total), 0, `grand livre ${row.currency} déséquilibré`);
});

test('litige : le vendeur est prévenu par email à l’ouverture, les deux parties à la décision', async () => {
  const { outbox } = await import('../src/providers/email/index.js');
  const n0 = outbox.length;
  const mails = () => outbox.slice(n0);
  const id = await purchase(1200, 'Montre');
  const d = (await api('POST', '/v1/disputes', { token: S.buyer, body: { payment_id: id, reason: 'not_as_described', message: 'La montre reçue est rayée.' } })).body;
  assert.ok(mails().some((m) => m.to === 'jean.mukendi@test.cd' && /litige/i.test(m.subject)), 'openDispute (src/services/disputes.js) doit prévenir le vendeur (notifyUser)');
  await api('POST', `/v1/disputes/${d.id}/escalate`, { token: S.buyer });
  await admin('POST', `/disputes/${d.id}/decide`, { winner: 'buyer', note: 'Photos de la montre rayée fournies.' });
  assert.ok(mails().some((m) => m.to === 'esther.kalala@test.cd' && /rembours/i.test(m.subject)), 'l’acheteuse est prévenue de son remboursement');
  assert.ok(mails().some((m) => m.to === 'jean.mukendi@test.cd' && /décision/i.test(m.subject)), 'le vendeur est prévenu de la décision');
});
