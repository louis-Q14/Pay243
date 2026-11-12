import dnsCb from 'node:dns';
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
    // Même adresse IPv4 écrite en hexadécimal (::ffff:7f00:1 = 127.0.0.1) : forme produite par l'analyse des URL.
    const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16); const lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // Seules les adresses unicast globales (2000::/3) sont publiques ; on écarte aussi les préfixes qui
    // encapsulent une adresse IPv4 (6to4, Teredo) et la plage de documentation.
    if (!/^[23][0-9a-f]{3}:/.test(a)) return true; // ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96…
    return a.startsWith('2002:') || a.startsWith('2001:db8:') || /^2001:(0{1,4})?:/.test(a);
  }
  return true; // format inconnu : refus par défaut
}

/** Faut-il filtrer ? En sandbox, les webhooks vers localhost restent permis (boutique de démo). */
export const ssrfGuardEnabled = () => config.exposed || process.env.WEBHOOK_BLOCK_PRIVATE === '1';

/**
 * Résolution DNS contrôlée, à passer en option `lookup` d'une connexion sortante : l'adresse est vérifiée
 * au moment même de la connexion. Sans cela, un nom de domaine pourrait répondre par une adresse publique
 * lors du contrôle puis par une adresse interne lors de l'envoi (« DNS rebinding »).
 */
export function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dnsCb.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }];
    if (!list.length || list.some((x) => isPrivateAddress(x.address))) {
      return cb(Object.assign(new Error('destination interne refusée'), { code: 'EFORBIDDEN' }));
    }
    if (options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

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
