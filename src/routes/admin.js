import { Router } from 'express';
import { assertNewPassword, hashSecret, verifySecret } from '../auth.js';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { auditLedger, serializeTxn } from '../ledger.js';
import { rateLimit } from '../middleware.js';
import { issueOtp, verifyOtp } from '../otp.js';
import { emailProvider, layoutHtml, layoutText } from '../providers/email/index.js';
import { appUrl, notifyUser } from '../services/notify.js';
import { listPlatformSettings, updatePlatformSettings } from '../services/platformSettings.js';
import {
  ROLES, actorLabel, assertNotLastSuperAdmin, can, canManageRole, checkStaffPassword, createStaff, markLogin, permissionsOf,
  requireStaff, serializeStaff, signStaffToken, temporaryPassword,
} from '../staff.js';
import { HttpError, now, parseJson } from '../util.js';

export const backofficeRouter = Router();
const loginLimiter = rateLimit({ name: 'staff_login', max: config.rateLimits.auth });

/** Journal d'audit : qui, quoi, sur quoi, depuis où. */
export async function logAction(req, action, target, details) {
  await q.run('INSERT INTO admin_audit (actor, staff_id, action, target, details, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    actorLabel(req.admin), req.admin.id || null, action, target || null, details ? JSON.stringify(details) : null, req.ip || null, now());
}

// =====================================================================
//  Connexion de l'équipe : email + mot de passe, puis code envoyé par email (à chaque connexion)
// =====================================================================
backofficeRouter.post('/admin/auth/login', loginLimiter, async (req, res) => {
  const { email, password, otp_code } = req.body || {};
  const s = await checkStaffPassword(email, password);
  if (!otp_code) {
    const sent = await issueOtp(s.email, 'staff_login').catch((e) => { if (e.code === 'otp_too_soon') return null; throw e; });
    return res.json({ otp_required: true, channel: 'email', message: `Code envoyé à ${s.email.replace(/^(.{2}).*@/, '$1•••@')}.`, ...(sent?.sandbox_code ? { sandbox_code: sent.sandbox_code } : {}) });
  }
  await verifyOtp(s.email, 'staff_login', otp_code);
  await markLogin(s.id);
  await q.run('INSERT INTO admin_audit (actor, staff_id, action, target, details, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    `${s.full_name} <${s.email}>`, s.id, 'staff.login', s.id, null, req.ip || null, now());
  res.json({ token: signStaffToken(s.id), staff: serializeStaff(s), must_change_password: !!s.must_change_password });
});

backofficeRouter.use('/admin', requireStaff);

backofficeRouter.get('/admin/me', (req, res) => {
  res.json({
    id: req.admin.id, name: req.admin.name, email: req.admin.email, role: req.admin.role, role_label: ROLES[req.admin.role].label,
    permissions: req.admin.permissions, via: req.admin.via, must_change_password: !!req.admin.mustChangePassword, mode: config.mode,
  });
});

/** Changement de son propre mot de passe (obligatoire après un mot de passe provisoire). */
backofficeRouter.post('/admin/auth/password', async (req, res) => {
  if (req.admin.via !== 'session') throw new HttpError(400, 'not_a_session', 'Réservé aux comptes de l’équipe.');
  const { current_password, new_password } = req.body || {};
  if (!(await verifySecret(current_password || '', req.admin.staff.password_hash))) throw new HttpError(401, 'invalid_password', 'Mot de passe actuel incorrect.');
  assertNewPassword(new_password);
  if (String(new_password).length < 12) throw new HttpError(400, 'weak_password', 'Pour le back-office, 12 caractères minimum.');
  if (current_password === new_password) throw new HttpError(400, 'same_password', 'Choisissez un mot de passe différent.');
  await q.run('UPDATE staff SET password_hash=?, must_change_password=FALSE, sessions_valid_after=? WHERE id=?', await hashSecret(new_password), Date.now(), req.admin.id);
  await logAction(req, 'staff.password_change', req.admin.id);
  res.json({ token: signStaffToken(req.admin.id) });
});

// =====================================================================
//  Tableau de bord
// =====================================================================
backofficeRouter.get('/admin/dashboard', can('dashboard.view'), async (_req, res) => {
  const since24 = new Date(Date.now() - 864e5).toISOString();
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const users = await q.get(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE created_at >= ?)::int AS new_7d,
      COUNT(*) FILTER (WHERE status='suspended')::int AS suspended,
      COUNT(*) FILTER (WHERE account_type='business')::int AS business,
      COUNT(*) FILTER (WHERE kyc_level >= 2)::int AS verified,
      COUNT(*) FILTER (WHERE activated_at IS NULL AND status='active')::int AS awaiting_activation FROM users`, since7);
  const volume = await q.all(`SELECT currency, type, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::bigint AS amount
      FROM transactions WHERE status='succeeded' AND created_at >= ? GROUP BY currency, type ORDER BY currency, type`, since24);
  const signups = await q.all(`SELECT substr(created_at,1,10) AS day, COUNT(*)::int AS n FROM users WHERE created_at >= ? GROUP BY 1 ORDER BY 1`, since7);
  res.json({
    mode: config.mode,
    users,
    merchants: (await q.get('SELECT COUNT(*)::int AS n FROM merchants')).n,
    kyc_pending: (await q.get("SELECT COUNT(*)::int AS n FROM kyc_submissions WHERE status='pending'")).n,
    recon_open: (await q.get("SELECT COUNT(*)::int AS n FROM recon_exceptions WHERE status='open'")).n,
    pending_transactions: (await q.get("SELECT COUNT(*)::int AS n FROM transactions WHERE status='pending'")).n,
    volume_24h: volume.map((v) => ({ ...v, amount: Number(v.amount) })),
    signups_7d: signups,
    ledger: await auditLedger(),
    recent_users: (await q.all('SELECT id, full_name, email, account_type, created_at FROM users ORDER BY created_at DESC LIMIT 6')),
  });
});

// =====================================================================
//  Utilisateurs
// =====================================================================
const userRow = (u) => ({
  id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, handle: u.handle, account_type: u.account_type,
  kyc_level: u.kyc_level, status: u.status, activated: !!u.activated_at, activated_at: u.activated_at, pin_locked: u.pin_failures >= 5, created_at: u.created_at,
  suspended_reason: u.suspended_reason, suspended_at: u.suspended_at, closed_at: u.closed_at,
});

backofficeRouter.get('/admin/users', can('users.view'), async (req, res) => {
  const term = String(req.query.q || '').trim();
  const status = String(req.query.status || '');
  const where = []; const args = [];
  if (term) {
    where.push('(id = ? OR email ILIKE ? OR phone LIKE ? OR full_name ILIKE ? OR handle ILIKE ?)');
    const like = `%${term.replace(/[%_]/g, '\\$&')}%`;
    args.push(term, like, `%${term.replace(/\D/g, '') || term}%`, like, `%${term.replace(/^@/, '')}%`);
  }
  if (['active', 'suspended', 'closed'].includes(status)) { where.push('status = ?'); args.push(status); }
  if (req.query.kyc) { where.push('kyc_level = ?'); args.push(Number(req.query.kyc)); }
  if (['personal', 'business'].includes(req.query.type)) { where.push('account_type = ?'); args.push(req.query.type); }
  if (req.query.activation === 'pending') where.push('activated_at IS NULL');
  if (req.query.activation === 'active') where.push('activated_at IS NOT NULL');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await q.all(`SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, ...args, limit);
  res.json({ data: rows.map(userRow) });
});

const findUser = async (id) => {
  const u = await q.get('SELECT * FROM users WHERE id=?', id);
  if (!u) throw new HttpError(404, 'user_not_found', 'Utilisateur introuvable.');
  return u;
};

backofficeRouter.get('/admin/users/:id', can('users.view'), async (req, res) => {
  const u = await findUser(req.params.id);
  const wallets = await q.all("SELECT id, currency, balance FROM wallets WHERE owner_type='user' AND owner_id=? ORDER BY currency", u.id);
  const ids = wallets.map((w) => w.id);
  const marks = ids.map(() => '?').join(',') || "''";
  const txns = ids.length ? await q.all(`SELECT * FROM transactions WHERE from_wallet IN (${marks}) OR to_wallet IN (${marks}) ORDER BY created_at DESC LIMIT 30`, ...ids, ...ids) : [];
  const merchant = await q.get('SELECT id, name, created_at, suspended_at FROM merchants WHERE owner_user_id=?', u.id);
  await logAction(req, 'user.view', u.id);
  res.json({
    user: { ...userRow(u), nationality: u.nationality, timezone: u.timezone, email_verified: !!u.email_verified_at, phone_verified: !!u.phone_verified_at },
    wallets: wallets.map((w) => ({ currency: w.currency, balance: Number(w.balance) })),
    transactions: txns.map((t) => serializeTxn(t, ids)),
    merchant: merchant || null,
    kyc_submissions: await q.all('SELECT id, status, document_type, created_at, reviewed_at, reviewer, review_note FROM kyc_submissions WHERE user_id=? ORDER BY created_at DESC', u.id),
    devices: (await q.get('SELECT COUNT(*)::int AS n FROM trusted_devices WHERE user_id=?', u.id)).n,
    addresses: await q.all('SELECT line1, line2, city, province, country, is_primary FROM addresses WHERE user_id=? ORDER BY is_primary DESC', u.id),
    cards: (await q.get('SELECT COUNT(*)::int AS n FROM cards WHERE user_id=?', u.id)).n,
  });
});

const reasonOf = (b, min = 5) => {
  const r = String(b?.reason || '').trim();
  if (r.length < min) throw new HttpError(400, 'reason_required', 'Motif obligatoire (journalisé).');
  return r.slice(0, 300);
};

backofficeRouter.post('/admin/users/:id/suspend', can('users.suspend'), async (req, res) => {
  const u = await findUser(req.params.id);
  if (u.status !== 'active') throw new HttpError(409, 'not_active', 'Ce compte n’est pas actif.');
  const reason = reasonOf(req.body);
  await q.run("UPDATE users SET status='suspended', suspended_reason=?, suspended_at=?, sessions_valid_after=? WHERE id=?", reason, now(), Date.now(), u.id);
  await logAction(req, 'user.suspend', u.id, { reason });
  notifyUser(u, 'account', 'Votre compte Pay243 est suspendu', 'Votre compte a été suspendu par notre équipe. Contactez le support pour en savoir plus.', {
    paragraphs: ['Votre compte Pay243 a été temporairement suspendu par notre équipe. Vous ne pouvez plus vous connecter ni effectuer d’opérations pour le moment.', 'Pour en connaître la raison ou demander sa réactivation, répondez au support Pay243.'],
  });
  res.json({ user: userRow(await findUser(u.id)) });
});

backofficeRouter.post('/admin/users/:id/reactivate', can('users.suspend'), async (req, res) => {
  const u = await findUser(req.params.id);
  if (u.status !== 'suspended') throw new HttpError(409, 'not_suspended', 'Ce compte n’est pas suspendu.');
  const reason = reasonOf(req.body);
  await q.run("UPDATE users SET status='active', suspended_reason=NULL, suspended_at=NULL WHERE id=?", u.id);
  await logAction(req, 'user.reactivate', u.id, { reason });
  notifyUser(u, 'account', 'Votre compte Pay243 est réactivé', 'Votre compte est de nouveau actif.', { cta: { label: 'Me connecter', url: appUrl('/app') } });
  res.json({ user: userRow(await findUser(u.id)) });
});

backofficeRouter.post('/admin/users/:id/unlock-pin', can('users.support'), async (req, res) => {
  const u = await findUser(req.params.id);
  await q.run('UPDATE users SET pin_failures=0 WHERE id=?', u.id);
  await logAction(req, 'user.unlock_pin', u.id, { reason: String(req.body?.reason || '').slice(0, 300) || null });
  res.json({ user: userRow(await findUser(u.id)) });
});

backofficeRouter.post('/admin/users/:id/revoke-sessions', can('users.support'), async (req, res) => {
  const u = await findUser(req.params.id);
  await tx(async () => {
    await q.run('UPDATE users SET sessions_valid_after=? WHERE id=?', Date.now(), u.id);
    await q.run('DELETE FROM trusted_devices WHERE user_id=?', u.id);
  });
  await logAction(req, 'user.revoke_sessions', u.id, { reason: String(req.body?.reason || '').slice(0, 300) || null });
  res.json({ revoked: true });
});

backofficeRouter.post('/admin/users/:id/kyc-level', can('users.kyc_override'), async (req, res) => {
  const u = await findUser(req.params.id);
  const level = Number(req.body?.level);
  if (![1, 2, 3].includes(level)) throw new HttpError(400, 'invalid_level', 'Niveau 1, 2 ou 3.');
  const reason = reasonOf(req.body);
  // Niveau 2 ou plus : compte activé ; retour au niveau 1 : compte désactivé jusqu'à une nouvelle vérification.
  await q.run('UPDATE users SET kyc_level=?, activated_at = CASE WHEN ? >= 2 THEN COALESCE(activated_at, ?) ELSE NULL END WHERE id=?', level, level, now(), u.id);
  await logAction(req, 'user.kyc_level', u.id, { from: u.kyc_level, to: level, reason });
  res.json({ user: userRow(await findUser(u.id)) });
});

// =====================================================================
//  Transactions
// =====================================================================
backofficeRouter.get('/admin/transactions', can('transactions.view'), async (req, res) => {
  const where = []; const args = [];
  const term = String(req.query.q || '').trim();
  if (term) { where.push('(t.id = ? OR t.provider_ref = ? OR t.phone LIKE ? OR t.payment_id = ?)'); args.push(term, term, `%${term.replace(/\D/g, '') || term}%`, term); }
  if (req.query.status) { where.push('t.status = ?'); args.push(String(req.query.status)); }
  if (req.query.type) { where.push('t.type = ?'); args.push(String(req.query.type)); }
  if (req.query.currency) { where.push('t.currency = ?'); args.push(String(req.query.currency)); }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await q.all(`
    SELECT t.*,
      COALESCE(fu.full_name, fm.name, fw.owner_type || ':' || fw.owner_id) AS from_name,
      COALESCE(tu.full_name, tm.name, tw.owner_type || ':' || tw.owner_id) AS to_name
    FROM transactions t
    LEFT JOIN wallets fw ON fw.id = t.from_wallet LEFT JOIN users fu ON fw.owner_type='user' AND fu.id = fw.owner_id LEFT JOIN merchants fm ON fw.owner_type='merchant' AND fm.id = fw.owner_id
    LEFT JOIN wallets tw ON tw.id = t.to_wallet LEFT JOIN users tu ON tw.owner_type='user' AND tu.id = tw.owner_id LEFT JOIN merchants tm ON tw.owner_type='merchant' AND tm.id = tw.owner_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT ?`, ...args, limit);
  res.json({ data: rows.map((t) => ({ ...serializeTxn(t), from_name: t.from_name, to_name: t.to_name, provider: t.provider, provider_ref: t.provider_ref })) });
});

// =====================================================================
//  Marchands
// =====================================================================
backofficeRouter.get('/admin/merchants', can('merchants.view'), async (req, res) => {
  const term = String(req.query.q || '').trim();
  const like = `%${term}%`;
  const rows = await q.all(`
    SELECT m.id, m.name, m.webhook_url, m.created_at, m.suspended_at, u.id AS owner_id, u.full_name AS owner_name, u.email AS owner_email,
      (SELECT COUNT(*)::int FROM api_keys k WHERE k.merchant_id=m.id AND k.revoked_at IS NULL) AS active_keys,
      (SELECT COUNT(*)::int FROM payments p WHERE p.merchant_id=m.id AND p.status='succeeded') AS paid_payments
    FROM merchants m JOIN users u ON u.id = m.owner_user_id
    ${term ? 'WHERE m.id = ? OR m.name ILIKE ? OR u.email ILIKE ?' : ''} ORDER BY m.created_at DESC LIMIT 200`, ...(term ? [term, like, like] : []));
  const balances = await q.all("SELECT owner_id, currency, balance FROM wallets WHERE owner_type='merchant'");
  res.json({ data: rows.map((m) => ({ ...m, balances: balances.filter((b) => b.owner_id === m.id).map((b) => ({ currency: b.currency, balance: Number(b.balance) })) })) });
});

backofficeRouter.post('/admin/merchants/:id/suspend', can('merchants.manage'), async (req, res) => {
  const reason = reasonOf(req.body);
  const r = await q.run('UPDATE merchants SET suspended_at=? WHERE id=? AND suspended_at IS NULL', now(), req.params.id);
  if (!r.changes) throw new HttpError(409, 'not_active', 'Marchand introuvable ou déjà suspendu.');
  await logAction(req, 'merchant.suspend', req.params.id, { reason });
  res.json({ suspended: true });
});

backofficeRouter.post('/admin/merchants/:id/reactivate', can('merchants.manage'), async (req, res) => {
  const reason = reasonOf(req.body);
  const r = await q.run('UPDATE merchants SET suspended_at=NULL WHERE id=? AND suspended_at IS NOT NULL', req.params.id);
  if (!r.changes) throw new HttpError(409, 'not_suspended', 'Marchand introuvable ou non suspendu.');
  await logAction(req, 'merchant.reactivate', req.params.id, { reason });
  res.json({ suspended: false });
});

backofficeRouter.post('/admin/merchants/:id/revoke-keys', can('merchants.manage'), async (req, res) => {
  const reason = reasonOf(req.body);
  const r = await q.run('UPDATE api_keys SET revoked_at=? WHERE merchant_id=? AND revoked_at IS NULL', now(), req.params.id);
  await logAction(req, 'merchant.revoke_keys', req.params.id, { reason, revoked: r.changes });
  res.json({ revoked: r.changes });
});

// =====================================================================
//  Équipe
// =====================================================================
backofficeRouter.get('/admin/roles', (req, res) => {
  res.json({ data: Object.entries(ROLES).map(([id, r]) => ({ id, ...r, permissions: permissionsOf(id), assignable: canManageRole(req.admin.role, id) })) });
});

backofficeRouter.get('/admin/staff', can('staff.view'), async (_req, res) => {
  res.json({ data: (await q.all('SELECT * FROM staff ORDER BY created_at ASC')).map(serializeStaff) });
});

function sendInvite(staff, password, inviter) {
  const content = {
    preheader: 'Votre accès au back-office Pay243',
    title: 'Votre accès au back-office Pay243',
    paragraphs: [`${inviter} vous a ouvert un accès au back-office Pay243 avec le rôle « ${ROLES[staff.role].label} ».`, 'Connectez-vous avec cette adresse et le mot de passe provisoire ci-dessous. Vous devrez en choisir un nouveau, et un code de vérification vous sera envoyé à chaque connexion.'],
    details: [['Identifiant', staff.email], ['Mot de passe provisoire', password], ['Rôle', ROLES[staff.role].label]],
    cta: { label: 'Ouvrir le back-office', url: appUrl('/admin') },
    footer: 'Ne transférez jamais cet email. Si vous ne vous attendiez pas à cet accès, prévenez immédiatement l’équipe Pay243.',
  };
  emailProvider().send({ to: staff.email, subject: 'Votre accès au back-office Pay243', text: layoutText(content), html: layoutHtml(content), tag: 'staff' })
    .catch((e) => console.error('[staff:invite]', e.message));
}

backofficeRouter.post('/admin/staff', can('staff.manage'), async (req, res) => {
  const { email, full_name, role } = req.body || {};
  if (!ROLES[role]) throw new HttpError(400, 'invalid_role', 'Rôle inconnu.');
  if (!canManageRole(req.admin.role, role)) throw new HttpError(403, 'forbidden', `Vous ne pouvez pas attribuer le rôle « ${ROLES[role].label} ».`);
  const { staff, password } = await createStaff({ email, full_name, role, created_by: actorLabel(req.admin) });
  await logAction(req, 'staff.create', staff.id, { email: staff.email, role });
  sendInvite(staff, password, req.admin.name);
  res.status(201).json({ staff: serializeStaff(staff), temporary_password: password, notice: 'Mot de passe provisoire envoyé par email ; il ne sera plus affiché.' });
});

const findStaff = async (id) => {
  const s = await q.get('SELECT * FROM staff WHERE id=?', id);
  if (!s) throw new HttpError(404, 'staff_not_found', 'Membre introuvable.');
  return s;
};

backofficeRouter.patch('/admin/staff/:id', can('staff.manage'), async (req, res) => {
  const s = await findStaff(req.params.id);
  if (s.id === req.admin.id) throw new HttpError(400, 'self_edit', 'Vous ne pouvez pas modifier votre propre rôle ou statut.');
  if (!canManageRole(req.admin.role, s.role)) throw new HttpError(403, 'forbidden', 'Ce membre a un rôle égal ou supérieur au vôtre.');
  const next = { role: s.role, status: s.status, full_name: s.full_name };
  if (req.body?.role !== undefined) {
    if (!ROLES[req.body.role]) throw new HttpError(400, 'invalid_role', 'Rôle inconnu.');
    if (!canManageRole(req.admin.role, req.body.role)) throw new HttpError(403, 'forbidden', `Vous ne pouvez pas attribuer le rôle « ${ROLES[req.body.role].label} ».`);
    next.role = req.body.role;
  }
  if (req.body?.status !== undefined) {
    if (!['active', 'suspended'].includes(req.body.status)) throw new HttpError(400, 'invalid_status', 'Statut : active ou suspended.');
    next.status = req.body.status;
  }
  if (req.body?.full_name !== undefined) {
    const n = String(req.body.full_name).trim();
    if (n.length < 3) throw new HttpError(400, 'invalid_name', 'Nom complet requis.');
    next.full_name = n;
  }
  await assertNotLastSuperAdmin(s, next);
  const revoke = next.status !== s.status || next.role !== s.role;
  await q.run('UPDATE staff SET role=?, status=?, full_name=?, sessions_valid_after = CASE WHEN ? THEN ? ELSE sessions_valid_after END WHERE id=?',
    next.role, next.status, next.full_name, revoke, Date.now(), s.id);
  await logAction(req, 'staff.update', s.id, { from: { role: s.role, status: s.status }, to: { role: next.role, status: next.status } });
  res.json({ staff: serializeStaff(await findStaff(s.id)) });
});

backofficeRouter.post('/admin/staff/:id/reset-password', can('staff.manage'), async (req, res) => {
  const s = await findStaff(req.params.id);
  if (s.id === req.admin.id) throw new HttpError(400, 'self_edit', 'Changez votre mot de passe depuis votre profil.');
  if (!canManageRole(req.admin.role, s.role)) throw new HttpError(403, 'forbidden', 'Ce membre a un rôle égal ou supérieur au vôtre.');
  const password = temporaryPassword();
  await q.run('UPDATE staff SET password_hash=?, must_change_password=TRUE, failed_logins=0, locked_until=NULL, sessions_valid_after=? WHERE id=?', await hashSecret(password), Date.now(), s.id);
  await logAction(req, 'staff.reset_password', s.id);
  sendInvite(s, password, req.admin.name);
  res.json({ temporary_password: password });
});

// =====================================================================
//  Paramètres de la plateforme
// =====================================================================
backofficeRouter.get('/admin/settings', can('settings.view'), async (_req, res) => {
  res.json({
    data: await listPlatformSettings(),
    environment: {
      mode: config.mode, base_url: config.baseUrl,
      drivers: { ...Object.fromEntries(Object.entries(config.providers).map(([k, v]) => [k, v.driver])), cards: config.cards.driver, email: config.email.driver, sms: config.sms.driver },
    },
  });
});

backofficeRouter.put('/admin/settings', can('settings.manage'), async (req, res) => {
  const changes = await updatePlatformSettings(req.body || {}, actorLabel(req.admin));
  await logAction(req, 'settings.update', null, { changes });
  res.json({ data: await listPlatformSettings() });
});

// =====================================================================
//  Journal d'audit
// =====================================================================
backofficeRouter.get('/admin/audit', can('audit.view'), async (req, res) => {
  const where = []; const args = [];
  if (req.query.action) { where.push('action LIKE ?'); args.push(`${req.query.action}%`); }
  if (req.query.target) { where.push('target = ?'); args.push(String(req.query.target)); }
  if (req.query.actor) { where.push('actor ILIKE ?'); args.push(`%${req.query.actor}%`); }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await q.all(`SELECT * FROM admin_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, limit);
  res.json({ data: rows.map((a) => ({ ...a, id: Number(a.id), details: parseJson(a.details) })) });
});
