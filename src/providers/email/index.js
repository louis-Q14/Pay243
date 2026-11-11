import crypto from 'node:crypto';
import { config } from '../../config.js';

/**
 * Contrat d'un fournisseur d'emails transactionnels :
 *   send({ to, subject, text, html, tag? }) -> Promise<{ providerRef? }>   (lève une erreur si l'envoi échoue)
 */

/** Derniers emails « envoyés » par le pilote mock (tests et démo). */
export const outbox = [];

/** Sandbox : aucun email réel, le message est affiché dans la console du serveur. */
function mockEmail() {
  return {
    name: 'mock',
    async send({ to, subject, text, html, tag }) {
      outbox.push({ to, subject, text, html, tag, at: new Date().toISOString() });
      if (outbox.length > 100) outbox.shift();
      if (!process.env.NODE_TEST_CONTEXT) console.log(`[email:mock] → ${to} | ${subject}\n${text}`);
      return { providerRef: `mock_${Date.now()}` };
    },
  };
}

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Le domaine d'envoi (EMAIL_FROM) doit être vérifié chez Resend (enregistrements DNS SPF + DKIM).
 * Un nouvel essai est fait sur 429 / 5xx avec la même clé d'idempotence : jamais de doublon.
 */
function resend() {
  const c = config.email.resend;
  return {
    name: 'resend',
    async send({ to, subject, text, html, tag }) {
      if (!c.apiKey) throw new Error('RESEND_API_KEY manquant');
      const idem = crypto.randomUUID();
      const body = JSON.stringify({
        from: config.email.from,
        to: [to],
        subject,
        text,
        html,
        ...(config.email.replyTo ? { reply_to: config.email.replyTo } : {}),
        ...(tag ? { tags: [{ name: 'category', value: tag }] } : {}),
      });
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idem },
          body,
          signal: AbortSignal.timeout(10_000),
        }).catch((e) => ({ ok: false, status: 0, json: async () => ({ message: e.message }) }));
        const j = await r.json().catch(() => ({}));
        if (r.ok) return { providerRef: j.id };
        last = new Error(j?.message || `HTTP ${r.status}`);
        if (r.status && r.status !== 429 && r.status < 500) break; // erreur définitive (adresse invalide, domaine non vérifié…)
        await new Promise((res) => setTimeout(res, 600 * 2 ** attempt));
      }
      throw last;
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

// =====================================================================
//  Gabarits : HTML sobre lisible dans tous les clients mail (tableaux, styles en ligne)
// =====================================================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const LOGO = '<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial Black,Arial,Helvetica,sans-serif;font-weight:900;font-size:22px;line-height:1"><tr>'
  + '<td style="background:#0a0a0a;color:#fff;padding:6px 9px;border:2px solid #0a0a0a">P</td>'
  + '<td style="background:#fff;color:#0a0a0a;padding:6px 9px;border:2px solid #0a0a0a;letter-spacing:-.02em">243</td></tr></table>';

/**
 * Mise en page commune à tous les emails.
 * paragraphs : textes (échappés) ; code : code à 6 chiffres mis en avant ; cta : { label, url } ; footer : petite note.
 */
export function layoutHtml({ preheader = '', title, paragraphs = [], code, cta, details = [], footer }) {
  const base = config.baseUrl.replace(/\/$/, '');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f6fa;font-family:Segoe UI,Arial,sans-serif;color:#0b1424">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td>${LOGO}</td></tr>
<tr><td style="padding-top:24px;font-size:22px;font-weight:800;line-height:1.25">${esc(title)}</td></tr>
${paragraphs.map((p) => `<tr><td style="padding-top:12px;font-size:15px;line-height:1.6;color:#2a3547">${esc(p)}</td></tr>`).join('')}
${details.length ? `<tr><td style="padding-top:16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;border-radius:12px;padding:6px 16px">${details.map(([k, v]) => `<tr><td style="padding:8px 0;font-size:13px;color:#5d6879">${esc(k)}</td><td style="padding:8px 0;font-size:14px;font-weight:600;text-align:right">${esc(v)}</td></tr>`).join('')}</table></td></tr>` : ''}
${code ? `<tr><td style="padding:24px 0 8px"><div style="font-size:34px;font-weight:800;letter-spacing:10px;background:#f4f6fa;border-radius:12px;padding:16px;text-align:center">${esc(code)}</div></td></tr>` : ''}
${cta ? `<tr><td style="padding-top:24px"><a href="${esc(cta.url)}" style="display:inline-block;background:#0b1424;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:999px">${esc(cta.label)}</a></td></tr>` : ''}
${footer ? `<tr><td style="padding-top:24px;font-size:13px;line-height:1.5;color:#5d6879">${esc(footer)}</td></tr>` : ''}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px"><tr><td style="padding:18px 8px;font-size:12px;line-height:1.5;color:#8792a2;text-align:center">
Pay243 · Kinshasa, République démocratique du Congo<br>Message automatique, merci de ne pas y répondre. Gérez vos notifications dans <a href="${esc(base)}/settings#notifications" style="color:#5d6879">vos paramètres</a>.
</td></tr></table>
</td></tr></table></body></html>`;
}

/** Version texte (repli des clients sans HTML, et meilleure délivrabilité). */
export function layoutText({ title, paragraphs = [], code, cta, details = [], footer }) {
  return [
    title, '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(details.length ? [...details.map(([k, v]) => `${k} : ${v}`), ''] : []),
    ...(code ? [`Code : ${code}`, ''] : []),
    ...(cta ? [`${cta.label} : ${cta.url}`, ''] : []),
    ...(footer ? [footer, ''] : []),
    '— Pay243',
  ].join('\n');
}

/** Compatibilité : email contenant un code de vérification. */
export function codeEmailHtml({ title, intro, code, footer }) {
  return layoutHtml({ preheader: `Votre code : ${code}`, title, paragraphs: [intro], code, footer });
}
