import express, { Router } from 'express';
import { actorLabel, can, requireStaff } from '../staff.js';
import { config } from '../config.js';
import {
  importStatement, listExceptions, listRuns, localDate, resolveException, safeguardingReport, sweepPending,
} from '../services/reconciliation.js';
import { HttpError } from '../util.js';

// =====================================================================
//  Back-office finance : rapprochement Mobile Money et cantonnement
// =====================================================================
export const reconRouter = Router();
reconRouter.use('/admin/reconciliation', requireStaff);

reconRouter.get('/admin/reconciliation/overview', can('recon.view'), async (_req, res) => {
  res.json({
    business_date: localDate(),
    operators: Object.entries(config.providers).map(([id, p]) => ({ id, label: p.label })),
    open_exceptions: (await listExceptions('open', 500)).length,
    runs: await listRuns(10),
  });
});

/**
 * Import d'un relevé opérateur (CSV au format canonique, voir services/reconciliation.js) :
 *   POST /v1/admin/reconciliation/statements?operator=mpesa&date=2026-11-10[&replace=1]
 *   Content-Type: text/csv
 */
reconRouter.post(
  '/admin/reconciliation/statements',
  can('recon.manage'),
  express.text({ type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], limit: '10mb' }),
  async (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(400, 'empty_statement', 'Envoyez le relevé en CSV (Content-Type: text/csv).');
    const run = await importStatement({
      operator: String(req.query.operator || ''),
      date: String(req.query.date || ''),
      csv: req.body,
      replace: req.query.replace === '1' || req.query.replace === 'true',
    }, actorLabel(req.admin), req.ip);
    res.status(201).json(run);
  },
);

reconRouter.get('/admin/reconciliation/runs', can('recon.view'), async (req, res) => res.json({ data: await listRuns(Number(req.query.limit) || 30) }));

reconRouter.get('/admin/reconciliation/exceptions', can('recon.view'), async (req, res) => {
  res.json({ data: await listExceptions(String(req.query.status || 'open'), Number(req.query.limit) || 100) });
});

reconRouter.post('/admin/reconciliation/exceptions/:id/resolve', can('recon.manage'), async (req, res) => {
  res.json(await resolveException(req.params.id, actorLabel(req.admin), req.body || {}, req.ip));
});

/** Lance immédiatement le contrôle des transactions en attente (sinon toutes les 5 min). */
reconRouter.post('/admin/reconciliation/sweep', can('recon.manage'), async (_req, res) => {
  res.json((await sweepPending()) || { busy: true });
});

/** ?trust_CDF=…&trust_USD=… : solde du compte de cantonnement (unités mineures) pour calculer la couverture. */
reconRouter.get('/admin/reconciliation/safeguarding', can('recon.view'), async (req, res) => {
  const trust = {};
  for (const c of config.currencies) {
    const v = req.query[`trust_${c}`];
    if (v != null && v !== '') {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new HttpError(400, 'invalid_amount', `trust_${c} doit être un entier (unités mineures).`);
      trust[c] = n;
    }
  }
  res.json({ generated_at: new Date().toISOString(), data: await safeguardingReport(trust) });
});
