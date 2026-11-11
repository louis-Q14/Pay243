import { assertProductionConfig, config } from './config.js';
import { closeDb, openDb } from './db.js';
import { createApp } from './app.js';
import { purgeTechnicalTables } from './middleware.js';
import { loadPlatformSettings } from './services/platformSettings.js';
import { startReconWorker } from './services/reconciliation.js';
import { startWebhookWorker } from './services/webhooks.js';

assertProductionConfig();
const engine = await openDb(config.db.url ? { url: config.db.url } : { dataDir: config.db.pgliteDir });
await loadPlatformSettings();
setInterval(() => loadPlatformSettings().catch((e) => console.error('[settings]', e.message)), 30_000).unref();
startWebhookWorker();
startReconWorker();
setInterval(() => purgeTechnicalTables().catch((e) => console.error('[maintenance]', e.message)), 10 * 60_000).unref();

const server = createApp().listen(config.port, () => {
  console.log(`Pay243 (${config.mode}) en écoute sur ${config.baseUrl}`);
  console.log(`  Base     : ${engine === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `PGlite embarqué (${config.db.pgliteDir})`}`);
  console.log(`  Wallet   : ${config.baseUrl}/`);
  console.log(`  Docs API : ${config.baseUrl}/docs`);
  const drivers = Object.entries(config.providers).map(([k, v]) => `${k}=${v.driver}`).join(', ');
  console.log(`  Opérateurs : ${drivers} | cartes=${config.cards.driver} | sms=${config.sms.driver}`);
  console.log(`  Back-office : ${config.baseUrl}/admin`);
  const generated = config.admin.keys.find((a) => a.generated);
  if (generated) console.log(`  Clé back-office (sandbox, régénérée à chaque démarrage) : ${generated.key}`);
});

// Arrêt propre : on termine les requêtes en cours avant de fermer la base.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.log(`\n${sig} reçu : arrêt en cours…`);
    server.close(async () => { await closeDb().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
