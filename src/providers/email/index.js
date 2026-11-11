import { config } from '../../config.js';

/**
 * Contrat d'un fournisseur d'emails transactionnels :
 *   send({ to, subject, text, html }) -> Promise<{ providerRef? }>   (lève une erreur si l'envoi échoue)
 */

/** Sandbox : aucun email réel, le message est affiché dans la console du serveur. */
function mockEmail() {
  return {
    name: 'mock',
    async send({ to, subject, text }) {
      if (!process.env.NODE_TEST_CONTEXT) console.log(`[email:mock] → ${to} | ${subject}\n${text}`);
      return { providerRef: `mock_${Date.now()}` };
    },
  };
}

/**
 * Resend (API HTTP simple, domaine d'envoi à vérifier par DNS : SPF, DKIM).
 * Doc : https://resend.com/docs/api-reference/emails/send-email
 * Pour Brevo, Mailjet, SendGrid… seul ce pilote est à adapter.
 */
function resend() {
  const c = config.email.resend;
  return {
    name: 'resend',
    async send({ to, subject, text, html }) {
      if (!c.apiKey) throw new Error('RESEND_API_KEY manquant');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.email.from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || `HTTP ${r.status}`);
      return { providerRef: j.id };
    },
  };
}

const DRIVERS = { mock: mockEmail, resend };

let instance;
export function emailProvider() {
  if (!instance) {
    const factory = DRIVERS[config.email.driver];
    if (!factory) throw new Error(`Pilote email inconnu : ${config.email.driver}`);
    instance = factory();
  }
  return instance;
}

/** Gabarit HTML sobre, lisible dans tous les clients mail (tableaux, styles en ligne). */
export function codeEmailHtml({ title, intro, code, footer }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f6fa;font-family:Segoe UI,Arial,sans-serif;color:#0b1424">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial Black,Arial,Helvetica,sans-serif;font-weight:900;font-size:22px;line-height:1"><tr><td style="background:#0a0a0a;color:#fff;padding:6px 9px;border:2px solid #0a0a0a">P</td><td style="background:#fff;color:#0a0a0a;padding:6px 9px;border:2px solid #0a0a0a;letter-spacing:-.02em">243</td></tr></table></td></tr>
<tr><td style="padding-top:24px;font-size:22px;font-weight:800">${esc(title)}</td></tr>
<tr><td style="padding-top:10px;font-size:15px;line-height:1.55;color:#2a3547">${esc(intro)}</td></tr>
<tr><td style="padding:26px 0"><div style="font-size:34px;font-weight:800;letter-spacing:10px;background:#f4f6fa;border-radius:12px;padding:16px;text-align:center">${esc(code)}</div></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#5d6879">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}
