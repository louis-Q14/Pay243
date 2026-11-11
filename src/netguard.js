import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { HttpError } from './util.js';

/**
 * Protection SSRF pour les appels sortants vers des URL fournies par les marchands (webhooks).
 * En production, interdit les destinations internes : loopback, réseaux privés, link-local
 * (dont 169.254.169.254, métadonnées cloud), CGNAT, multicast, etc.
 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return a === '::' || a === '::1'
      || /^f[cd]/.test(a) // fc00::/7 (ULA)
      || /^fe[89ab]/.test(a) // fe80::/10 (link-local)
      || a.startsWith('ff'); // multicast
  }
  return true; // format inconnu : refus par défaut
}

/** Faut-il filtrer ? En sandbox, les webhooks vers localhost restent permis (boutique de démo). */
export const ssrfGuardEnabled = () => config.mode === 'live' || process.env.WEBHOOK_BLOCK_PRIVATE === '1';

/** Vérifie qu'une URL ne vise que des adresses publiques (résolution DNS comprise). */
export async function assertPublicUrl(rawUrl) {
  if (!ssrfGuardEnabled()) return;
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new HttpError(400, 'forbidden_destination', 'webhook_url doit pointer vers une adresse publique.');
  }
}
