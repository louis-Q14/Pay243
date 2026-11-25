// Tests unitaires des plafonds (src/limits.js) pour le compte unique d'une entreprise, sur une base PGlite en mémoire.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const { openDb, closeDb, q } = await import('../src/db.js');
const { createTxn, getWallet } = await import('../src/ledger.js');
const { checkOutgoing } = await import('../src/limits.js');

before(async () => { await openDb({}); });
after(async () => { await closeDb(); });

const addMerchant = (id, ownerUserId) => q.run(
  'INSERT INTO merchants (id, owner_user_id, name, webhook_secret, created_at) VALUES (?,?,?,?,?)',
  id, ownerUserId, 'Entreprise test', 'whsec_test', new Date().toISOString(),
);

test('plafond journalier d\'une entreprise : ses envois depuis le compte marchand comptent', async () => {
  const user = { id: 'usr_lim_biz', account_type: 'business', kyc_level: 1 };
  await addMerchant('mer_lim_biz', user.id);
  const w = await getWallet('merchant', 'mer_lim_biz', 'USD');
  await createTxn({ type: 'payout', status: 'succeeded', amount: 30000, currency: 'USD', method: 'wallet', from_wallet: w.id, merchant_id: 'mer_lim_biz', metadata: { initiated_by: user.id } });
  await assert.rejects(checkOutgoing(user, 'USD', 100), { code: 'limit_daily' },
    'checkOutgoing (src/limits.js) doit compter les sorties du wallet marchand marquées initiated_by = titulaire');
});
