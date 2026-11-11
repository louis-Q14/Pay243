import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { isUniqueViolation, q, tx } from '../db.js';
import { appUrl, notifyUser } from './notify.js';
import { HttpError, newId, now } from '../util.js';

// =====================================================================
//  Stockage chiffré des pièces (AES-256-GCM). Format du fichier : iv(12) | tag(16) | données chiffrées.
//  En production, préférez un stockage objet (S3 compatible) avec une clé gérée par KMS ; seul ce
//  module est à adapter.
// =====================================================================
const key = () => Buffer.from(config.kycReview.encryptionKey, 'hex');

function filePath(storageKey) {
  if (!/^[A-Za-z0-9_-]+$/.test(storageKey)) throw new Error('storage_key invalide');
  return path.join(config.kycReview.storageDir, `${storageKey}.enc`);
}

function writeEncrypted(storageKey, buf, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(buf), c.final()]);
  fs.mkdirSync(config.kycReview.storageDir, { recursive: true });
  fs.writeFileSync(filePath(storageKey), Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
}

function readDecrypted(storageKey, aad) {
  const raw = fs.readFileSync(filePath(storageKey));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// =====================================================================
//  Règles métier
// =====================================================================
export const FILE_KINDS = ['id_front', 'id_back', 'selfie'];

export const DOCUMENT_TYPES = {
  voter_card: { label: "Carte d'électeur (CENI)", needsBack: true },
  national_id: { label: "Carte nationale d'identité", needsBack: true },
  passport: { label: 'Passeport', needsBack: false },
  driving_license: { label: 'Permis de conduire', needsBack: true },
};

/** Détecte le type réel par les premiers octets (on ne fait pas confiance au Content-Type). */
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function uploadFile(user, kind, buf) {
  if (!FILE_KINDS.includes(kind)) throw new HttpError(400, 'invalid_kind', `Type de fichier inconnu. Valeurs : ${FILE_KINDS.join(', ')}.`);
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'empty_file', 'Envoyez l\'image en corps de requête (Content-Type: image/jpeg, image/png ou image/webp).');
  if (buf.length < 10 * 1024) throw new HttpError(400, 'image_too_small', 'Image trop petite ou illisible : reprenez la photo en pleine lumière.');
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(415, 'unsupported_image', 'Formats acceptés : JPEG, PNG ou WebP.');
  if (user.kyc_level >= 2) throw new HttpError(409, 'already_verified', 'Votre identité est déjà vérifiée.');
  const recent = (await q.get('SELECT COUNT(*) AS n FROM kyc_files WHERE user_id=? AND created_at >= ?', user.id, new Date(Date.now() - 24 * 3600e3).toISOString())).n;
  if (recent >= 30) throw new HttpError(429, 'too_many_uploads', 'Trop de fichiers envoyés aujourd\'hui. Réessayez demain.');

  const id = newId('kycf');
  const storageKey = crypto.randomBytes(18).toString('base64url');
  writeEncrypted(storageKey, buf, id);
  await q.run('INSERT INTO kyc_files (id, user_id, kind, mime, size, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, user.id, kind, mime, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), storageKey, now());
  return { id, object: 'kyc_file', kind, mime, size: buf.length };
}

function normalizeDocNumber(n) {
  const s = String(n || '').toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z0-9/]{5,30}$/.test(s)) throw new HttpError(400, 'invalid_document_number', 'Numéro de pièce invalide (5 à 30 lettres ou chiffres).');
  return s;
}

function assertAdult(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob || '')) || Number.isNaN(Date.parse(dob))) {
    throw new HttpError(400, 'invalid_date_of_birth', 'Date de naissance au format AAAA-MM-JJ requise.');
  }
  const d = new Date(`${dob}T00:00:00Z`);
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() - config.kycReview.minAge);
  if (d > limit) throw new HttpError(403, 'underage', `Vous devez avoir au moins ${config.kycReview.minAge} ans.`);
  if (d.getUTCFullYear() < 1900) throw new HttpError(400, 'invalid_date_of_birth', 'Date de naissance invalide.');
}

export async function submit(user, body) {
  const { document_type, files = {} } = body || {};
  const doc = DOCUMENT_TYPES[document_type];
  if (!doc) throw new HttpError(400, 'invalid_document_type', `document_type doit valoir : ${Object.keys(DOCUMENT_TYPES).join(', ')}.`);
  const number = normalizeDocNumber(body.document_number);
  assertAdult(body.date_of_birth);
  if (user.kyc_level >= 2) throw new HttpError(409, 'already_verified', 'Votre identité est déjà vérifiée.');

  const required = ['id_front', ...(doc.needsBack ? ['id_back'] : []), 'selfie'];
  const rows = {};
  for (const kind of required) {
    const id = files[kind];
    if (!id) throw new HttpError(400, 'missing_file', `Fichier manquant : ${kind}.`);
    const f = await q.get('SELECT * FROM kyc_files WHERE id=? AND user_id=?', id, user.id);
    if (!f || f.kind !== kind) throw new HttpError(400, 'invalid_file', `Fichier ${kind} introuvable.`);
    if (f.submission_id) throw new HttpError(400, 'file_already_used', `Le fichier ${kind} a déjà servi pour une demande. Reprenez la photo.`);
    rows[kind] = f;
  }
  if (new Set(Object.values(rows).map((f) => f.sha256)).size !== required.length) {
    throw new HttpError(400, 'duplicate_images', 'Chaque photo doit être différente (recto, verso et selfie).');
  }

  const pendingError = () => new HttpError(409, 'submission_pending', "Une demande est déjà en cours d'examen.");
  if (await q.get("SELECT id FROM kyc_submissions WHERE user_id=? AND status='pending'", user.id)) throw pendingError();
  try {
    return await tx(async () => {
      const id = newId('kyc');
      // Index unique partiel : une seule demande « pending » par utilisateur, même en concurrence.
      await q.run(`INSERT INTO kyc_submissions (id, user_id, level, status, document_type, document_number, date_of_birth, created_at)
             VALUES (?,?,2,'pending',?,?,?,?)`, id, user.id, document_type, number, body.date_of_birth, now());
      for (const f of Object.values(rows)) {
        const r = await q.run('UPDATE kyc_files SET submission_id=? WHERE id=? AND submission_id IS NULL', id, f.id);
        if (!r.changes) throw new HttpError(400, 'file_already_used', `Le fichier ${f.kind} a déjà servi pour une demande. Reprenez la photo.`);
      }
      return serializeSubmission(await getSubmission(id));
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw pendingError();
    throw e;
  }
}

export const getSubmission = (id) => q.get('SELECT * FROM kyc_submissions WHERE id=?', id);

function serializeSubmission(s, { admin = false } = {}) {
  if (!s) return null;
  return {
    id: s.id,
    object: 'kyc_submission',
    level: s.level,
    status: s.status,
    document_type: s.document_type,
    document_label: DOCUMENT_TYPES[s.document_type]?.label,
    document_number: admin ? s.document_number : `•••${s.document_number.slice(-3)}`,
    date_of_birth: admin ? s.date_of_birth : undefined,
    review_note: s.status === 'rejected' || admin ? s.review_note : null,
    reviewer: admin ? s.reviewer : undefined,
    reviewed_at: s.reviewed_at,
    created_at: s.created_at,
  };
}

/** Statut affiché à l'utilisateur. */
export async function statusFor(user) {
  const last = await q.get('SELECT * FROM kyc_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 1', user.id);
  return {
    kyc_level: user.kyc_level,
    limits: config.kyc[user.kyc_level],
    next_level: user.kyc_level < 2 ? { level: 2, ...config.kyc[2] } : null,
    can_submit: user.kyc_level < 2 && last?.status !== 'pending',
    document_types: Object.entries(DOCUMENT_TYPES).map(([id, d]) => ({ id, label: d.label, needs_back: d.needsBack })),
    last_submission: serializeSubmission(last),
  };
}

// =====================================================================
//  Back-office
// =====================================================================
export async function audit(actor, action, target, details, ip) {
  await q.run('INSERT INTO admin_audit (actor, action, target, details, ip, created_at) VALUES (?,?,?,?,?,?)',
    actor, action, target || null, details ? JSON.stringify(details) : null, ip || null, now());
}

/** Autres comptes ayant soumis la même pièce : signal fort de fraude (compte multiple, pièce volée). */
async function duplicatesOf(s) {
  const byNumber = await q.all(
    `SELECT s.id, s.status, s.user_id, u.full_name, u.phone FROM kyc_submissions s JOIN users u ON u.id = s.user_id
      WHERE s.document_type=? AND s.document_number=? AND s.user_id != ? AND s.status IN ('pending','approved')`,
    s.document_type, s.document_number, s.user_id,
  );
  const byImage = await q.all(
    `SELECT DISTINCT f2.user_id, u.full_name, u.phone FROM kyc_files f1
       JOIN kyc_files f2 ON f2.sha256 = f1.sha256 AND f2.user_id != f1.user_id
       JOIN users u ON u.id = f2.user_id
      WHERE f1.submission_id=?`, s.id,
  );
  return { same_document_number: byNumber, same_image: byImage };
}

export async function adminView(s) {
  const u = await q.get('SELECT * FROM users WHERE id=?', s.user_id);
  const files = await q.all('SELECT id, kind, mime, size, created_at FROM kyc_files WHERE submission_id=? ORDER BY kind', s.id);
  const history = await q.all('SELECT id, status, review_note, reviewed_at, created_at FROM kyc_submissions WHERE user_id=? AND id != ? ORDER BY created_at DESC', s.user_id, s.id);
  return {
    ...serializeSubmission(s, { admin: true }),
    user: { id: u.id, full_name: u.full_name, email: u.email, account_type: u.account_type, phone: u.phone, kyc_level: u.kyc_level, status: u.status, created_at: u.created_at },
    files,
    duplicates: await duplicatesOf(s),
    previous_submissions: history,
  };
}

export async function listSubmissions(status = 'pending', limit = 50) {
  const allowed = ['pending', 'approved', 'rejected'];
  if (!allowed.includes(status)) throw new HttpError(400, 'invalid_status', `status doit valoir : ${allowed.join(', ')}.`);
  const rows = await q.all(
    `SELECT s.*, u.full_name, u.phone, u.email FROM kyc_submissions s JOIN users u ON u.id = s.user_id
      WHERE s.status=? ORDER BY s.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ?`, status, Math.min(limit, 200),
  );
  return Promise.all(rows.map(async (s) => {
    const d = await duplicatesOf(s);
    return {
      ...serializeSubmission(s, { admin: true }),
      user: { full_name: s.full_name, phone: s.phone, email: s.email },
      flagged: d.same_document_number.length > 0 || d.same_image.length > 0,
    };
  }));
}

export async function readSubmissionFile(s, kind) {
  const f = await q.get('SELECT * FROM kyc_files WHERE submission_id=? AND kind=?', s.id, kind);
  if (!f) throw new HttpError(404, 'file_not_found', 'Fichier introuvable.');
  return { mime: f.mime, data: readDecrypted(f.storage_key, f.id) };
}

async function pendingOrThrow(id) {
  const s = await getSubmission(id);
  if (!s) throw new HttpError(404, 'submission_not_found', 'Demande introuvable.');
  if (s.status !== 'pending') throw new HttpError(409, 'already_reviewed', `Demande déjà traitée (${s.status}).`);
  return s;
}

export async function approve(id, reviewer, { note, override_duplicates = false } = {}, ip) {
  const s = await pendingOrThrow(id);
  const d = await duplicatesOf(s);
  const approvedElsewhere = d.same_document_number.filter((x) => x.status === 'approved');
  if (approvedElsewhere.length && !override_duplicates) {
    throw new HttpError(409, 'duplicate_document', 'Cette pièce est déjà validée sur un autre compte. Vérifiez, puis confirmez avec override_duplicates et une note.', { duplicates: approvedElsewhere });
  }
  if (override_duplicates && String(note || '').trim().length < 10) {
    throw new HttpError(400, 'note_required', 'Une note justificative (10 caractères min.) est requise pour passer outre un doublon.');
  }
  const user = await tx(async () => {
    // Décision conditionnelle : deux agents qui valident en même temps ne traitent la demande qu'une fois.
    const r = await q.run("UPDATE kyc_submissions SET status='approved', reviewer=?, review_note=?, reviewed_at=? WHERE id=? AND status='pending'", reviewer, note || null, now(), s.id);
    if (!r.changes) throw new HttpError(409, 'already_reviewed', 'Demande déjà traitée.');
    await q.run('UPDATE users SET kyc_level = GREATEST(kyc_level, ?), activated_at = COALESCE(activated_at, ?) WHERE id=?', s.level, now(), s.user_id);
    await audit(reviewer, 'kyc.approve', s.id, { user_id: s.user_id, override_duplicates: !!override_duplicates, note }, ip);
    return q.get('SELECT * FROM users WHERE id=?', s.user_id);
  });
  const lim = config.kyc[user.kyc_level];
  notifyUser(user, 'account', 'Votre compte Pay243 est activé', `Votre identité est vérifiée. Nouveaux plafonds : ${lim.perTxnUsd} $ par opération, ${lim.dailyUsd} $ par jour.`, {
    paragraphs: ['Bonne nouvelle : votre pièce d’identité a été vérifiée par notre équipe. Votre compte est activé : vous pouvez maintenant recharger, envoyer, payer et retirer.'],
    details: [['Par opération', `${lim.perTxnUsd} $`], ['Par jour', `${lim.dailyUsd} $`], ['Solde maximum', `${lim.maxBalanceUsd} $`]],
    cta: { label: 'Ouvrir mon wallet', url: appUrl('/app') },
  });
  return adminView(await getSubmission(s.id));
}

export async function reject(id, reviewer, { reason } = {}, ip) {
  const r = String(reason || '').trim();
  if (r.length < 5) throw new HttpError(400, 'reason_required', 'Motif de refus requis (affiché à l\'utilisateur).');
  const s = await pendingOrThrow(id);
  await tx(async () => {
    const res = await q.run("UPDATE kyc_submissions SET status='rejected', reviewer=?, review_note=?, reviewed_at=? WHERE id=? AND status='pending'", reviewer, r.slice(0, 300), now(), s.id);
    if (!res.changes) throw new HttpError(409, 'already_reviewed', 'Demande déjà traitée.');
    await audit(reviewer, 'kyc.reject', s.id, { user_id: s.user_id, reason: r }, ip);
  });
  const u = await q.get('SELECT * FROM users WHERE id=?', s.user_id);
  notifyUser(u, 'account', "Vérification d'identité refusée", `Vérification d'identité refusée. Motif : ${r.slice(0, 100)}. Vous pouvez soumettre une nouvelle demande depuis l'application.`, {
    paragraphs: ["Nous n'avons pas pu valider votre pièce d'identité.", `Motif : ${r.slice(0, 300)}`, 'Vous pouvez envoyer une nouvelle demande : photos nettes, en pleine lumière, sans reflet.'],
    cta: { label: 'Envoyer une nouvelle demande', url: appUrl('/app#kyc') },
  });
  return adminView(await getSubmission(s.id));
}
