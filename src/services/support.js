// =====================================================================
//  Support : demandes des utilisateurs et conversation avec l'équipe.
//  Une demande (« ticket ») contient un fil de messages. Statuts :
//    open     : en attente d'une réponse du support
//    answered : le support a répondu, en attente de l'utilisateur
//    closed   : résolue (un nouveau message de l'utilisateur la rouvre)
// =====================================================================
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { emailProvider, layoutHtml, layoutText } from '../providers/email/index.js';
import { HttpError, newId, now } from '../util.js';
import { readDecrypted, writeEncrypted } from './kyc.js';
import { appUrl, notifyUser } from './notify.js';

export const CATEGORIES = {
  account: 'Compte et connexion',
  verification: "Vérification d'identité",
  payment: 'Paiement ou transfert',
  topup: 'Recharge ou retrait',
  merchant: 'Espace marchand et API',
  other: 'Autre question',
};
export const STATUSES = ['open', 'answered', 'closed'];
const MAX_OPEN_TICKETS = 5;
const MAX_MESSAGES = 500; // par demande
const SUBJECT = { min: 3, max: 120 };
const BODY = { min: 1, max: 4000 };

/** Texte saisi : caractères de contrôle retirés (sauf saut de ligne), espaces de fin supprimés. */
function cleanText(v, { min, max }, field) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
  if (s.length < min) throw new HttpError(400, `invalid_${field}`, field === 'subject' ? `Objet requis (${min} caractères min.).` : 'Écrivez votre message.');
  if (s.length > max) throw new HttpError(400, `invalid_${field}`, `${field === 'subject' ? 'Objet' : 'Message'} trop long (${max} caractères max.).`);
  return s;
}

// =====================================================================
//  Pièces jointes : photo (JPEG, PNG, WebP) ou PDF, 5 Mo max., 3 par message.
//  Chiffrées au repos comme les pièces d'identité (AES-256-GCM), dans un sous-dossier « support ».
//  Envoi en deux temps : POST du fichier (renvoie un id), puis message avec `attachments: [id…]`.
// =====================================================================
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 3;
const MAX_UPLOADS_PER_DAY = 30;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const FILE_TYPES = Object.keys(EXT);
const filesDir = () => path.join(config.kycReview.storageDir, 'support');

/** Type réel d'après les premiers octets (le Content-Type annoncé n'est pas fiable). */
function sniffFile(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Nom affiché : sans chemin ni caractère de contrôle, extension imposée par le type réel. */
function cleanFileName(raw, mime) {
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch {}
  s = s.split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F"<>|:*?]/g, '').trim();
  const base = s.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim().slice(0, 80) || 'piece-jointe';
  return `${base}.${EXT[mime]}`;
}

/** owner : { type: 'user' | 'staff', id } */
export async function uploadSupportFile(owner, buf, rawName) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'empty_file', 'Envoyez une photo (JPEG, PNG, WebP) ou un PDF de 5 Mo maximum.');
  const mime = sniffFile(buf);
  if (!mime) throw new HttpError(415, 'unsupported_file', 'Formats acceptés : photo (JPEG, PNG, WebP) ou PDF.');
  const { n } = await q.get('SELECT COUNT(*)::int AS n FROM support_files WHERE owner_type=? AND owner_id=? AND created_at >= ?',
    owner.type, owner.id, new Date(Date.now() - 24 * 3600e3).toISOString());
  if (n >= MAX_UPLOADS_PER_DAY) throw new HttpError(429, 'too_many_uploads', "Trop de fichiers envoyés aujourd'hui. Réessayez demain.");
  const id = newId('supf');
  const storageKey = crypto.randomBytes(18).toString('base64url');
  const name = cleanFileName(rawName, mime);
  writeEncrypted(storageKey, buf, id, filesDir());
  await q.run('INSERT INTO support_files (id, owner_type, owner_id, name, mime, size, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, owner.type, owner.id, name, mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), storageKey, now());
  return { id, object: 'support_file', name, mime, size: buf.length };
}

function parseAttachments(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'invalid_attachments', "attachments : liste d'identifiants de fichiers.");
  const ids = [...new Set(v.map((x) => String(x)))];
  if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, 'too_many_attachments', `${MAX_ATTACHMENTS} pièces jointes maximum par message.`);
  return ids;
}

/** Rattache au message des fichiers envoyés par le même auteur et pas encore utilisés (dans la transaction). */
async function linkFiles(owner, ids, ticketId, messageId) {
  for (const fid of ids) {
    const f = await q.get('SELECT id FROM support_files WHERE id=? AND owner_type=? AND owner_id=? AND message_id IS NULL FOR UPDATE', fid, owner.type, owner.id);
    if (!f) throw new HttpError(400, 'invalid_attachment', 'Pièce jointe introuvable ou déjà envoyée : ajoutez-la de nouveau.');
    await q.run('UPDATE support_files SET ticket_id=?, message_id=? WHERE id=?', ticketId, messageId, fid);
  }
}

/** Message facultatif s'il y a au moins une pièce jointe. */
function bodyOrEmpty(v, ids) {
  if (ids.length && !String(v ?? '').trim()) return '';
  return cleanText(v, BODY, 'message');
}

async function filesByMessage(ticketId) {
  const rows = await q.all('SELECT id, message_id, name, mime, size FROM support_files WHERE ticket_id=? AND message_id IS NOT NULL ORDER BY created_at, id', ticketId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push({ id: r.id, name: r.name, mime: r.mime, size: Number(r.size) });
  }
  return map;
}

/** Lecture d'une pièce jointe. Pour un utilisateur : sa demande uniquement, et jamais celles des notes internes. */
export async function readTicketFile(ticketId, fileId, { userId = null } = {}) {
  const f = await q.get(
    `SELECT f.* FROM support_files f JOIN support_messages m ON m.id = f.message_id JOIN support_tickets t ON t.id = f.ticket_id
      WHERE f.id=? AND f.ticket_id=?${userId ? ' AND t.user_id=? AND m.internal = FALSE' : ''}`,
    fileId, ticketId, ...(userId ? [userId] : []),
  );
  if (!f) throw new HttpError(404, 'file_not_found', 'Fichier introuvable.');
  return { name: f.name, mime: f.mime, data: readDecrypted(f.storage_key, f.id, filesDir()) };
}

const attachmentNote = (n) => (n ? ` (${n} pièce${n > 1 ? 's' : ''} jointe${n > 1 ? 's' : ''})` : '');

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// ---------- Sérialisation ----------
function serializeTicket(t, { staff = false } = {}) {
  return {
    id: t.id,
    object: 'support_ticket',
    number: Number(t.number),
    subject: t.subject,
    category: t.category,
    category_label: CATEGORIES[t.category] || t.category,
    status: t.status,
    transaction_id: t.transaction_id || null,
    unread: Number(staff ? t.staff_unread : t.user_unread),
    last_message_at: t.last_message_at,
    created_at: t.created_at,
    closed_at: t.closed_at,
    ...(staff ? {
      assigned: t.assigned_staff_id || t.assigned_name ? { id: t.assigned_staff_id, name: t.assigned_name } : null,
      user: t.user_full_name !== undefined ? { id: t.user_id, full_name: t.user_full_name, email: t.user_email } : { id: t.user_id },
      last_author: t.last_author || null,
    } : {}),
  };
}

function serializeMessage(m, { staff = false, files } = {}) {
  const fromStaff = m.author_type === 'staff';
  return {
    id: m.id,
    object: 'support_message',
    author: fromStaff ? 'support' : m.author_type, // user | support | system
    // L'utilisateur ne voit que le prénom du conseiller ; l'équipe voit le nom complet.
    author_name: m.author_type === 'system' ? null : fromStaff && !staff ? (firstName(m.author_name) ? `${firstName(m.author_name)} · Support Pay243` : 'Support Pay243') : m.author_name,
    body: m.body,
    attachments: files?.get(m.id) || [],
    ...(staff ? { internal: !!m.internal } : {}),
    created_at: m.created_at,
  };
}

async function addMessage(ticketId, { type, authorId = null, authorName = null, body, internal = false }) {
  const id = newId('msg');
  await q.run('INSERT INTO support_messages (id, ticket_id, author_type, author_id, author_name, body, internal, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, ticketId, type, authorId, authorName, body, internal, now());
  return id;
}

async function assertRoom(ticketId) {
  const { n } = await q.get('SELECT COUNT(*)::int AS n FROM support_messages WHERE ticket_id=?', ticketId);
  if (n >= MAX_MESSAGES) throw new HttpError(409, 'ticket_full', 'Cette conversation est trop longue : ouvrez une nouvelle demande.');
}

// =====================================================================
//  Côté utilisateur
// =====================================================================
const ownTicket = async (user, id, lock = false) => {
  const t = await q.get(`SELECT * FROM support_tickets WHERE id=? AND user_id=?${lock ? ' FOR UPDATE' : ''}`, id, user.id);
  if (!t) throw new HttpError(404, 'ticket_not_found', 'Demande introuvable.');
  return t;
};

export async function listUserTickets(user) {
  const rows = await q.all('SELECT * FROM support_tickets WHERE user_id=? ORDER BY last_message_at DESC LIMIT 100', user.id);
  return rows.map((t) => serializeTicket(t));
}

export async function userUnread(user) {
  const r = await q.get("SELECT COALESCE(SUM(user_unread),0)::int AS n FROM support_tickets WHERE user_id=?", user.id);
  return r.n;
}

export async function createTicket(user, body) {
  const subject = cleanText(body?.subject, SUBJECT, 'subject');
  const message = cleanText(body?.message, BODY, 'message');
  const attachments = parseAttachments(body?.attachments);
  const category = CATEGORIES[body?.category] ? body.category : 'other';
  let transactionId = null;
  if (body?.transaction_id) {
    // La transaction citée doit appartenir à l'utilisateur.
    const t = await q.get(
      `SELECT t.id FROM transactions t
        WHERE t.id=? AND EXISTS (SELECT 1 FROM wallets w WHERE w.owner_type='user' AND w.owner_id=? AND (w.id = t.from_wallet OR w.id = t.to_wallet))`,
      String(body.transaction_id), user.id,
    );
    if (!t) throw new HttpError(400, 'invalid_transaction', 'Transaction introuvable sur votre compte.');
    transactionId = t.id;
  }
  const id = newId('tkt');
  await tx(async () => {
    await q.get('SELECT id FROM users WHERE id=? FOR UPDATE', user.id); // sérialise les créations simultanées
    const { n } = await q.get("SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id=? AND status <> 'closed'", user.id);
    if (n >= MAX_OPEN_TICKETS) throw new HttpError(409, 'too_many_tickets', `Vous avez déjà ${MAX_OPEN_TICKETS} demandes en cours. Répondez dans l'une d'elles ou attendez leur résolution.`);
    const ts = now();
    await q.run(`INSERT INTO support_tickets (id, user_id, subject, category, status, transaction_id, staff_unread, last_author, last_message_at, created_at, updated_at)
                 VALUES (?,?,?,?,'open',?,1,'user',?,?,?)`, id, user.id, subject, category, transactionId, ts, ts, ts);
    const mid = await addMessage(id, { type: 'user', authorId: user.id, authorName: user.full_name, body: message });
    await linkFiles({ type: 'user', id: user.id }, attachments, id, mid);
  });
  const t = await q.get('SELECT * FROM support_tickets WHERE id=?', id);
  notifyUser(user, 'account', `Demande #${t.number} reçue par le support Pay243`, `Nous avons bien reçu votre demande « ${subject} ». Un conseiller vous répond dans votre espace Pay243.`, {
    title: 'Votre demande est enregistrée',
    paragraphs: ['Nous avons bien reçu votre demande. Un conseiller Pay243 vous répond dès que possible, directement dans votre espace : vous serez prévenu par email à chaque réponse.'],
    details: [['Demande', `#${t.number}`], ['Objet', subject], ['Rubrique', CATEGORIES[category]]],
    cta: { label: 'Suivre ma demande', url: appUrl('/aide#support') },
  });
  notifySupportTeam(t, user, message + attachmentNote(attachments.length));
  return getUserTicket(user, id);
}

/** Demande et messages visibles par l'utilisateur ; marque les réponses comme lues. */
export async function getUserTicket(user, id) {
  const t = await ownTicket(user, id);
  if (t.user_unread) await q.run('UPDATE support_tickets SET user_unread=0 WHERE id=?', t.id);
  const messages = await q.all('SELECT * FROM support_messages WHERE ticket_id=? AND internal = FALSE ORDER BY created_at ASC, id ASC', t.id);
  const files = await filesByMessage(t.id);
  return { ticket: serializeTicket({ ...t, user_unread: 0 }), messages: messages.map((m) => serializeMessage(m, { files })) };
}

export async function userReply(user, id, body) {
  const attachments = parseAttachments(body?.attachments);
  const message = bodyOrEmpty(body?.body ?? body?.message, attachments);
  await tx(async () => {
    const t = await ownTicket(user, id, true);
    await assertRoom(t.id);
    const mid = await addMessage(t.id, { type: 'user', authorId: user.id, authorName: user.full_name, body: message });
    await linkFiles({ type: 'user', id: user.id }, attachments, t.id, mid);
    // Un message de l'utilisateur remet la demande dans la file du support (et la rouvre si elle était close).
    await q.run("UPDATE support_tickets SET status='open', closed_at=NULL, staff_unread = staff_unread + 1, last_author='user', last_message_at=?, updated_at=? WHERE id=?", now(), now(), t.id);
  });
  return getUserTicket(user, id);
}

export async function userClose(user, id) {
  await tx(async () => {
    const t = await ownTicket(user, id, true);
    if (t.status === 'closed') return;
    await addMessage(t.id, { type: 'system', body: 'Demande marquée comme résolue par vous.' });
    await q.run("UPDATE support_tickets SET status='closed', closed_at=?, updated_at=? WHERE id=?", now(), now(), t.id);
  });
  return getUserTicket(user, id);
}

// =====================================================================
//  Côté équipe (back-office)
// =====================================================================
const findTicket = async (id, lock = false) => {
  const t = await q.get(`SELECT * FROM support_tickets WHERE id=?${lock ? ' FOR UPDATE' : ''}`, id);
  if (!t) throw new HttpError(404, 'ticket_not_found', 'Demande introuvable.');
  return t;
};

export async function supportSummary() {
  const r = await q.get(`SELECT COUNT(*) FILTER (WHERE status='open')::int AS open,
      COUNT(*) FILTER (WHERE status='answered')::int AS answered,
      COUNT(*) FILTER (WHERE status='open' AND assigned_staff_id IS NULL AND assigned_name IS NULL)::int AS unassigned
    FROM support_tickets`);
  return r;
}

export async function listTickets({ status, term, assigned, admin, limit = 100 } = {}) {
  const where = []; const args = [];
  if (STATUSES.includes(status)) { where.push('t.status = ?'); args.push(status); }
  if (assigned === 'me') {
    if (admin.id) { where.push('t.assigned_staff_id = ?'); args.push(admin.id); } else { where.push('t.assigned_staff_id IS NULL AND t.assigned_name = ?'); args.push(admin.name); }
  }
  if (assigned === 'none') where.push('t.assigned_staff_id IS NULL AND t.assigned_name IS NULL');
  const s = String(term || '').trim().slice(0, 100);
  if (s) {
    const like = `%${s.replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(t.id = ? OR t.number = ? OR t.subject ILIKE ? OR u.email ILIKE ? OR u.full_name ILIKE ?)');
    args.push(s, /^#?\d{1,12}$/.test(s) ? Number(s.replace('#', '')) : -1, like, like, like);
  }
  const rows = await q.all(
    `SELECT t.*, u.full_name AS user_full_name, u.email AS user_email FROM support_tickets t JOIN users u ON u.id = t.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.last_message_at ${status === 'closed' ? 'DESC' : 'ASC'} LIMIT ?`,
    ...args, Math.min(Number(limit) || 100, 200),
  );
  return rows.map((t) => serializeTicket(t, { staff: true }));
}

/** Vue complète pour l'équipe (notes internes comprises). `markRead` remet le compteur de non-lus à zéro. */
export async function getTicket(id, { markRead = false } = {}) {
  const t = await findTicket(id);
  if (markRead && t.staff_unread) await q.run('UPDATE support_tickets SET staff_unread=0 WHERE id=?', t.id);
  const u = await q.get('SELECT id, full_name, email, phone, account_type, kyc_level, status, activated_at, created_at FROM users WHERE id=?', t.user_id);
  const messages = await q.all('SELECT * FROM support_messages WHERE ticket_id=? ORDER BY created_at ASC, id ASC', t.id);
  const others = await q.get('SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id=? AND id<>?', t.user_id, t.id);
  const files = await filesByMessage(t.id);
  return {
    ticket: {
      ...serializeTicket({ ...t, staff_unread: markRead ? 0 : t.staff_unread, user_full_name: u?.full_name, user_email: u?.email }, { staff: true }),
      user: u ? { id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, account_type: u.account_type, kyc_level: u.kyc_level, status: u.status, activated: !!u.activated_at, created_at: u.created_at, other_tickets: others.n } : { id: t.user_id },
    },
    messages: messages.map((m) => serializeMessage(m, { staff: true, files })),
  };
}

/** Réponse d'un conseiller (visible par l'utilisateur) ou note interne (équipe uniquement). */
export async function staffReply(admin, id, body) {
  const attachments = parseAttachments(body?.attachments);
  const message = bodyOrEmpty(body?.body ?? body?.message, attachments);
  const internal = body?.internal === true;
  let ticket;
  await tx(async () => {
    const t = await findTicket(id, true);
    await assertRoom(t.id);
    const mid = await addMessage(t.id, { type: 'staff', authorId: admin.id || null, authorName: admin.name, body: message, internal });
    await linkFiles(staffOwner(admin), attachments, t.id, mid);
    if (internal) {
      await q.run('UPDATE support_tickets SET updated_at=? WHERE id=?', now(), t.id);
    } else {
      // Répondre attribue la demande à son auteur si personne ne s'en occupait.
      const takeOver = !t.assigned_staff_id && !t.assigned_name;
      await q.run(`UPDATE support_tickets SET status='answered', closed_at=NULL, user_unread = user_unread + 1, staff_unread = 0, last_author='staff',
                     last_message_at=?, updated_at=?, assigned_staff_id = CASE WHEN ? THEN ? ELSE assigned_staff_id END, assigned_name = CASE WHEN ? THEN ? ELSE assigned_name END
                   WHERE id=?`, now(), now(), takeOver, admin.id || null, takeOver, admin.name, t.id);
    }
    ticket = t;
  });
  if (!internal) {
    const user = await q.get('SELECT * FROM users WHERE id=?', ticket.user_id);
    if (user && user.status !== 'closed') {
      const excerpt = (message ? (message.length > 400 ? `${message.slice(0, 400)}…` : message) : 'Le conseiller vous a envoyé un document.') + attachmentNote(attachments.length);
      notifyUser(user, 'account', `Réponse du support Pay243 — demande #${ticket.number}`, `Le support Pay243 a répondu à votre demande « ${ticket.subject} ».`, {
        title: 'Le support vous a répondu',
        paragraphs: [`Un conseiller a répondu à votre demande #${ticket.number} « ${ticket.subject} » :`, excerpt, 'Répondez directement depuis votre espace Pay243 (pas par email).'],
        cta: { label: 'Lire et répondre', url: appUrl('/aide#support') },
        footer: 'Pay243 ne vous demandera jamais votre mot de passe, votre PIN ni un code de vérification, y compris par le support.',
      });
    }
  }
  return getTicket(id);
}

/** Propriétaire des fichiers envoyés par un membre de l'équipe (une clé de service n'a pas d'id). */
export const staffOwner = (admin) => ({ type: 'staff', id: admin.id || `key:${admin.name}` });

/** Attribution : `me` (prendre la demande) ou `none` (la remettre dans la file commune). */
export async function assignTicket(admin, id, to) {
  if (!['me', 'none'].includes(to)) throw new HttpError(400, 'invalid_assignee', 'Attribution : "me" ou "none".');
  await tx(async () => {
    const t = await findTicket(id, true);
    const mine = to === 'me';
    await q.run('UPDATE support_tickets SET assigned_staff_id=?, assigned_name=?, updated_at=? WHERE id=?', mine ? admin.id || null : null, mine ? admin.name : null, now(), t.id);
    await addMessage(t.id, { type: 'system', body: mine ? `Demande prise en charge par ${admin.name}.` : `Demande remise dans la file commune par ${admin.name}.`, internal: true });
  });
  return getTicket(id);
}

export async function setTicketStatus(admin, id, status) {
  if (!['open', 'closed'].includes(status)) throw new HttpError(400, 'invalid_status', 'Statut : "closed" (clore) ou "open" (rouvrir).');
  let changed = null;
  await tx(async () => {
    const t = await findTicket(id, true);
    if (t.status === status || (status === 'open' && t.status !== 'closed')) return;
    if (status === 'closed') {
      await addMessage(t.id, { type: 'system', body: 'Demande close par le support Pay243. Un nouveau message de votre part la rouvre.' });
      await q.run("UPDATE support_tickets SET status='closed', closed_at=?, staff_unread=0, updated_at=? WHERE id=?", now(), now(), t.id);
    } else {
      await addMessage(t.id, { type: 'system', body: 'Demande rouverte par le support Pay243.' });
      await q.run("UPDATE support_tickets SET status='open', closed_at=NULL, updated_at=? WHERE id=?", now(), t.id);
    }
    changed = t;
  });
  return { result: await getTicket(id), changed: !!changed };
}

/** Prévient par email les conseillers actifs (rôle Support) qu'une nouvelle demande est arrivée. */
function notifySupportTeam(ticket, user, message) {
  q.all("SELECT email FROM staff WHERE role='support' AND status='active' LIMIT 20").then((rows) => {
    const content = {
      preheader: `Nouvelle demande #${ticket.number}`,
      title: `Nouvelle demande #${ticket.number}`,
      paragraphs: [`${user.full_name} a ouvert une demande : « ${ticket.subject} ».`, message.length > 300 ? `${message.slice(0, 300)}…` : message],
      details: [['Rubrique', CATEGORIES[ticket.category]], ['Client', user.email || user.phone || user.id]],
      cta: { label: 'Ouvrir dans le back-office', url: appUrl('/admin#support') },
    };
    for (const r of rows) {
      emailProvider().send({ to: r.email, subject: `Support : nouvelle demande #${ticket.number}`, text: layoutText(content), html: layoutHtml(content), tag: 'support' })
        .catch((e) => console.error('[support:notify]', e.message));
    }
  }).catch((e) => console.error('[support:notify]', e.message));
}
