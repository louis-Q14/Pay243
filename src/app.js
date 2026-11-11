import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { auditLedger } from './ledger.js';
import { securityHeaders } from './middleware.js';
import { providerEvents } from './providers/mobileMoney/index.js';
import { authRouter } from './routes/auth.js';
import { callbackRouter, checkoutRouter, sandboxRouter } from './routes/checkout.js';
import { adminRouter, kycRouter } from './routes/kyc.js';
import { reconRouter } from './routes/reconciliation.js';
import { settingsRouter } from './routes/settings.js';
import { merchantAdminRouter, merchantApiRouter } from './routes/merchants.js';
import { walletRouter } from './routes/wallet.js';
import { handleProviderResult } from './services/mobileMoney.js';
import { HttpError } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

let wired = false;
export function createApp() {
  if (!wired) {
    providerEvents.on('result', (r) => {
      handleProviderResult(r).catch((e) => console.error('[provider-result]', e));
    });
    wired = true;
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    await q.get('SELECT 1');
    res.json({ status: 'ok', mode: config.mode, ledger: await auditLedger() });
  });

  app.use('/v1', authRouter, settingsRouter, walletRouter, kycRouter, adminRouter, reconRouter, merchantAdminRouter, merchantApiRouter, checkoutRouter);
  app.use(callbackRouter, sandboxRouter);

  app.get('/checkout/:id', (_req, res) => res.sendFile(path.join(publicDir, 'checkout.html')));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use('/v1', (_req, _res) => { throw new HttpError(404, 'not_found', 'Endpoint inconnu.'); });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Fichier ou requête trop volumineux (5 Mo max. pour une image).' } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Corps JSON invalide.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Erreur interne. Réessayez plus tard.' } });
  });

  return app;
}
