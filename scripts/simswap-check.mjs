// Vérifie les identifiants Orange Network APIs en interrogeant SIM Swap (Playground par défaut).
// Usage : ORANGE_NETAPI_CLIENT_ID=… ORANGE_NETAPI_CLIENT_SECRET=… npm run simswap:check -- [+990100000000] [heures]
// Le Playground ne connaît que des numéros fictifs (+990…) : voir la page « test phone numbers » d'Orange.
import { config } from '../src/config.js';
import { orangeSimSwap } from '../src/providers/simSwap/index.js';

const phone = process.argv[2] || '+990100000000';
const hours = Number(process.argv[3] || config.simSwap.maxAgeHours);
const c = config.simSwap.orange;
if (!c.clientId || !c.clientSecret) {
  console.error('Définissez ORANGE_NETAPI_CLIENT_ID et ORANGE_NETAPI_CLIENT_SECRET (application créée sur https://developer.orange.com/myapps).');
  process.exit(1);
}
console.log(`Orange SIM Swap — ${c.baseUrl}\nNuméro ${phone}, fenêtre ${hours} h…`);
try {
  const r = await orangeSimSwap(c).check({ phone, maxAgeHours: hours });
  if (r.unsupported) console.log('→ Numéro non couvert par ce service (NOT_SUPPORTED).');
  else console.log(r.swapped ? `→ SIM CHANGÉE dans les ${hours} dernières heures : Pay243 bloquerait les sorties d'argent.` : '→ Pas de changement de SIM récent.');
} catch (e) {
  console.error(`Échec : ${e.message}`);
  process.exit(1);
}
