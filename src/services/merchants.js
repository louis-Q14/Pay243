import crypto from 'node:crypto';
import { generateApiKey } from '../auth.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { HttpError, newId, now } from '../util.js';

/** Émet une nouvelle clé API (seul son hash est conservé) et renvoie la clé en clair, à afficher une fois. */
export async function issueKey(merchantId, mode) {
  if (mode === 'live' && config.mode !== 'live') throw new HttpError(400, 'live_disabled', "Les clés live ne sont disponibles qu'en production, après validation KYB.");
  const k = generateApiKey(mode);
  await q.run('INSERT INTO api_keys (id, merchant_id, mode, prefix, key_hash, last4, created_at) VALUES (?,?,?,?,?,?,?)',
    newId('key'), merchantId, mode, k.prefix, k.hash, k.last4, now());
  return k.key;
}

/**
 * Crée le compte marchand d'un utilisateur et sa première clé API. À appeler dans tx() :
 * l'unicité (un marchand par utilisateur) est garantie par la base.
 */
export async function createMerchantAccount(userId, name, webhookUrl = null) {
  const id = newId('mch');
  await q.run('INSERT INTO merchants (id, owner_user_id, name, webhook_url, webhook_secret, created_at) VALUES (?,?,?,?,?,?)',
    id, userId, String(name).trim(), webhookUrl, `whsec_${crypto.randomBytes(24).toString('base64url')}`, now());
  const secretKey = await issueKey(id, config.mode === 'live' ? 'live' : 'test');
  return { id, secretKey };
}
