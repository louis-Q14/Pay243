// Protection des achats Pay243 : litiges entre un acheteur (titulaire d'un compte Pay243) et un marchand.
// À l'ouverture, le montant contesté est retenu sur le compte du marchand (compte système dispute_hold).
import { isUniqueViolation, q, tx } from '../db.js';
import { accountWallet } from '../accounts.js';
import { verifyPin } from '../auth.js';
import { createTxn, getWallet, lockWallet, move, systemWallet } from '../ledger.js';
import { HttpError, assertAmount, newId, now } from '../util.js';

export const REASONS = { not_received: 'Objet non reçu', not_as_described: 'Ne correspond pas à la description' };
const OPEN_DAYS = 180; // délai pour signaler un litige, à compter du paiement
const ESCALATE_DAYS = 20; // délai pour remonter un litige à Pay243, à compter de son ouverture
const NOT_RECEIVED_WAIT_DAYS = 7; // objet non reçu : remontée possible 7 jours après le paiement
const DAY = 86400e3;

export const getDispute = (id) => q.get('SELECT * FROM disputes WHERE id=?', id);

export function serializeDispute(d) {
  return {
    id: d.id, object: 'dispute', payment_id: d.payment_id, merchant_id: d.merchant_id,
    reason: d.reason, reason_label: REASONS[d.reason], status: d.status,
    amount: Number(d.amount), held_amount: Number(d.held_amount), refunded_amount: Number(d.refunded_amount), currency: d.currency,
    created_at: d.created_at, updated_at: d.updated_at,
  };
}

function cleanMessage(body) {
  const text = String(body ?? '').trim();
  if (text.length < 5) throw new HttpError(400, 'invalid_message', 'Décrivez le problème en quelques mots (5 caractères au moins).');
  if (text.length > 2000) throw new HttpError(400, 'invalid_message', 'Message trop long (2 000 caractères au plus).');
  return text;
}

const ACTIVE = ['open', 'claim'];

/** Rôle de l'utilisateur dans le litige : acheteur, vendeur (titulaire de l'espace marchand) ou aucun. */
async function roleOf(d, user) {
  if (d.user_id === user.id) return 'buyer';
  const m = await q.get('SELECT owner_user_id FROM merchants WHERE id=?', d.merchant_id);
  return m?.owner_user_id === user.id ? 'seller' : null;
}

async function disputeView(d, role) {
  const p = await q.get('SELECT description, amount, paid_at, method FROM payments WHERE id=?', d.payment_id);
  const m = await q.get('SELECT name FROM merchants WHERE id=?', d.merchant_id);
  const buyer = await q.get('SELECT full_name FROM users WHERE id=?', d.user_id);
  return { ...serializeDispute(d), role, merchant_name: m?.name || null, buyer_name: buyer?.full_name || null,
    payment: p ? { description: p.description, amount: Number(p.amount), paid_at: p.paid_at, method: p.method } : null };
}

/** Litiges de l'utilisateur : ceux qu'il a ouverts comme acheteur et ceux qui visent ses ventes. */
export async function listDisputes(user) {
  const rows = await q.all(`SELECT d.* FROM disputes d LEFT JOIN merchants m ON m.id = d.merchant_id
                             WHERE d.user_id = ? OR m.owner_user_id = ? ORDER BY d.updated_at DESC LIMIT 200`, user.id, user.id);
  return Promise.all(rows.map((d) => disputeView(d, d.user_id === user.id ? 'buyer' : 'seller')));
}

/** Un litige et sa conversation, pour l'acheteur ou le vendeur seulement. */
export async function disputeFor(user, id) {
  const d = await getDispute(id);
  const role = d && await roleOf(d, user);
  if (!role) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  const messages = await q.all('SELECT author, author_name, body, created_at FROM dispute_messages WHERE dispute_id=? ORDER BY created_at, id', d.id);
  return { ...(await disputeView(d, role)), messages };
}

/** Message de l'acheteur ou du vendeur, tant que le litige n'est pas tranché. */
export async function postMessage(user, id, text) {
  const d = await getDispute(id);
  const role = d && await roleOf(d, user);
  if (!role) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  if (!ACTIVE.includes(d.status)) throw new HttpError(409, 'dispute_closed', 'Ce litige est clos.');
  const body = cleanMessage(text);
  const ts = now();
  await q.run('INSERT INTO dispute_messages (id, dispute_id, author, author_name, body, created_at) VALUES (?,?,?,?,?,?)',
    newId('dmsg'), d.id, role, user.full_name, body, ts);
  await q.run('UPDATE disputes SET updated_at=? WHERE id=?', ts, d.id);
  return disputeFor(user, d.id);
}

const systemNote = (id, body, ts = now()) => q.run('INSERT INTO dispute_messages (id, dispute_id, author, body, created_at) VALUES (?,?,?,?,?)', newId('dmsg'), id, 'system', body, ts);

/** L'acheteur remonte le litige à Pay243 quand il n'a pas trouvé d'accord avec le vendeur. */
export async function escalateDispute(user, id) {
  const d = await getDispute(id);
  if (!d || d.user_id !== user.id) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  if (d.status !== 'open') throw new HttpError(409, 'not_escalable', 'Ce litige ne peut plus être remonté à Pay243.');
  const p = await q.get('SELECT paid_at FROM payments WHERE id=?', d.payment_id);
  if (d.reason === 'not_received' && Date.now() - Date.parse(p.paid_at) < NOT_RECEIVED_WAIT_DAYS * DAY) {
    throw new HttpError(409, 'escalation_too_early', `Pour un objet non reçu, laissez au vendeur ${NOT_RECEIVED_WAIT_DAYS} jours après le paiement avant de demander l'intervention de Pay243.`);
  }
  if (Date.now() - Date.parse(d.created_at) > ESCALATE_DAYS * DAY) throw new HttpError(409, 'escalation_too_late', `Un litige se remonte à Pay243 dans les ${ESCALATE_DAYS} jours qui suivent son ouverture.`);
  const ts = now();
  await q.run("UPDATE disputes SET status='claim', escalated_at=?, updated_at=? WHERE id=? AND status='open'", ts, ts, d.id);
  await systemNote(d.id, 'Litige remonté à Pay243 : notre équipe examine le dossier et pourra demander des justificatifs.', ts);
  return disputeFor(user, d.id);
}

/** Rend au vendeur ce qui reste de la retenue. */
async function releaseHold(d, amount) {
  if (amount <= 0) return;
  const hold = await systemWallet('dispute_hold', d.currency);
  const mw = await getWallet('merchant', d.merchant_id, d.currency);
  const t = await createTxn({ type: 'dispute_release', status: 'succeeded', amount, currency: d.currency, from_wallet: hold.id, to_wallet: mw.id,
    merchant_id: d.merchant_id, payment_id: d.payment_id, description: 'Fin de retenue : litige clos', metadata: { dispute_id: d.id } });
  await move(t.id, hold.id, mw.id, amount);
}

/**
 * Remboursement de l'acheteur sur son wallet Pay243 : d'abord la retenue, puis le solde du vendeur,
 * enfin le fonds de protection des achats si le vendeur n'a plus assez.
 */
async function refundBuyer(d, p) {
  const amount = Math.min(Number(d.amount), Number(p.amount) - Number(p.refunded_amount));
  if (amount <= 0) return 0;
  const buyer = await q.get('SELECT id, account_type FROM users WHERE id=?', d.user_id);
  const to = await accountWallet(buyer, d.currency);
  const hold = await systemWallet('dispute_hold', d.currency);
  const m = await q.get('SELECT name FROM merchants WHERE id=?', d.merchant_id);
  const t = await createTxn({ type: 'refund', status: 'succeeded', amount, currency: d.currency, method: 'wallet', from_wallet: hold.id, to_wallet: to.id,
    merchant_id: d.merchant_id, payment_id: p.id, description: `Remboursement Protection des achats — ${m?.name || 'marchand'}`,
    metadata: { dispute_id: d.id, counterparty: m?.name || null } });
  const fromHold = Math.min(amount, Number(d.held_amount));
  await move(t.id, hold.id, to.id, fromHold);
  let rest = amount - fromHold;
  if (rest > 0) {
    const mw = await lockWallet((await getWallet('merchant', d.merchant_id, d.currency)).id);
    const fromSeller = Math.min(rest, Math.max(0, Number(mw.balance)));
    await move(t.id, mw.id, to.id, fromSeller);
    rest -= fromSeller;
  }
  if (rest > 0) await move(t.id, (await systemWallet('protection_fund', d.currency)).id, to.id, rest);
  await releaseHold(d, Number(d.held_amount) - fromHold);
  await q.run(`UPDATE payments SET refunded_amount = refunded_amount + ?,
                 status = CASE WHEN refunded_amount + ? >= amount THEN 'refunded' ELSE 'partially_refunded' END, updated_at = ?
               WHERE id = ?`, amount, amount, now(), p.id);
  return amount;
}

export const DECISION_LABELS = { buyer: 'en faveur de l\'acheteur', seller: 'en faveur du vendeur' };

/** Décision de l'équipe Pay243 sur une réclamation : rembourser l'acheteur ou rendre la retenue au vendeur. */
export async function decideDispute(id, winner, note, actor) {
  if (!DECISION_LABELS[winner]) throw new HttpError(400, 'invalid_winner', 'winner : buyer ou seller.');
  const text = String(note || '').trim();
  if (text.length < 5) throw new HttpError(400, 'note_required', 'Expliquez la décision (elle est envoyée aux deux parties).');
  await tx(async () => {
    const d = await q.get('SELECT * FROM disputes WHERE id=? FOR UPDATE', id);
    if (!d) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
    if (!ACTIVE.includes(d.status)) throw new HttpError(409, 'dispute_closed', 'Ce litige est déjà tranché.');
    const p = await q.get('SELECT * FROM payments WHERE id=? FOR UPDATE', d.payment_id);
    let refunded = 0;
    if (winner === 'buyer') refunded = await refundBuyer(d, p);
    else await releaseHold(d, Number(d.held_amount));
    const ts = now();
    await q.run('UPDATE disputes SET status=?, refunded_amount=?, outcome_note=?, decided_by=?, resolved_at=?, updated_at=? WHERE id=?',
      winner === 'buyer' ? 'won_buyer' : 'won_seller', refunded, text.slice(0, 1000), actor, ts, ts, d.id);
    await systemNote(d.id, `Décision de Pay243 ${DECISION_LABELS[winner]} : ${text.slice(0, 1000)}`, ts);
  });
  return getDispute(id);
}

/** Le vendeur rembourse l'acheteur depuis la conversation (PIN exigé) : le litige est clos. */
export async function sellerRefund(user, id, pin) {
  const d0 = await getDispute(id);
  if (!d0 || (await roleOf(d0, user)) !== 'seller') throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  await verifyPin(user, pin);
  await tx(async () => {
    const d = await q.get('SELECT * FROM disputes WHERE id=? FOR UPDATE', id);
    if (!ACTIVE.includes(d.status)) throw new HttpError(409, 'dispute_closed', 'Ce litige est clos.');
    const p = await q.get('SELECT * FROM payments WHERE id=? FOR UPDATE', d.payment_id);
    const refunded = await refundBuyer(d, p);
    const ts = now();
    await q.run("UPDATE disputes SET status='closed', refunded_amount=?, outcome_note=?, resolved_at=?, updated_at=? WHERE id=?",
      refunded, 'Remboursé par le vendeur', ts, ts, d.id);
    await systemNote(d.id, 'Le vendeur a remboursé l\'acheteur : le litige est clos.', ts);
  });
  return disputeFor(user, id);
}

/** Clôt un litige sans remboursement : la retenue revient au vendeur. */
async function closeWithoutRefund(id, note) {
  return tx(async () => {
    const d = await q.get('SELECT * FROM disputes WHERE id=? FOR UPDATE', id);
    if (!ACTIVE.includes(d.status)) throw new HttpError(409, 'dispute_closed', 'Ce litige est clos.');
    await releaseHold(d, Number(d.held_amount));
    const ts = now();
    await q.run("UPDATE disputes SET status='closed', outcome_note=?, resolved_at=?, updated_at=? WHERE id=?", note, ts, ts, d.id);
    await systemNote(d.id, note, ts);
  });
}

/** L'acheteur retire son litige (problème réglé avec le vendeur, colis arrivé…). */
export async function closeDispute(user, id) {
  const d = await getDispute(id);
  if (!d || d.user_id !== user.id) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  await closeWithoutRefund(d.id, 'L\'acheteur a retiré son litige.');
  return disputeFor(user, d.id);
}

/** Clôture automatique des litiges non remontés à Pay243 dans les 20 jours (tâche périodique). */
export async function expireDisputes() {
  const limit = new Date(Date.now() - ESCALATE_DAYS * DAY).toISOString();
  const rows = await q.all("SELECT id FROM disputes WHERE status='open' AND created_at < ? LIMIT 100", limit);
  for (const r of rows) {
    await closeWithoutRefund(r.id, `Litige clos automatiquement : il n'a pas été remonté à Pay243 dans les ${ESCALATE_DAYS} jours.`)
      .catch((e) => console.error('[litiges]', r.id, e.message));
  }
  return rows.length;
}

/** File du back-office : litiges par statut, avec les noms des parties. */
export async function listForStaff(status) {
  const st = ['open', 'claim', 'won_buyer', 'won_seller', 'closed'].includes(status) ? status : 'claim';
  const rows = await q.all('SELECT * FROM disputes WHERE status=? ORDER BY COALESCE(escalated_at, created_at) ASC LIMIT 200', st);
  return Promise.all(rows.map((d) => disputeView(d, 'staff')));
}

/** Un litige complet pour l'équipe : conversation comprise. */
export async function disputeForStaff(id) {
  const d = await getDispute(id);
  if (!d) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  const messages = await q.all('SELECT author, author_name, body, created_at FROM dispute_messages WHERE dispute_id=? ORDER BY created_at, id', d.id);
  return { ...(await disputeView(d, 'staff')), outcome_note: d.outcome_note, decided_by: d.decided_by, escalated_at: d.escalated_at, resolved_at: d.resolved_at, messages };
}

/** Message de l'équipe dans la conversation (demande de justificatif, etc.). */
export async function staffMessage(id, text, staffName) {
  const d = await getDispute(id);
  if (!d) throw new HttpError(404, 'dispute_not_found', 'Litige introuvable.');
  if (!ACTIVE.includes(d.status)) throw new HttpError(409, 'dispute_closed', 'Ce litige est clos.');
  const ts = now();
  await q.run('INSERT INTO dispute_messages (id, dispute_id, author, author_name, body, created_at) VALUES (?,?,?,?,?,?)', newId('dmsg'), d.id, 'staff', staffName || 'Équipe Pay243', cleanMessage(text), ts);
  await q.run('UPDATE disputes SET updated_at=? WHERE id=?', ts, d.id);
  return disputeForStaff(d.id);
}

/** L'acheteur signale un problème sur un achat payé depuis son compte Pay243. */
export async function openDispute(user, body = {}) {
  const p = await q.get('SELECT * FROM payments WHERE id=?', String(body.payment_id || ''));
  if (!p || p.customer_user_id !== user.id) throw new HttpError(404, 'payment_not_found', 'Achat introuvable.');
  if (!['succeeded', 'partially_refunded'].includes(p.status)) throw new HttpError(409, 'not_disputable', 'Seul un achat payé et non entièrement remboursé peut faire l\'objet d\'un litige.');
  if (Date.now() - Date.parse(p.paid_at) > OPEN_DAYS * 86400e3) throw new HttpError(409, 'dispute_too_late', `Un litige se signale dans les ${OPEN_DAYS} jours qui suivent le paiement.`);
  if (!REASONS[body.reason]) throw new HttpError(400, 'invalid_reason', 'Motif : not_received (objet non reçu) ou not_as_described (ne correspond pas à la description).');
  const message = cleanMessage(body.message);
  const remaining = Number(p.amount) - Number(p.refunded_amount);
  const amount = body.amount == null ? remaining : assertAmount(body.amount);
  if (amount > remaining) throw new HttpError(400, 'amount_too_large', `Montant contestable restant : ${remaining}.`);

  const id = newId('dsp');
  const ts = now();
  try {
    await tx(async () => {
      await q.run(`INSERT INTO disputes (id, payment_id, merchant_id, user_id, reason, status, amount, currency, created_at, updated_at)
                   VALUES (?,?,?,?,?,'open',?,?,?,?)`, id, p.id, p.merchant_id, user.id, body.reason, amount, p.currency, ts, ts);
      await q.run('INSERT INTO dispute_messages (id, dispute_id, author, body, created_at) VALUES (?,?,?,?,?)', newId('dmsg'), id, 'buyer', message, ts);
      // Retenue : ce qui est disponible sur le compte du marchand, au plus le montant contesté.
      const mw = await lockWallet((await getWallet('merchant', p.merchant_id, p.currency)).id);
      const held = Math.min(amount, Math.max(0, Number(mw.balance)));
      if (held > 0) {
        const hold = await systemWallet('dispute_hold', p.currency);
        const t = await createTxn({ type: 'dispute_hold', status: 'succeeded', amount: held, currency: p.currency, from_wallet: mw.id, to_wallet: hold.id,
          merchant_id: p.merchant_id, payment_id: p.id, description: `Retenue : litige sur ${p.description || p.id}`, metadata: { dispute_id: id } });
        await move(t.id, mw.id, hold.id, held);
        await q.run('UPDATE disputes SET held_amount=? WHERE id=?', held, id);
      }
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, 'dispute_exists', 'Un litige est déjà ouvert sur cet achat.');
    throw e;
  }
  return getDispute(id);
}
