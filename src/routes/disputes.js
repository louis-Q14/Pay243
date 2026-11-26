import { Router } from 'express';
import { requireUser } from '../auth.js';
import { closeDispute, sellerRefund, decideDispute, disputeFor, disputeForStaff, escalateDispute, listDisputes, listForStaff, openDispute, postMessage, serializeDispute, staffMessage } from '../services/disputes.js';
import { actorLabel, can, requireStaff } from '../staff.js';
import { config } from '../config.js';
import { updatePlatformSettings } from '../services/platformSettings.js';
import { HttpError } from '../util.js';
import { logAction } from './admin.js';

// =====================================================================
//  Protection des achats : litiges côté acheteur et côté vendeur (session requise)
// =====================================================================
export const disputesRouter = Router();
disputesRouter.use('/disputes', requireUser);

disputesRouter.post('/disputes', async (req, res) => {
  res.status(201).json(serializeDispute(await openDispute(req.user, req.body)));
});

disputesRouter.get('/disputes', async (req, res) => {
  res.json({ data: await listDisputes(req.user) });
});

disputesRouter.get('/disputes/:id', async (req, res) => {
  res.json(await disputeFor(req.user, req.params.id));
});

disputesRouter.post('/disputes/:id/messages', async (req, res) => {
  res.status(201).json(await postMessage(req.user, req.params.id, req.body?.message));
});

disputesRouter.post('/disputes/:id/escalate', async (req, res) => {
  res.json(await escalateDispute(req.user, req.params.id));
});

disputesRouter.post('/disputes/:id/close', async (req, res) => {
  res.json(await closeDispute(req.user, req.params.id));
});

disputesRouter.post('/disputes/:id/refund', async (req, res) => {
  res.json(await sellerRefund(req.user, req.params.id, req.body?.pin));
});

// =====================================================================
//  Back-office : réclamations à trancher (équipe support)
// =====================================================================
export const disputesAdminRouter = Router();
disputesAdminRouter.use(['/admin/disputes', '/admin/protection'], requireStaff);

const protectionState = () => ({ enabled: config.fees.protectionEnabled !== false, percent: config.fees.protectionPercent });

/** État de la Protection des achats : visible de toute l'équipe. */
disputesAdminRouter.get('/admin/protection', can('dashboard.view'), (_req, res) => res.json(protectionState()));

/** Activer / désactiver la Protection des achats : administrateur uniquement, journalisé. */
disputesAdminRouter.put('/admin/protection', can('protection.manage'), async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'invalid_setting', 'enabled : true ou false.');
  const changes = await updatePlatformSettings({ 'protection.enabled': req.body.enabled }, actorLabel(req.admin));
  await logAction(req, 'protection.toggle', null, { changes });
  res.json(protectionState());
});

disputesAdminRouter.get('/admin/disputes', can('support.view'), async (req, res) => {
  res.json({ data: await listForStaff(req.query.status) });
});

disputesAdminRouter.get('/admin/disputes/:id', can('support.view'), async (req, res) => {
  res.json(await disputeForStaff(req.params.id));
});

disputesAdminRouter.post('/admin/disputes/:id/messages', can('support.reply'), async (req, res) => {
  res.status(201).json(await staffMessage(req.params.id, req.body?.message, req.admin.full_name ? `${req.admin.full_name} (Pay243)` : 'Équipe Pay243'));
});

disputesAdminRouter.post('/admin/disputes/:id/decide', can('support.reply'), async (req, res) => {
  const d = await decideDispute(req.params.id, req.body?.winner, req.body?.note, actorLabel(req.admin));
  await logAction(req, 'dispute.decide', d.id, { winner: req.body.winner, amount: Number(d.amount), refunded: Number(d.refunded_amount), currency: d.currency });
  res.json(serializeDispute(d));
});
