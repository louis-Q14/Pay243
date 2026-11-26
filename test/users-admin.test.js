// Back-office : gestion des utilisateurs (supprimer = fermer et anonymiser, modifier, réinitialiser le mot de passe,
// notes internes, message à l'utilisateur), avec les droits de chaque rôle.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_OTP = '1000';
process.env.RATE_LIMIT_LOGIN_ACCOUNT = '1000';
const SUPER_KEY = 'adm_test_users_super_0123456789ab';
const ADMIN_KEY = 'adm_test_users_admin_0123456789ab';
const SUPPORT_KEY = 'adm_test_users_support_012345678';
process.env.ADMIN_KEYS = `chef:${SUPER_KEY},amani:${ADMIN_KEY}:admin,guichet:${SUPPORT_KEY}:support`;

const { openDb, closeDb, q } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { createTxn, move, getWallet, systemWallet } = await import('../src/ledger.js');

let server; let base;
before(async () => { await openDb({}); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.close(); await closeDb(); });

async function api(method, path, { token, body } = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const as = (key) => (method, path, body) => api(method, `/v1/admin${path}`, { token: key, body });
const admin = as(ADMIN_KEY); const support = as(SUPPORT_KEY);

let seq = 0;
async function register(full_name, email, extra = {}) {
  seq += 1;
  const otp = await api('POST', '/v1/auth/otp', { body: { email, purpose: 'register' } });
  const security_questions = [['birth_city', 'Goma'], ['first_school', 'Lycée Wima'], ['mother_maiden', 'Mbuyi']].map(([question, answer]) => ({ question, answer, answer_confirm: answer }));
  const emergency_contact = { full_name: 'Contact Urgence', address: '1, avenue de la Paix, Kinshasa', phone: `08990000${String(seq).padStart(2, '0')}`, email: `urgence${seq}@proche.cd`, relation: 'Parent' };
  const r = await api('POST', '/v1/auth/register', { body: { account_type: 'personal', full_name, email, password: 'motdepasse5', pin: '4826', device_id: `dev-${email}-0000000`, phone: `08980000${String(seq).padStart(2, '0')}`, security_questions, emergency_contact, ...extra, otp_code: otp.body.sandbox_code } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await q.run('UPDATE users SET activated_at=? WHERE id=?', new Date().toISOString(), r.body.user.id);
  return r.body;
}
async function fund(userId, amount) {
  const w = await getWallet('user', userId, 'USD');
  const t = await createTxn({ type: 'topup', status: 'succeeded', amount, currency: 'USD', method: 'mobile_money', from_wallet: (await systemWallet('float_mpesa', 'USD')).id, to_wallet: w.id });
  await move(t.id, t.from_wallet, w.id, amount);
}

test('utilisateurs : supprimer = fermer et anonymiser, réservé à l’administrateur, refusé tant qu’il reste de l’argent', async () => {
  const rich = await register('Marc Ilunga', 'marc.ilunga@test.cd', { phone: '0991112233' });
  await fund(rich.user.id, 500);
  const empty = await register('Sarah Mwamba', 'sarah.mwamba@test.cd', { phone: '0994445566' });

  assert.equal((await support('POST', `/users/${empty.user.id}/delete`, { reason: 'Demande du client par email' })).status, 403, 'le support ne peut pas supprimer un compte');
  assert.equal((await admin('POST', `/users/${empty.user.id}/delete`, { reason: 'x' })).body.error?.code, 'reason_required', 'motif obligatoire');
  const refused = await admin('POST', `/users/${rich.user.id}/delete`, { reason: 'Demande du client par email' });
  assert.equal(refused.body.error?.code, 'balance_not_zero', `POST /v1/admin/users/:id/delete (src/routes/admin.js) : un compte avec un solde ne se supprime pas (${JSON.stringify(refused.body)})`);

  const del = await admin('POST', `/users/${empty.user.id}/delete`, { reason: 'Demande du client par email' });
  assert.equal(del.status, 200, `POST /v1/admin/users/:id/delete : ${JSON.stringify(del.body)}`);
  const u = (await admin('GET', `/users/${empty.user.id}`)).body.user;
  assert.equal(u.status, 'closed', 'le compte est fermé');
  assert.equal(u.full_name, 'Compte supprimé', 'le nom est effacé');
  assert.ok(!String(u.email).includes('sarah.mwamba'), 'l’email est effacé');
  assert.equal(u.phone, null, 'le téléphone est effacé');
  assert.equal((await api('GET', '/v1/me', { token: empty.token })).status, 401, 'ses sessions sont fermées');
  const taken = await q.get("SELECT COUNT(*)::int AS n FROM users WHERE email='sarah.mwamba@test.cd' OR phone='+243994445566'");
  assert.equal(taken.n, 0, 'l’email et le numéro sont de nouveau libres pour une nouvelle inscription');
  const audit = (await as(SUPER_KEY)('GET', '/audit?action=user.')).body.data;
  assert.ok(audit.some((x) => x.action === 'user.delete' && x.target === empty.user.id), 'la suppression est journalisée');
});

const why = 'Correction demandée par le client, pièce vérifiée';
const S = {};

test('utilisateurs : l’administrateur corrige nom, email, téléphone et identifiant', async () => {
  S.jp = await register('Jean Pierre Kasongo', 'jp.kasongo@test.cd', { phone: '0997778899' });
  const r = await admin('PATCH', `/users/${S.jp.user.id}`, { full_name: 'Jean-Pierre Kasongo Mbuyi', email: 'JP.Kasongo.Mbuyi@test.cd', phone: '081 222 3344', handle: '@jpkasongo', reason: why });
  assert.equal(r.status, 200, `PATCH /v1/admin/users/:id (src/routes/admin.js) : ${JSON.stringify(r.body)}`);
  assert.deepEqual([r.body.user.full_name, r.body.user.email, r.body.user.phone, r.body.user.handle],
    ['Jean-Pierre Kasongo Mbuyi', 'jp.kasongo.mbuyi@test.cd', '+243812223344', 'jpkasongo'], 'les informations sont corrigées et normalisées');
});

test('utilisateurs : réinitialiser le mot de passe envoie un code au client et ferme ses sessions', async () => {
  const u = await register('Nadine Mbombo', 'nadine.mbombo@test.cd');
  const { outbox } = await import('../src/providers/email/index.js');
  const n0 = outbox.length;
  const r = await support('POST', `/users/${u.user.id}/password-reset`, { reason: 'Client bloqué, appel vérifié' });
  assert.equal(r.status, 200, `POST /v1/admin/users/:id/password-reset (src/routes/admin.js) : ${JSON.stringify(r.body)}`);
  assert.equal((await api('GET', '/v1/me', { token: u.token })).status, 401, 'les sessions ouvertes sont fermées');
  assert.ok(outbox.slice(n0).some((m) => m.to === 'nadine.mbombo@test.cd' && /\d{6}/.test(m.text || '')), 'le client reçoit un code de réinitialisation par email');
});

test('utilisateurs : l’équipe ajoute des notes internes sur un compte, visibles dans sa fiche', async () => {
  const u = await register('Patience Ngoy', 'patience.ngoy@test.cd');
  const r = await support('POST', `/users/${u.user.id}/notes`, { body: 'A appelé le 26/11 : carte refusée, conseillé Mobile Money.' });
  assert.equal(r.status, 201, `POST /v1/admin/users/:id/notes (src/routes/admin.js) : ${JSON.stringify(r.body)}`);
  const notes = (await admin('GET', `/users/${u.user.id}`)).body.notes;
  assert.equal(notes?.[0]?.body, 'A appelé le 26/11 : carte refusée, conseillé Mobile Money.', 'la note apparaît dans la fiche du compte');
  assert.equal(notes[0].author, 'guichet (clé)', 'avec son auteur');
});

test('utilisateurs : l’équipe écrit à un client, le message arrive dans son centre de messages', async () => {
  const u = await register('Didier Kalombo', 'didier.kalombo@test.cd');
  const r = await support('POST', `/users/${u.user.id}/message`, { subject: 'Votre pièce d’identité', message: 'Bonjour, la photo de votre carte d’électeur est floue. Pouvez-vous en envoyer une nouvelle ?' });
  assert.equal(r.status, 201, `POST /v1/admin/users/:id/message (src/routes/admin.js) : ${JSON.stringify(r.body)}`);
  const inbox = (await api('GET', '/v1/support/tickets', { token: u.token })).body;
  const t = inbox.data.find((x) => x.subject === 'Votre pièce d’identité');
  assert.ok(t, 'la conversation apparaît dans le centre de messages du client');
  assert.equal(inbox.unread, 1, 'le message est marqué non lu');
});

test('utilisateurs : le support ne peut ni modifier les informations ni supprimer un compte', async () => {
  const u = await register('Rachel Tshibangu', 'rachel.tshibangu@test.cd');
  assert.equal((await support('PATCH', `/users/${u.user.id}`, { full_name: 'Rachel T.', reason: why })).status, 403, 'modifier : administrateur uniquement');
  assert.equal((await support('POST', `/users/${u.user.id}/delete`, { reason: why })).status, 403, 'supprimer : administrateur uniquement');
});

test('utilisateurs : la fiche montre le contact d’urgence du client', async () => {
  const u = await register('Béatrice Lukusa', 'beatrice.lukusa@test.cd');
  const d = (await support('GET', `/users/${u.user.id}`)).body;
  assert.equal(d.emergency_contact?.full_name, 'Contact Urgence', `GET /v1/admin/users/:id (src/routes/admin.js) doit inclure le contact d’urgence : ${JSON.stringify(d.emergency_contact)}`);
});
