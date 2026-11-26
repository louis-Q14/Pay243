// Sécurité du compte : questions de sécurité (réinitialisation du mot de passe), contact d'urgence,
// informations obligatoires encore manquantes.
import path from 'node:path';
import { hashSecret, verifySecret } from '../auth.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { writeEncrypted } from './kyc.js';
import { HttpError, newId, normalizeEmail, normalizePhone, now, parseJson } from '../util.js';

/** Questions proposées : le client en choisit 3 différentes. */
export const SECURITY_QUESTIONS = {
  mother_maiden: 'Quel est le nom de jeune fille de votre mère ?',
  birth_city: 'Dans quelle ville êtes-vous né(e) ?',
  first_school: 'Quel est le nom de votre première école ?',
  childhood_friend: 'Quel est le prénom de votre meilleur(e) ami(e) d’enfance ?',
  father_second_name: 'Quel est le deuxième prénom de votre père ?',
  favorite_teacher: 'Quel est le nom de votre enseignant(e) préféré(e) ?',
  childhood_street: 'Sur quelle avenue avez-vous grandi ?',
  first_job: 'Quel a été votre premier emploi ?',
  favorite_dish: 'Quel est votre plat préféré ?',
  first_phone: 'Quelle était la marque de votre premier téléphone ?',
};

/** Réponse comparée sans tenir compte des majuscules, des accents ni des espaces en trop. */
export const normalizeAnswer = (a) => String(a ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const bad = (code, message) => new HttpError(400, code, message);

/** Type réel du document d'après ses premiers octets (on ne fait pas confiance au Content-Type). */
function sniffDocument(buf) {
  if (buf.length > 4 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export const BUSINESS_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const businessDocumentDir = () => path.join(config.kycReview.storageDir, 'business');

/** Document RCCM d'un compte entreprise : chiffré (AES-256-GCM) comme les pièces d'identité. */
export async function saveBusinessDocument(user, buf) {
  if (user.account_type !== 'business') throw new HttpError(403, 'business_only', 'Réservé aux comptes entreprise.');
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('invalid_document', 'Envoyez le document RCCM : PDF ou photo (JPEG, PNG, WebP), 5 Mo maximum.');
  const mime = sniffDocument(buf);
  if (!mime) throw bad('invalid_document', 'Format non accepté : envoyez un PDF ou une photo (JPEG, PNG, WebP).');
  const id = newId('bdoc');
  const ts = now();
  writeEncrypted(id, buf, `${user.id}:rccm`, businessDocumentDir());
  await q.run('INSERT INTO business_documents (id, user_id, kind, storage_key, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', id, user.id, 'rccm', id, mime, buf.length, ts);
  await q.run('UPDATE users SET business_document_at=? WHERE id=?', ts, user.id);
  return { id, object: 'business_document', kind: 'rccm', mime, size: buf.length, created_at: ts };
}

/** Informations obligatoires encore manquantes (comptes inscrits avant ces règles) : à compléter avant toute opération. */
export function missingOf(user) {
  const m = [];
  if (!user.phone) m.push('phone');
  if (!user.security_questions) m.push('security_questions');
  if (!user.emergency_contact) m.push('emergency_contact');
  if (user.account_type === 'business' && !user.business_document_at) m.push('rccm_document');
  return m;
}

/** Les questions choisies par le client (sans les réponses). */
export const questionsOf = (user) => parseJson(user.security_questions, []).map((x) => ({ question: x.question, label: SECURITY_QUESTIONS[x.question] || x.question }));

/** Vrai si les réponses correspondent à celles enregistrées (compte sans questions : rien à vérifier). */
export async function answersMatch(user, answers) {
  const saved = parseJson(user.security_questions, []);
  if (!saved.length) return true;
  const given = new Map((Array.isArray(answers) ? answers : []).map((a) => [String(a?.question || ''), normalizeAnswer(a?.answer)]));
  for (const s of saved) {
    const a = given.get(s.question);
    if (!a || !(await verifySecret(a, s.hash))) return false;
  }
  return true;
}

/** Middleware : aucune opération d'argent tant que des informations obligatoires manquent. */
export async function requireComplete(req, _res, next) {
  const missing = missingOf(req.user);
  if (missing.length) {
    throw Object.assign(new HttpError(403, 'profile_incomplete', 'Complétez d’abord les informations de votre compte (questions de sécurité, contact d’urgence, téléphone, document RCCM).'), { details: { missing } });
  }
  next();
}

/** Contact d'urgence : nom complet, adresse, téléphone, email et lien avec le client, tous obligatoires. */
export function parseEmergencyContact(c, owner = {}) {
  const t = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (!c || typeof c !== 'object') throw bad('emergency_contact_required', 'Indiquez une personne à contacter en cas d’urgence.');
  const full_name = t(c.full_name, 80);
  if (full_name.length < 3) throw bad('invalid_emergency_name', 'Contact d’urgence : nom complet requis.');
  const address = t(c.address, 200);
  if (address.length < 5) throw bad('invalid_emergency_address', 'Contact d’urgence : adresse requise (numéro, avenue, commune, ville).');
  let phone; let email;
  try { phone = normalizePhone(c.phone); } catch { throw bad('invalid_emergency_phone', 'Contact d’urgence : numéro de téléphone invalide.'); }
  try { email = normalizeEmail(c.email); } catch { throw bad('invalid_emergency_email', 'Contact d’urgence : adresse email invalide.'); }
  const relation = t(c.relation, 40);
  if (relation.length < 2) throw bad('invalid_emergency_relation', 'Contact d’urgence : précisez votre lien avec cette personne (parent, conjoint, ami…).');
  if ((owner.phone && phone === owner.phone) || (owner.email && email === owner.email)) throw bad('emergency_contact_is_self', 'Le contact d’urgence doit être une autre personne que vous.');
  return JSON.stringify({ full_name, address, phone, email, relation });
}

/** 3 questions de la liste avec leur réponse. Renvoie les empreintes des réponses (JSON). */
export async function parseSecurityQuestions(list) {
  if (!Array.isArray(list) || list.length !== 3) throw bad('security_questions_required', 'Choisissez 3 questions de sécurité et répondez à chacune.');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const question = String(item?.question || '');
    if (!SECURITY_QUESTIONS[question]) throw bad('invalid_security_question', 'Question de sécurité inconnue.');
    if (seen.has(question)) throw bad('duplicate_security_question', 'Choisissez 3 questions différentes.');
    seen.add(question);
    const answer = normalizeAnswer(item.answer);
    if (answer.length < 2 || answer.length > 80) throw bad('invalid_security_answer', `Réponse trop courte ou trop longue : « ${SECURITY_QUESTIONS[question]} ».`);
    if (normalizeAnswer(item.answer_confirm) !== answer) throw bad('security_answers_mismatch', `Les deux réponses ne correspondent pas : « ${SECURITY_QUESTIONS[question]} ».`);
    out.push({ question, hash: await hashSecret(answer) });
  }
  return JSON.stringify(out);
}
