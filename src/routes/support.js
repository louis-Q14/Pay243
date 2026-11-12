import { Router } from 'express';
import { requireUser } from '../auth.js';
import { rateLimit } from '../middleware.js';
import {
  CATEGORIES, assignTicket, createTicket, getTicket, getUserTicket, listTickets, listUserTickets, setTicketStatus,
  staffReply, supportSummary, userClose, userReply, userUnread,
} from '../services/support.js';
import { can, requireStaff } from '../staff.js';
import { logAction } from './admin.js';

// =====================================================================
//  Support côté utilisateur : /v1/support/…  (session requise ; un compte non activé y a accès,
//  c'est souvent lui qui a besoin d'aide)
// =====================================================================
export const supportRouter = Router();
supportRouter.use('/support', requireUser);
const byUser = (req) => req.user.id;
const newTicketLimiter = rateLimit({ name: 'support_ticket', windowMs: 3600_000, max: 5, keyOf: byUser, message: 'Trop de nouvelles demandes. Réessayez dans une heure ou écrivez dans une demande existante.' });
const messageLimiter = rateLimit({ name: 'support_message', max: 20, keyOf: byUser, message: 'Trop de messages en peu de temps. Patientez une minute.' });

const categories = () => Object.entries(CATEGORIES).map(([id, label]) => ({ id, label }));

supportRouter.get('/support/tickets', async (req, res) => {
  const data = await listUserTickets(req.user);
  res.json({ data, unread: data.reduce((n, t) => n + t.unread, 0), categories: categories() });
});

supportRouter.get('/support/unread', async (req, res) => res.json({ unread: await userUnread(req.user) }));

supportRouter.post('/support/tickets', newTicketLimiter, async (req, res) => res.status(201).json(await createTicket(req.user, req.body || {})));

supportRouter.get('/support/tickets/:id', async (req, res) => res.json(await getUserTicket(req.user, req.params.id)));

supportRouter.post('/support/tickets/:id/messages', messageLimiter, async (req, res) => res.status(201).json(await userReply(req.user, req.params.id, req.body || {})));

supportRouter.post('/support/tickets/:id/close', async (req, res) => res.json(await userClose(req.user, req.params.id)));

// =====================================================================
//  Support côté équipe : /v1/admin/support/…
// =====================================================================
export const supportAdminRouter = Router();
supportAdminRouter.use('/admin/support', requireStaff);

supportAdminRouter.get('/admin/support/summary', can('support.view'), async (_req, res) => res.json(await supportSummary()));

supportAdminRouter.get('/admin/support/tickets', can('support.view'), async (req, res) => {
  res.json({
    data: await listTickets({ status: String(req.query.status || ''), term: req.query.q, assigned: String(req.query.assigned || ''), admin: req.admin, limit: req.query.limit }),
    summary: await supportSummary(),
    categories: categories(),
  });
});

supportAdminRouter.get('/admin/support/tickets/:id', can('support.view'), async (req, res) => {
  // Seuls les membres qui peuvent répondre font passer la demande à « lue ».
  res.json(await getTicket(req.params.id, { markRead: req.query.read === '1' && req.admin.permissions.includes('support.reply') }));
});

supportAdminRouter.post('/admin/support/tickets/:id/messages', can('support.reply'), async (req, res) => {
  const r = await staffReply(req.admin, req.params.id, req.body || {});
  await logAction(req, req.body?.internal === true ? 'support.note' : 'support.reply', req.params.id, { number: r.ticket.number });
  res.status(201).json(r);
});

supportAdminRouter.post('/admin/support/tickets/:id/assign', can('support.reply'), async (req, res) => {
  const r = await assignTicket(req.admin, req.params.id, String(req.body?.to || ''));
  await logAction(req, 'support.assign', req.params.id, { to: req.body?.to, number: r.ticket.number });
  res.json(r);
});

supportAdminRouter.post('/admin/support/tickets/:id/status', can('support.reply'), async (req, res) => {
  const { result, changed } = await setTicketStatus(req.admin, req.params.id, String(req.body?.status || ''));
  if (changed) await logAction(req, result.ticket.status === 'closed' ? 'support.close' : 'support.reopen', req.params.id, { number: result.ticket.number });
  res.json(result);
});
