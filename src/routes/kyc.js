import express, { Router } from 'express';
import { requireUser } from '../auth.js';
import { actorLabel, can, requireStaff } from '../staff.js';
import { config } from '../config.js';
import { rateLimit } from '../middleware.js';
import {
  approve, adminView, audit, getSubmission, listSubmissions, readSubmissionFile, reject, statusFor, submit, uploadFile,
} from '../services/kyc.js';
import { HttpError } from '../util.js';

// =====================================================================
//  Côté utilisateur : vérification d'identité (KYC niveau 2)
// =====================================================================
export const kycRouter = Router();
kycRouter.use('/kyc', requireUser);

kycRouter.get('/kyc', async (req, res) => res.json(await statusFor(req.user)));

/** Envoi d'une image brute : POST /v1/kyc/files/id_front avec Content-Type: image/jpeg. */
kycRouter.post(
  '/kyc/files/:kind',
  rateLimit({ name: 'kyc_upload', max: 20 }),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: config.kycReview.maxUploadBytes }),
  async (req, res) => res.status(201).json(await uploadFile(req.user, req.params.kind, req.body)),
);

kycRouter.post('/kyc/submissions', async (req, res) => res.status(201).json(await submit(req.user, req.body)));

// =====================================================================
//  Back-office : revue manuelle des demandes (interface : /admin)
// =====================================================================
export const adminRouter = Router();
adminRouter.use('/admin/kyc', requireStaff);

const ownSubmission = async (req) => {
  const s = await getSubmission(req.params.id);
  if (!s) throw new HttpError(404, 'submission_not_found', 'Demande introuvable.');
  return s;
};


adminRouter.get('/admin/kyc/submissions', can('kyc.view'), async (req, res) => {
  res.json({ data: await listSubmissions(String(req.query.status || 'pending'), Number(req.query.limit) || 50) });
});

adminRouter.get('/admin/kyc/submissions/:id', can('kyc.view'), async (req, res) => {
  const s = await ownSubmission(req);
  await audit(actorLabel(req.admin), 'kyc.view', s.id, null, req.ip);
  res.json(await adminView(s));
});

adminRouter.get('/admin/kyc/submissions/:id/files/:kind', can('kyc.view'), async (req, res) => {
  const s = await ownSubmission(req);
  const f = await readSubmissionFile(s, req.params.kind);
  await audit(actorLabel(req.admin), 'kyc.view_file', s.id, { kind: req.params.kind }, req.ip);
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
  res.send(f.data);
});

adminRouter.post('/admin/kyc/submissions/:id/approve', can('kyc.review'), async (req, res) => {
  res.json(await approve(req.params.id, actorLabel(req.admin), req.body || {}, req.ip));
});

adminRouter.post('/admin/kyc/submissions/:id/reject', can('kyc.review'), async (req, res) => {
  res.json(await reject(req.params.id, actorLabel(req.admin), req.body || {}, req.ip));
});
