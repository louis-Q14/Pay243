// Boutique de démonstration intégrant Pay243 (côté marchand).
// Lancement :
//   PAY243_SECRET_KEY=sk_test_... PAY243_WEBHOOK_SECRET=whsec_... npm run demo:boutique
// puis ouvrez http://localhost:4000 . Déclarez http://localhost:4000/webhooks/pay243 comme URL de webhook.
import express from 'express';
import Pay243 from '../../sdk/node/pay243.js';

const PORT = 4000;
const API = process.env.PAY243_URL || 'http://localhost:3000';
const pay243 = new Pay243(process.env.PAY243_SECRET_KEY, { baseUrl: API });
const WHSEC = process.env.PAY243_WEBHOOK_SECRET;

const PRODUCTS = {
  pagne: { name: 'Pagne wax 6 yards', amount: 3500, currency: 'USD' },
  cafe: { name: 'Café du Kivu 500 g', amount: 2500000, currency: 'CDF' },
};
const orders = new Map(); // commande -> statut (en production : votre base de données)

const app = express();

app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Kin Market (démo)</title>
  <body style="font-family:system-ui;max-width:640px;margin:40px auto">
  <h1>Kin Market — boutique de démo</h1>
  ${Object.entries(PRODUCTS).map(([id, p]) => `<div style="border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0">
    <b>${p.name}</b> — ${(p.amount / 100).toLocaleString('fr-FR')} ${p.currency === 'USD' ? '$' : 'FC'}
    <div id="btn-${id}" style="margin-top:10px"></div></div>`).join('')}
  <script src="${API}/sdk/pay243.js"></script>
  <script>
    ${Object.keys(PRODUCTS).map((id) => `Pay243.button('#btn-${id}', { createPayment: () => fetch('/commander/${id}', { method: 'POST' }).then(r => r.json()) });`).join('\n')}
  </script></body>`);
});

// 1) Le serveur du marchand crée le paiement avec sa clé secrète.
app.post('/commander/:product', async (req, res) => {
  const p = PRODUCTS[req.params.product];
  if (!p) return res.status(404).json({ error: 'Produit inconnu' });
  const orderId = `CMD-${Date.now()}`;
  const payment = await pay243.payments.create({
    amount: p.amount, currency: p.currency, description: p.name, reference: orderId,
    return_url: `http://localhost:${PORT}/merci`, cancel_url: `http://localhost:${PORT}/`,
    metadata: { order_id: orderId },
  }, { idempotencyKey: orderId });
  orders.set(orderId, 'en attente');
  res.json({ id: payment.id, checkout_url: payment.checkout_url });
});

// 2) Page de retour : on revérifie côté serveur (ne jamais faire confiance à l'URL seule).
app.get('/merci', async (req, res) => {
  const payment = await pay243.payments.retrieve(String(req.query.payment_id));
  res.send(`<meta charset="utf-8"><body style="font-family:system-ui;max-width:640px;margin:40px auto">
    <h1>${payment.status === 'succeeded' ? 'Merci pour votre achat ✅' : 'Paiement non finalisé'}</h1>
    <p>Commande ${payment.reference} — statut : <b>${payment.status}</b></p><a href="/">Retour</a></body>`);
});

// 3) Webhook : source de vérité pour livrer la commande.
app.post('/webhooks/pay243', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = Pay243.webhooks.constructEvent(req.body, req.get('Pay243-Signature'), WHSEC);
  } catch (e) {
    return res.status(400).send(e.message);
  }
  if (event.type === 'payment.succeeded') {
    orders.set(event.data.reference, 'payée');
    console.log(`✅ Commande ${event.data.reference} payée (${event.data.method}) — net ${event.data.net} ${event.data.currency}`);
  } else {
    console.log(`ℹ️  ${event.type}`, event.data.id);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Boutique démo : http://localhost:${PORT}`));
