// SDK serveur Node.js pour l'API Pay243 (aucune dépendance, Node 18+).
//
//   import Pay243 from './pay243.js';
//   const pay243 = new Pay243(process.env.PAY243_SECRET_KEY, { baseUrl: 'https://api.pay243.cd' });
//   const payment = await pay243.payments.create({ amount: 2500, currency: 'USD', description: 'Commande #42', return_url: 'https://monsite.cd/merci' });
//   res.redirect(payment.checkout_url);
import crypto from 'node:crypto';

export class Pay243Error extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
  }
}

export default class Pay243 {
  constructor(secretKey, { baseUrl = 'http://localhost:3000', timeoutMs = 30_000 } = {}) {
    if (!/^sk_(test|live)_/.test(secretKey || '')) throw new Error('Clé secrète Pay243 invalide (sk_test_... ou sk_live_...).');
    this.key = secretKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;

    this.payments = {
      create: (params, opts) => this.#req('POST', '/v1/payments', params, opts),
      retrieve: (id) => this.#req('GET', `/v1/payments/${encodeURIComponent(id)}`),
      list: (query = {}) => this.#req('GET', `/v1/payments?${new URLSearchParams(query)}`),
      cancel: (id) => this.#req('POST', `/v1/payments/${encodeURIComponent(id)}/cancel`),
      refund: (id, params = {}, opts) => this.#req('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, params, opts),
    };
    this.balance = { retrieve: () => this.#req('GET', '/v1/balance') };
    this.payouts = { create: (params, opts) => this.#req('POST', '/v1/payouts', params, opts) };
    this.events = { list: (query = {}) => this.#req('GET', `/v1/events?${new URLSearchParams(query)}`) };
  }

  async #req(method, path, body, { idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' };
    // Clé d'idempotence automatique sur les POST : un réessai après coupure réseau ne débite pas deux fois.
    if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(this.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
        const j = await r.json().catch(() => ({}));
        if (r.status >= 500 && attempt < 2) { lastErr = new Pay243Error(r.status, j); await sleep(500 * 2 ** attempt); continue; }
        if (!r.ok) throw new Pay243Error(r.status, j);
        return j;
      } catch (e) {
        if (e instanceof Pay243Error) throw e;
        lastErr = e;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  /**
   * Vérifie et décode un webhook. À appeler avec le corps BRUT (Buffer/string), pas le JSON reparsé.
   *   app.post('/webhooks/pay243', express.raw({ type: 'application/json' }), (req, res) => {
   *     const event = Pay243.webhooks.constructEvent(req.body, req.get('Pay243-Signature'), WHSEC);
   *   });
   */
  static webhooks = {
    constructEvent(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
      const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
      const parts = Object.fromEntries(String(signatureHeader || '').split(',').map((kv) => kv.split('=')));
      if (!parts.t || !parts.v1) throw new Error('En-tête Pay243-Signature manquant ou mal formé.');
      if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSeconds) throw new Error('Webhook trop ancien (rejeu possible).');
      const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');
      const a = Buffer.from(expected); const b = Buffer.from(parts.v1);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Signature de webhook invalide.');
      return JSON.parse(body);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
