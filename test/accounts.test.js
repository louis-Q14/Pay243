// Tests unitaires du compte d'un utilisateur (src/accounts.js), sur une base PGlite en mémoire.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const { openDb, closeDb, q } = await import('../src/db.js');
const { createTxn, getWallet, move, systemWallet } = await import('../src/ledger.js');
const { accountWallet, accountWalletIds, consolidateBusinessWallets } = await import('../src/accounts.js');

before(async () => { await openDb({}); });
after(async () => { await closeDb(); });

const addMerchant = (id, ownerUserId) => q.run(
  'INSERT INTO merchants (id, owner_user_id, name, webhook_secret, created_at) VALUES (?,?,?,?,?)',
  id, ownerUserId, 'Entreprise test', 'whsec_test', new Date().toISOString(),
);

test('compte entreprise : son wallet est celui de son compte marchand', async () => {
  await addMerchant('mer_unit_1', 'usr_unit_biz');
  const w = await accountWallet({ id: 'usr_unit_biz', account_type: 'business' }, 'USD');
  assert.equal(w.id, (await getWallet('merchant', 'mer_unit_1', 'USD')).id);
});

test('compte particulier avec un ancien espace marchand : son wallet reste son wallet personnel', async () => {
  await addMerchant('mer_unit_perso', 'usr_unit_perso_m');
  const w = await accountWallet({ id: 'usr_unit_perso_m', account_type: 'personal' }, 'USD');
  assert.equal(w.id, (await getWallet('user', 'usr_unit_perso_m', 'USD')).id);
});

test('compte particulier : son wallet reste son wallet personnel', async () => {
  const w = await accountWallet({ id: 'usr_unit_perso', account_type: 'personal' }, 'CDF');
  assert.equal(w.id, (await getWallet('user', 'usr_unit_perso', 'CDF')).id);
});

test('historique d\'une entreprise : wallets marchands et anciens wallets personnels', async () => {
  await addMerchant('mer_unit_hist', 'usr_unit_hist');
  const merchant = await getWallet('merchant', 'mer_unit_hist', 'USD');
  const old = await getWallet('user', 'usr_unit_hist', 'USD');
  const ids = await accountWalletIds({ id: 'usr_unit_hist', account_type: 'business' });
  assert.ok(ids.includes(merchant.id) && ids.includes(old.id));
});

test('regroupement : le solde personnel d\'une entreprise passe sur son compte marchand, une seule fois', async () => {
  await q.run("INSERT INTO users (id, email, account_type, full_name, password_hash, pin_hash, created_at) VALUES ('usr_unit_regr','regroupement@test.cd','business','Entreprise Regroupée','x','x',?)", new Date().toISOString());
  await addMerchant('mer_unit_regr', 'usr_unit_regr');
  const old = await getWallet('user', 'usr_unit_regr', 'CDF');
  const fund = await createTxn({ type: 'topup', status: 'succeeded', amount: 82875000, currency: 'CDF', method: 'card', from_wallet: (await systemWallet('float_card', 'CDF')).id, to_wallet: old.id });
  await move(fund.id, (await systemWallet('float_card', 'CDF')).id, old.id, 82875000);

  await consolidateBusinessWallets();
  await consolidateBusinessWallets();

  assert.equal(Number((await getWallet('user', 'usr_unit_regr', 'CDF')).balance), 0);
  assert.equal(Number((await getWallet('merchant', 'mer_unit_regr', 'CDF')).balance), 82875000);
  const moves = await q.all("SELECT description FROM transactions WHERE from_wallet=? AND description LIKE 'Regroupement%'", old.id);
  assert.equal(moves.length, 1);
});

test('historique d\'un particulier : ses seuls wallets personnels', async () => {
  await addMerchant('mer_unit_hist_p', 'usr_unit_hist_p');
  const merchant = await getWallet('merchant', 'mer_unit_hist_p', 'USD');
  const own = await getWallet('user', 'usr_unit_hist_p', 'USD');
  const ids = await accountWalletIds({ id: 'usr_unit_hist_p', account_type: 'personal' });
  assert.ok(ids.includes(own.id) && !ids.includes(merchant.id));
});