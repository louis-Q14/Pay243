// Inscription renforcée : tous les champs obligatoires, 3 questions de sécurité (réponse + confirmation),
// contact d'urgence, document RCCM pour les entreprises, réinitialisation du mot de passe par code + questions.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.RATE_LIMIT_AUTH = '1000';
process.env.RATE_LIMIT_OTP = '1000';
process.env.RATE_LIMIT_LOGIN_ACCOUNT = '1000';
process.env.KYC_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-signup-sec-'));

const { openDb, closeDb, q } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

let server; let base;
before(async () => { await openDb({}); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.close(); await closeDb(); fs.rmSync(process.env.KYC_STORAGE_DIR, { recursive: true, force: true }); });

async function api(method, path, { token, body } = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

let n = 0;
/** Inscription complète d'un particulier ; `over` remplace ou retire (undefined) des champs. */
async function signup(over = {}) {
  n += 1;
  const email = `client${n}@test.cd`;
  const otp = await api('POST', '/v1/auth/otp', { body: { email, purpose: 'register' } });
  const body = {
    account_type: 'personal', email, full_name: `Client Numero ${n}`, password: 'motdepasse5', pin: '4826',
    phone: `09900000${String(n).padStart(2, '0')}`,
    security_questions: [
      { question: 'birth_city', answer: 'Kisangani', answer_confirm: 'Kisangani' },
      { question: 'first_school', answer: 'Institut de la Gombe', answer_confirm: 'Institut de la Gombe' },
      { question: 'mother_maiden', answer: 'Mbuyi', answer_confirm: 'Mbuyi' },
    ],
    emergency_contact: { full_name: 'Marie Kabila', address: '12, avenue Kasa-Vubu, Kinshasa', phone: '0812223344', email: 'marie.kabila@test.cd', relation: 'Sœur' },
    ...over, otp_code: otp.body.sandbox_code,
  };
  return api('POST', '/v1/auth/register', { body });
}

test('inscription : le numéro Mobile Money est obligatoire', async () => {
  const r = await signup({ phone: undefined });
  assert.equal(r.body.error?.code, 'phone_required', `POST /v1/auth/register (src/routes/auth.js) doit exiger le téléphone : ${JSON.stringify(r.body)}`);
});

test('inscription : les questions de sécurité sont obligatoires', async () => {
  assert.equal((await signup({ security_questions: undefined })).body.error?.code, 'security_questions_required', 'POST /v1/auth/register doit exiger 3 questions de sécurité');
});

const Q = (question, answer, confirm = answer) => ({ question, answer, answer_confirm: confirm });

test('inscription : les 3 questions de sécurité doivent être différentes', async () => {
  const dup = [Q('birth_city', 'Goma'), Q('first_school', 'Lycée Wima'), Q('birth_city', 'Bukavu')];
  assert.equal((await signup({ security_questions: dup })).body.error?.code, 'duplicate_security_question', 'une même question ne peut pas être choisie deux fois');
});

test('inscription : chaque réponse de sécurité est confirmée (saisie deux fois)', async () => {
  const mismatch = [Q('birth_city', 'Goma'), Q('first_school', 'Lycée Wima'), Q('mother_maiden', 'Mbuyi', 'Mbuye')];
  assert.equal((await signup({ security_questions: mismatch })).body.error?.code, 'security_answers_mismatch', 'la confirmation doit correspondre à la réponse');
});

test('inscription : une personne à contacter en cas d’urgence est obligatoire', async () => {
  assert.equal((await signup({ emergency_contact: undefined })).body.error?.code, 'emergency_contact_required', 'POST /v1/auth/register doit exiger le contact d’urgence');
});

test('inscription complète d’un particulier : plus aucune information à compléter', async () => {
  const r = await signup();
  assert.deepEqual(r.body.user?.missing, [], `serializeUser (src/routes/auth.js) doit indiquer les informations manquantes : ${JSON.stringify(r.body)}`);
});

const S = {};
let rc = 0;
const business = () => {
  rc += 1;
  return { account_type: 'business', business_name: `Entreprise ${rc}`, business: { rccm: `CD/KNG/RCCM/25-B-0${rc}000`, address: '5, avenue du Commerce, Gombe', city: 'Kinshasa', phone: '0815556677', email: `contact${rc}@entreprise.cd`, fax: '0815556678', website: `www.entreprise${rc}.cd` } };
};

test('inscription entreprise : le document RCCM reste à envoyer', async () => {
  const r = await signup(business());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.user.missing, ['rccm_document'], 'une entreprise doit encore envoyer son document RCCM');
  S.biz = r.body;
});

test('inscription entreprise : envoi du document RCCM (PDF), chiffré, puis plus rien à compléter', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const r = await fetch(`${base}/v1/me/business-document`, { method: 'POST', headers: { Authorization: `Bearer ${S.biz.token}`, 'Content-Type': 'application/pdf' }, body: pdf });
  const body = await r.json();
  assert.equal(r.status, 201, `POST /v1/me/business-document (src/routes/settings.js) : ${JSON.stringify(body)}`);
  assert.deepEqual((await api('GET', '/v1/me', { token: S.biz.token })).body.user.missing, [], 'le document RCCM est reçu');
});

test('inscription entreprise : le site web est obligatoire', async () => {
  const b = business();
  b.business.website = '';
  assert.equal((await signup(b)).body.error?.code, 'website_required', 'parseBusinessProfile (src/services/merchants.js) doit exiger le site web');
});

test('inscription entreprise : le fax est obligatoire', async () => {
  const b = business();
  b.business.fax = '';
  assert.equal((await signup(b)).body.error?.code, 'fax_required', 'parseBusinessProfile (src/services/merchants.js) doit exiger le fax');
});

test('ancien compte sans questions ni contact d’urgence : aucune opération avant de compléter', async () => {
  const r = await signup();
  await q.run('UPDATE users SET security_questions=NULL, emergency_contact=NULL, activated_at=? WHERE id=?', new Date().toISOString(), r.body.user.id);
  S.legacy = r.body;
  const t = await api('POST', '/v1/transfers', { token: r.body.token, body: { to: 'client1@test.cd', amount: 100, currency: 'USD', pin: '4826' } });
  assert.equal(t.body.error?.code, 'profile_incomplete', `les routes d’argent (src/routes/wallet.js) doivent exiger un profil complet : ${JSON.stringify(t.body)}`);
});

test('ancien compte : il complète ses questions et son contact d’urgence, puis plus rien ne manque', async () => {
  const r = await api('PUT', '/v1/me/security', { token: S.legacy.token, body: {
    password: 'motdepasse5',
    security_questions: [Q('favorite_dish', 'Pondu'), Q('first_job', 'Vendeur'), Q('childhood_street', 'Avenue Lumumba')],
    emergency_contact: { full_name: 'Joseph Mutombo', address: '3, avenue de la Paix, Lubumbashi', phone: '0823334455', email: 'joseph.mutombo@test.cd', relation: 'Frère' },
  } });
  assert.equal(r.status, 200, `PUT /v1/me/security (src/routes/settings.js) : ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body.user.missing, [], 'le compte est complet');
});

test('mot de passe oublié : après le code reçu par email, le client voit ses 3 questions de sécurité', async () => {
  const email = S.legacy.user.email;
  const f = await api('POST', '/v1/auth/password/forgot', { body: { email } });
  S.resetCode = f.body.sandbox_code;
  const v = await api('POST', '/v1/auth/password/verify', { body: { email, otp_code: S.resetCode } });
  assert.equal(v.status, 200, `POST /v1/auth/password/verify (src/routes/auth.js) : ${JSON.stringify(v.body)}`);
  assert.deepEqual(v.body.questions.map((x) => x.question), ['favorite_dish', 'first_job', 'childhood_street'], 'ses questions, sans les réponses');
});

test('mot de passe oublié : de mauvaises réponses de sécurité empêchent la réinitialisation', async () => {
  const r = await api('POST', '/v1/auth/password/reset', { body: {
    email: S.legacy.user.email, otp_code: S.resetCode, new_password: 'nouveaumotdepasse9',
    answers: [{ question: 'favorite_dish', answer: 'Fufu' }, { question: 'first_job', answer: 'Vendeur' }, { question: 'childhood_street', answer: 'Avenue Lumumba' }],
  } });
  assert.equal(r.body.error?.code, 'security_answers_invalid', `POST /v1/auth/password/reset (src/routes/auth.js) doit vérifier les réponses : ${JSON.stringify(r.body)}`);
});

test('mot de passe oublié : code email + bonnes réponses (sans tenir compte des majuscules ni des accents)', async () => {
  const r = await api('POST', '/v1/auth/password/reset', { body: {
    email: S.legacy.user.email, otp_code: S.resetCode, new_password: 'nouveaumotdepasse9',
    answers: [{ question: 'favorite_dish', answer: 'PONDU' }, { question: 'first_job', answer: ' vendeur ' }, { question: 'childhood_street', answer: 'avenue lumumba' }],
  } });
  assert.equal(r.status, 200, `réinitialisation acceptée : ${JSON.stringify(r.body)}`);
});
