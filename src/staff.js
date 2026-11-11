// =====================================================================
//  Équipe Pay243 : rôles, permissions, authentification du back-office
// =====================================================================
import crypto from 'node:crypto';
import { assertNewPassword, hashSecret, verifySecret } from './auth.js';
import { config } from './config.js';
import { isUniqueViolation, q } from './db.js';
import { HttpError, normalizeEmail, now, safeEqual, sha256 } from './util.js';

/** Rôles, du plus élevé au plus bas. Le rang sert aux règles de gestion de l'équipe. */
export const ROLES = {
  super_admin: { label: 'Super administrateur', rank: 100, description: 'Accès total : équipe, paramètres de la plateforme et toutes les opérations.' },
  admin: { label: 'Administrateur', rank: 80, description: 'Toutes les opérations ; gère les membres de rang inférieur.' },
  compliance: { label: 'Conformité', rank: 50, description: "Vérification d'identité (KYC), consultation des comptes." },
  finance: { label: 'Finance', rank: 50, description: 'Rapprochement, cantonnement, transactions et marchands.' },
  support: { label: 'Support', rank: 40, description: 'Consultation des comptes et transactions, déblocage du PIN, déconnexion des sessions.' },
  auditor: { label: 'Auditeur', rank: 30, description: 'Lecture seule de toute la plateforme et du journal.' },
};

const ALL = Object.keys(ROLES);
/** Permission -> rôles autorisés. Le super administrateur a toujours toutes les permissions. */
export const PERMISSIONS = {
  'dashboard.view': ALL,
  'users.view': ALL,
  'users.support': ['admin', 'support'], // débloquer le PIN, déconnecter les sessions
  'users.suspend': ['admin'], // suspendre / réactiver un compte
  'users.kyc_override': ['admin'], // changer le niveau KYC sans demande
  'transactions.view': ['admin', 'finance', 'support', 'auditor', 'compliance'],
  'merchants.view': ['admin', 'finance', 'support', 'auditor', 'compliance'],
  'merchants.manage': ['admin'], // suspendre un marchand, révoquer ses clés
  'kyc.view': ['admin', 'compliance', 'auditor'],
  'kyc.review': ['admin', 'compliance'],
  'recon.view': ['admin', 'finance', 'auditor'],
  'recon.manage': ['admin', 'finance'],
  'audit.view': ['admin', 'auditor'],
  'staff.view': ['admin'],
  'staff.manage': ['admin'], // limité aux rangs inférieurs, voir canManageRole
  'settings.view': ['admin', 'finance', 'auditor'],
  'settings.manage': [], // super administrateur uniquement
};

export const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((p) => role === 'super_admin' || PERMISSIONS[p].includes(role));
export const hasPermission = (role, perm) => role === 'super_admin' || !!PERMISSIONS[perm]?.includes(role);

/** Un membre ne gère que des rôles strictement inférieurs au sien ; le super administrateur gère tout. */
export function canManageRole(actorRole, targetRole) {
  if (actorRole === 'super_admin') return true;
  return hasPermission(actorRole, 'staff.manage') && ROLES[actorRole].rank > ROLES[targetRole].rank;
}

export function serializeStaff(s) {
  return {
    id: s.id, object: 'staff', email: s.email, full_name: s.full_name, role: s.role, role_label: ROLES[s.role]?.label,
    status: s.status, must_change_password: !!s.must_change_password, created_by: s.created_by,
    created_at: s.created_at, last_login_at: s.last_login_at,
  };
}

// ---------- Jetons de session (distincts de ceux des utilisateurs : typ = staff) ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SESSION_HOURS = 8;
export function signStaffToken(staffId, { pwdChange = false } = {}) {
  const t = Date.now();
  const body = b64({ sub: staffId, typ: 'staff', pwd: pwdChange || undefined, iat: Math.floor(t / 1000), iat_ms: t, exp: Math.floor(t / 1000) + SESSION_HOURS * 3600 });
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const sig = crypto.createHmac('sha256', `${config.jwtSecret}:staff`).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyStaffToken(token) {
  const [h, b, s] = String(token).split('.');
  if (!h || !b || !s) return null;
  const expected = crypto.createHmac('sha256', `${config.jwtSecret}:staff`).update(`${h}.${b}`).digest('base64url');
  if (!safeEqual(s, expected)) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  if (p.typ !== 'staff' || p.exp < Date.now() / 1000) return null;
  return p;
}

const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : null; };

/**
 * Authentifie un membre de l'équipe : session (email + mot de passe + code) ou clé ADMIN_KEYS (scripts).
 * req.admin = { id, name, email, role, permissions, via }.
 */
export async function requireStaff(req, _res, next) {
  if (req.admin) return next();
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'unauthorized', 'Connexion au back-office requise.');
  // Clés de service (ADMIN_KEYS) : réservées aux scripts et à l'accès de secours.
  if (token.startsWith('adm_') || !token.includes('.')) {
    const digest = sha256(token);
    const agent = config.admin.keys.find((a) => safeEqual(sha256(a.key), digest));
    if (!agent) throw new HttpError(401, 'invalid_admin_key', 'Clé back-office invalide.');
    const role = ROLES[agent.role] ? agent.role : 'super_admin';
    req.admin = { id: null, name: agent.name, email: null, role, permissions: permissionsOf(role), via: 'key' };
    return next();
  }
  const p = verifyStaffToken(token);
  if (!p) throw new HttpError(401, 'unauthorized', 'Session expirée. Reconnectez-vous.');
  const s = await q.get('SELECT * FROM staff WHERE id=?', p.sub);
  if (!s || s.status !== 'active') throw new HttpError(401, 'unauthorized', 'Compte désactivé.');
  if (Number(p.iat_ms) < Number(s.sessions_valid_after || 0)) throw new HttpError(401, 'unauthorized', 'Session expirée. Reconnectez-vous.');
  // Mot de passe provisoire : seul le changement de mot de passe est autorisé.
  const path = req.originalUrl.split('?')[0];
  if (s.must_change_password && !(path.endsWith('/admin/auth/password') || path.endsWith('/admin/me'))) {
    throw new HttpError(403, 'password_change_required', 'Choisissez un nouveau mot de passe avant de continuer.');
  }
  req.admin = { id: s.id, name: s.full_name, email: s.email, role: s.role, permissions: permissionsOf(s.role), via: 'session', staff: s, mustChangePassword: !!s.must_change_password };
  next();
}

/** Middleware : exige une permission (après requireStaff). */
export const can = (perm) => (req, _res, next) => {
  if (!req.admin) throw new HttpError(401, 'unauthorized', 'Connexion au back-office requise.');
  if (!hasPermission(req.admin.role, perm)) {
    throw new HttpError(403, 'forbidden', `Votre rôle (${ROLES[req.admin.role]?.label || req.admin.role}) ne permet pas cette action.`);
  }
  next();
};

/** Libellé de l'auteur dans le journal d'audit. */
export const actorLabel = (admin) => (admin.email ? `${admin.name} <${admin.email}>` : `${admin.name} (clé)`);

// ---------- Connexion ----------
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY = await hashSecret('pay243-staff-timing-equalizer');

/** Vérifie email + mot de passe avec verrouillage progressif. Renvoie le membre (sans ouvrir de session). */
export async function checkStaffPassword(email, password) {
  let e; try { e = normalizeEmail(email); } catch { e = null; }
  const s = e ? await q.get('SELECT * FROM staff WHERE email=?', e) : null;
  if (s?.locked_until && s.locked_until > now()) {
    const min = Math.ceil((Date.parse(s.locked_until) - Date.now()) / 60000);
    throw new HttpError(423, 'staff_locked', `Trop d'essais. Compte verrouillé pendant ${min} min.`);
  }
  const ok = await verifySecret(password || '', s?.password_hash || DUMMY);
  if (!s || !ok) {
    if (s) {
      const { failed_logins: n } = await q.get('UPDATE staff SET failed_logins = failed_logins + 1 WHERE id=? RETURNING failed_logins', s.id);
      if (n >= MAX_FAILED) await q.run('UPDATE staff SET locked_until=?, failed_logins=0 WHERE id=?', new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), s.id);
    }
    throw new HttpError(401, 'invalid_credentials', 'Email ou mot de passe incorrect.');
  }
  if (s.status !== 'active') throw new HttpError(403, 'staff_suspended', 'Ce compte du back-office est désactivé.');
  return s;
}

export async function markLogin(staffId) {
  await q.run('UPDATE staff SET failed_logins=0, locked_until=NULL, last_login_at=? WHERE id=?', now(), staffId);
}

// ---------- Gestion de l'équipe ----------
/** Mot de passe provisoire lisible (sans caractères ambigus). */
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

export async function createStaff({ email, full_name, role, password, created_by = null, mustChange = true }) {
  const e = normalizeEmail(email);
  if (!ROLES[role]) throw new HttpError(400, 'invalid_role', `Rôle inconnu. Rôles : ${Object.keys(ROLES).join(', ')}.`);
  const name = String(full_name || '').trim();
  if (name.length < 3) throw new HttpError(400, 'invalid_name', 'Nom complet requis (3 caractères min.).');
  const pwd = password || temporaryPassword();
  assertNewPassword(pwd);
  const id = `stf_${crypto.randomBytes(12).toString('base64url')}`;
  try {
    await q.run('INSERT INTO staff (id, email, full_name, role, password_hash, must_change_password, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, e, name, role, await hashSecret(pwd), mustChange, created_by, now());
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'staff_exists', 'Un membre de l’équipe utilise déjà cet email.');
    throw err;
  }
  return { staff: await q.get('SELECT * FROM staff WHERE id=?', id), password: pwd };
}

/** Garde-fou : il reste toujours au moins un super administrateur actif. */
export async function assertNotLastSuperAdmin(target, next) {
  if (target.role !== 'super_admin' || target.status !== 'active') return;
  const stillSuper = next.role === 'super_admin' && next.status === 'active';
  if (stillSuper) return;
  const { n } = await q.get("SELECT COUNT(*)::int AS n FROM staff WHERE role='super_admin' AND status='active' AND id<>?", target.id);
  if (!n) throw new HttpError(409, 'last_super_admin', 'Impossible : il doit rester au moins un super administrateur actif.');
}
