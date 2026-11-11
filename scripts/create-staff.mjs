// Crée un membre de l'équipe (par défaut : super administrateur) et affiche son mot de passe provisoire.
// Usage : npm run admin:create -- --email vous@exemple.com --name "Prénom Nom" [--role super_admin]
// Sur Easypanel : console du service web, puis la même commande.
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db.js';
import { ROLES, createStaff } from '../src/staff.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
if (!args.email || !args.name) {
  console.error('Usage : npm run admin:create -- --email vous@exemple.com --name "Prénom Nom" [--role super_admin]');
  console.error(`Rôles : ${Object.keys(ROLES).join(', ')}`);
  process.exit(1);
}
await openDb(config.db.url ? { url: config.db.url } : { dataDir: config.db.pgliteDir });
try {
  const { staff, password } = await createStaff({ email: args.email, full_name: args.name, role: args.role || 'super_admin', created_by: 'console' });
  console.log(`\nCompte créé : ${staff.full_name} <${staff.email}> — ${ROLES[staff.role].label}`);
  console.log(`Mot de passe provisoire : ${password}`);
  console.log(`Connexion : ${config.baseUrl}/admin (un code est envoyé par email à chaque connexion ; le mot de passe est à changer à la première).\n`);
} catch (e) {
  console.error(`Échec : ${e.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
