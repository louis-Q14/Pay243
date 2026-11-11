/*!
 * Pay243.js — SDK navigateur
 * Usage :
 *   <script src="https://pay243.com/sdk/pay243.js"></script>
 *   <div id="pay"></div>
 *   <script>
 *     Pay243.button('#pay', {
 *       // Votre serveur crée le paiement avec sa clé secrète et renvoie { id } ou { checkout_url }
 *       createPayment: () => fetch('/api/commande', { method: 'POST' }).then(r => r.json()),
 *       label: 'Payer avec Pay243',
 *     });
 *   </script>
 * La clé secrète sk_... ne doit JAMAIS être utilisée dans le navigateur.
 */
(function (global) {
  const script = document.currentScript;
  const BASE = (script && new URL(script.src).origin) || location.origin;

  function checkoutUrl(p) {
    if (typeof p === 'string') return p.startsWith('http') ? p : `${BASE}/checkout/${p}`;
    return p.checkout_url || `${BASE}/checkout/${p.id}`;
  }

  function redirectToCheckout(payment) {
    location.href = checkoutUrl(payment);
  }

  /** Lit le statut public d'un paiement (utile sur la page de retour). */
  async function getStatus(paymentId) {
    const r = await fetch(`${BASE}/v1/checkout/${encodeURIComponent(paymentId)}`);
    if (!r.ok) throw new Error('Paiement introuvable');
    const j = await r.json();
    return { id: j.id, status: j.status, amount: j.amount, currency: j.currency };
  }

  function button(target, { createPayment, label = 'Payer avec Pay243', onError } = {}) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `<span style="display:inline-block;width:16px;height:16px;border-radius:5px;margin-right:8px;vertical-align:-3px;background:linear-gradient(135deg,#0070e0 0 60%,#f7d618 60% 70%,#ce1021 70% 78%,#0070e0 78%)"></span>${label}`;
    btn.style.cssText = 'font:600 15px system-ui,sans-serif;background:#0b3d91;color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer';
    btn.onclick = async () => {
      btn.disabled = true;
      try { redirectToCheckout(await createPayment()); } catch (e) { btn.disabled = false; (onError || alert)(e.message || e); }
    };
    el.appendChild(btn);
    return btn;
  }

  global.Pay243 = { redirectToCheckout, getStatus, button, checkoutUrl };
})(window);
