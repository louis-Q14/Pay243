// Compte d'un utilisateur : le wallet sur lequel passent ses opérations.
// Une entreprise n'a qu'un compte : celui de son espace marchand.
import { q, tx } from './db.js';
import { createTxn, getWallet, move } from './ledger.js';

/** Le wallet du compte dans une devise. */
export async function accountWallet(user, currency) {
  const m = user.account_type === 'business' ? await q.get('SELECT id FROM merchants WHERE owner_user_id=?', user.id) : null;
  return m ? getWallet('merchant', m.id, currency) : getWallet('user', user.id, currency);
}

/** Les wallets dont l'historique est celui du compte : pour une entreprise, ceux de son espace marchand et ses anciens wallets personnels. */
export async function accountWalletIds(user) {
  const rows = user.account_type === 'business'
    ? await q.all("SELECT id FROM wallets WHERE (owner_type='user' AND owner_id=?) OR (owner_type='merchant' AND owner_id IN (SELECT id FROM merchants WHERE owner_user_id=?))", user.id, user.id)
    : await q.all("SELECT id FROM wallets WHERE owner_type='user' AND owner_id=?", user.id);
  return rows.map((w) => w.id);
}

/**
 * Regroupement des comptes (au démarrage) : le solde resté sur le wallet personnel d'une entreprise
 * passe sur son compte marchand, par une écriture tracée du grand livre. Sans effet une fois les soldes à zéro.
 */
export async function consolidateBusinessWallets() {
  const rows = await q.all(`SELECT w.id AS wallet_id, w.currency, m.id AS merchant_id FROM wallets w
                              JOIN users u ON u.id = w.owner_id AND u.account_type = 'business'
                              JOIN merchants m ON m.owner_user_id = u.id
                             WHERE w.owner_type = 'user' AND w.balance > 0`);
  for (const r of rows) {
    await tx(async () => {
      const from = await q.get('SELECT balance FROM wallets WHERE id=? FOR UPDATE', r.wallet_id);
      const amount = Number(from.balance);
      if (amount <= 0) return;
      const to = await getWallet('merchant', r.merchant_id, r.currency);
      const t = await createTxn({
        type: 'payout', status: 'succeeded', amount, currency: r.currency, method: 'wallet', from_wallet: r.wallet_id, to_wallet: to.id,
        description: 'Regroupement des comptes : le compte de l’entreprise est son compte marchand',
      });
      await move(t.id, r.wallet_id, to.id, amount);
    });
  }
}
