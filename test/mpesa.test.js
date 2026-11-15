// Pilote M-Pesa Open API face à un faux serveur qui reproduit le bac à sable (portail, nov. 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const { default: mpesaDriver, mpesaReference, mpesaConversationId, txnIdFromMpesaReference, mpesaText } = await import('../src/providers/mobileMoney/mpesa.js');
const { newId } = await import('../src/util.js');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
/** Déchiffre le jeton Bearer comme le ferait M-Pesa (null si Node refuse le PKCS#1 v1.5 en déchiffrement). */
function decryptBearer(h) {
  const b64 = String(h || '').replace(/^Bearer /, '');
  try { return crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(b64, 'base64')).toString(); } catch { return null; }
}

function fakeMpesa() {
  const s = { sessions: 0, calls: [], reversed: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const env = url.pathname.split('/')[1]; // sandbox | openapi
      const path = url.pathname.replace(/^\/(sandbox|openapi)\/ipg\/v2\/vodacomDRC/, '');
      const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
      const bearer = decryptBearer(req.headers.authorization);
      s.calls.push({ env, method: req.method, path, body, origin: req.headers.origin, bearer, auth: req.headers.authorization });
      const send = (status, j) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (path === '/getSession/') { s.sessions += 1; return send(200, { output_ResponseCode: 'INS-0', output_ResponseDesc: 'Request processed successfully', output_SessionID: `sess${s.sessions}` }); }
      const ok = (extra = {}) => send(201, { output_ResponseCode: 'INS-0', output_ResponseDesc: 'Request processed successfully', output_TransactionID: 'MP0000000001', output_ConversationID: 'c1', output_ThirdPartyConversationID: body.input_ThirdPartyConversationID, ...extra });
      if (path === '/c2bPayment/singleStage/' || path === '/b2cPayment/') {
        const tail = String(body.input_CustomerMSISDN).slice(-4);
        if (tail === '0004') return send(401, { output_ResponseCode: 'INS-6', output_ResponseDesc: 'Transaction Failed' });
        if (tail === '0008') return send(422, { output_ResponseCode: 'INS-2006', output_ResponseDesc: 'Insufficient balance' });
        if (tail === '0010') return send(409, { output_ResponseCode: 'INS-10', output_ResponseDesc: 'Duplicate Transaction' });
        if (tail === '0500') return send(500, { output_ResponseCode: 'INS-1', output_ResponseDesc: 'Internal Error' });
        // Limite de la session atteinte : seule une nouvelle clé de session la remet à zéro.
        if (tail === '0994' && s.sessions < 2) return send(400, { output_ResponseCode: 'INS-994', output_ResponseDesc: 'Org Tx Value Limit Breached' });
        return ok();
      }
      if (path === '/queryTransactionStatus/') {
        if (!/^[A-Za-z0-9]{21,32}$|^[A-Za-z0-9]{10,20}$/.test(body.input_QueryReference)) return send(400, { output_ResponseCode: 'INS-21', output_ResponseDesc: 'Parameter validations failed' });
        return send(200, { output_ResponseCode: 'INS-0', output_ResponseTransactionStatus: 'Completed', output_OriginalTransactionID: 'MP0000000777', output_Reversed: s.reversed ? 'True' : 'False' });
      }
      send(404, { output_ResponseDesc: 'Not Found' });
    });
  }).listen(0);
  return { s, server, url: `http://127.0.0.1:${server.address().port}` };
}

const conf = (url, extra = {}) => ({
  baseUrl: url, env: 'sandbox', market: 'vodacomDRC', country: 'DRC', apiKey: 'MA-CLE-API', publicKey: PUBLIC_B64,
  serviceProviderCode: '000000', sessionMinutes: 50, sessionWarmupMs: 20, origin: '*', currencies: ['USD', 'CDF'], sandboxMsisdn: null, ...extra,
});
const nextResult = (events, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('aucun résultat')), ms);
  events.once('result', (r) => { clearTimeout(t); resolve(r); });
});
const noResult = (events, ms = 300) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  events.once('result', (r) => { clearTimeout(t); reject(new Error(`résultat inattendu : ${JSON.stringify(r)}`)); });
});

test('références M-Pesa : alphanumériques, longueurs admises, réversibles', () => {
  let withDash = 0;
  for (let i = 0; i < 300; i++) {
    const id = newId('txn');
    if (/-/.test(id)) withDash += 1;
    const ref = mpesaReference(id); const conv = mpesaConversationId(id);
    assert.match(ref, /^[0-9A-Za-z]{17}$/); // input_TransactionReference : 1 à 20
    assert.match(conv, /^[0-9A-Za-z]{21}$/); // ThirdPartyConversationID ≤ 40 ; recherche de statut : 21 à 32
    assert.equal(txnIdFromMpesaReference(ref), id);
    assert.equal(txnIdFromMpesaReference(conv), id);
  }
  assert.ok(withDash > 0, 'les identifiants base64url contiennent des tirets, refusés par M-Pesa');
  assert.equal(txnIdFromMpesaReference('pas-une-ref'), null);
  assert.match(mpesaReference('ancien-format'), /^[0-9A-Za-z]{17}$/);
  assert.equal(mpesaText('Commande SOMBATEKA P243-17944 — la joie, été !', 'x'), 'Commande SOMBATEKA P243 17944 la joie ete');
  assert.equal(mpesaText('—', 'Recharge Pay243'), 'Recharge Pay243');
});

test('M-Pesa : session chiffrée et réutilisée, paiement client, retrait sur /b2cPayment/, codes de réponse', async () => {
  const f = fakeMpesa();
  try {
    const events = new EventEmitter();
    const d = mpesaDriver('mpesa', events, conf(f.url));
    const id = newId('txn');

    // Recharge réussie
    let r = nextResult(events);
    await d.collect({ txnId: id, phone: '+243810000001', amount: 1050, currency: 'USD', description: 'Recharge — wallet été' });
    let res = await r;
    assert.equal(res.status, 'succeeded');
    assert.equal(res.providerRef, 'MP0000000001');
    const [sess, c2b] = f.s.calls;
    assert.equal(sess.path, '/getSession/');
    assert.equal(c2b.path, '/c2bPayment/singleStage/');
    if (sess.bearer !== null) { // déchiffrement possible : on vérifie les valeurs exactes
      assert.equal(sess.bearer, 'MA-CLE-API');
      assert.equal(c2b.bearer, 'sess1');
    } else assert.match(sess.auth, /^Bearer [A-Za-z0-9+/]{300,}={0,2}$/);
    assert.equal(c2b.origin, '*');
    assert.deepEqual({ ...c2b.body, input_ThirdPartyConversationID: undefined, input_TransactionReference: undefined }, {
      input_Amount: '10.50', input_Country: 'DRC', input_Currency: 'USD', input_CustomerMSISDN: '243810000001',
      input_ServiceProviderCode: '000000', input_PurchasedItemsDesc: 'Recharge wallet ete',
      input_ThirdPartyConversationID: undefined, input_TransactionReference: undefined,
    });
    assert.equal(txnIdFromMpesaReference(c2b.body.input_TransactionReference), id);

    // Retrait : bonne adresse (/b2cPayment/), même session
    r = nextResult(events);
    await d.disburse({ txnId: newId('txn'), phone: '+243810000001', amount: 2000, currency: 'CDF', description: 'Retrait Pay243' });
    assert.equal((await r).status, 'succeeded');
    assert.equal(f.s.calls.at(-1).path, '/b2cPayment/');
    assert.equal(f.s.calls.at(-1).body.input_PaymentItemsDesc, 'Retrait Pay243');
    assert.equal(f.s.sessions, 1);

    // PIN incorrect : échec avec un motif clair
    r = nextResult(events);
    await d.collect({ txnId: newId('txn'), phone: '+243810000004', amount: 100, currency: 'USD' });
    res = await r;
    assert.equal(res.status, 'failed');
    assert.match(res.reason, /PIN incorrect/);

    // Solde : motif différent selon le sens
    r = nextResult(events);
    await d.disburse({ txnId: newId('txn'), phone: '+243810000008', amount: 100, currency: 'USD' });
    assert.match((await r).reason, /Pay243 insuffisamment approvisionné/);

    // Doublon et erreur 5xx : issue inconnue, la transaction reste en attente (jamais d'échec ni de restitution d'office)
    let quiet = noResult(events);
    await d.disburse({ txnId: newId('txn'), phone: '+243810000010', amount: 100, currency: 'USD' });
    await quiet;
    quiet = noResult(events);
    await d.disburse({ txnId: newId('txn'), phone: '+243810000500', amount: 100, currency: 'USD' });
    await quiet;

    // Limite de session atteinte : nouvelle clé de session puis nouvel essai, qui réussit
    r = nextResult(events);
    await d.collect({ txnId: newId('txn'), phone: '+243810000994', amount: 100, currency: 'USD' });
    assert.equal((await r).status, 'succeeded');
    assert.equal(f.s.sessions, 2);

    // Devise non acceptée : refus immédiat, rien n'est envoyé
    const callsBefore = f.s.calls.length;
    const usdOnly = mpesaDriver('mpesa', events, conf(f.url, { currencies: ['USD'] }));
    await assert.rejects(usdOnly.collect({ txnId: newId('txn'), phone: '+243810000001', amount: 100, currency: 'CDF' }), (e) => !e.uncertain && /n'accepte pas le CDF/.test(e.message));
    assert.equal(f.s.calls.length, callsBefore);
  } finally { f.server.close(); }
});

test('M-Pesa : statut d\'une transaction perdue (référence acceptée), annulation détectée, numéro de test du bac à sable', async () => {
  const f = fakeMpesa();
  try {
    const events = new EventEmitter();
    const d = mpesaDriver('mpesa', events, conf(f.url, { sandboxMsisdn: '000000000001' }));
    const txn = { id: newId('txn'), provider_ref: null };
    assert.deepEqual(await d.checkStatus(txn), { status: 'succeeded', providerRef: 'MP0000000777' });
    const q = f.s.calls.find((c) => c.path === '/queryTransactionStatus/');
    assert.equal(q.method, 'GET');
    assert.equal(q.body.input_QueryReference, mpesaConversationId(txn.id));
    assert.match(q.body.input_ThirdPartyConversationID, /^[0-9A-Za-z]{1,40}$/);

    f.s.reversed = true;
    assert.match((await d.checkStatus({ id: txn.id, provider_ref: 'MP0000000777' })).reason, /annulée/);
    assert.equal(f.s.calls.at(-1).body.input_QueryReference, 'MP0000000777');

    // Bac à sable : le numéro de test remplace celui du client
    const r = nextResult(events);
    await d.collect({ txnId: newId('txn'), phone: '+243810000004', amount: 100, currency: 'USD' });
    assert.equal((await r).status, 'succeeded');
    assert.equal(f.s.calls.at(-1).body.input_CustomerMSISDN, '000000000001');
    // …jamais en production
    const live = mpesaDriver('mpesa', events, conf(f.url, { env: 'live', sandboxMsisdn: '000000000001' }));
    const r2 = nextResult(events);
    await live.collect({ txnId: newId('txn'), phone: '+243810000001', amount: 100, currency: 'USD' });
    assert.equal((await r2).status, 'succeeded');
    assert.equal(f.s.calls.at(-1).env, 'openapi');
    assert.equal(f.s.calls.at(-1).body.input_CustomerMSISDN, '243810000001');
  } finally { f.server.close(); }
});
