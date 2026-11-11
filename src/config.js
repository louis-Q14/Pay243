// Configuration centrale de Pay243. Toutes les valeurs sont surchargeables via variables d'environnement.
import crypto from 'node:crypto';
import path from 'node:path';

const env = process.env;
const port = Number(env.PORT || 3000);
// PostgreSQL : DATABASE_URL (production). Sans elle, PGlite embarqué dans PGLITE_DIR (développement).
const databaseUrl = env.DATABASE_URL || null;
const pgliteDir = env.PGLITE_DIR || './data/pglite';
const DEV_KYC_KEY = crypto.createHash('sha256').update('kongowallet-dev-kyc-key') /* ancien nom conservé : clé des fichiers déjà chiffrés */.digest('hex');

/** ADMIN_KEYS="nom:clé,nom2:clé2" — chaque agent du back-office a sa propre clé (traçabilité). */
function parseAdminKeys(raw) {
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const i = entry.indexOf(':');
    return { name: entry.slice(0, i).trim(), key: entry.slice(i + 1).trim() };
  }).filter((a) => a.name && a.key.length >= 24);
}

export const config = {
  port,
  baseUrl: env.BASE_URL || `http://localhost:${port}`,
  mode: env.PAY243_MODE || env.KONGO_MODE || 'sandbox', // 'sandbox' | 'live' (KONGO_MODE : ancien nom, encore accepté)
  db: { url: databaseUrl, pgliteDir },
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  callbackSecret: env.CALLBACK_SECRET || 'dev-callback-secret',
  mockDelayMs: Number(env.MOCK_DELAY_MS ?? 3000),

  // La RDC fonctionne en double devise : franc congolais et dollar américain.
  currencies: ['CDF', 'USD'],

  fx: {
    usdToCdf: Number(env.FX_USD_CDF || 2850), // valeur indicative — à synchroniser avec le taux BCC
    spreadPercent: Number(env.FX_SPREAD_PERCENT || 1),
  },

  fees: {
    merchantPercent: Number(env.FEE_MERCHANT_PERCENT || 2.5), // commission sur les paiements marchands
    withdrawalPercent: Number(env.FEE_WITHDRAWAL_PERCENT || 1), // retrait wallet -> Mobile Money
    transferPercent: 0, // transferts entre wallets Pay243 gratuits
  },

  // Plafonds par niveau KYC, exprimés en USD (contre-valeur pour le CDF).
  // Valeurs d'exemple : à aligner sur les exigences BCC applicables aux EME et sur votre politique LCB/FT.
  kyc: {
    1: { label: 'Basique (téléphone vérifié)', perTxnUsd: 100, dailyUsd: 300, maxBalanceUsd: 500 },
    2: { label: "Vérifié (pièce d'identité)", perTxnUsd: 1000, dailyUsd: 2000, maxBalanceUsd: 5000 },
    3: { label: 'Entreprise / Premium', perTxnUsd: 5000, dailyUsd: 10000, maxBalanceUsd: 50000 },
  },

  paymentExpiryMinutes: 60,

  providers: {
    mpesa: {
      label: 'M-Pesa (Vodacom)',
      driver: env.MPESA_DRIVER || 'mock',
      env: env.MPESA_ENV || 'sandbox',
      host: env.MPESA_HOST || 'openapi.m-pesa.com',
      apiKey: env.MPESA_API_KEY,
      publicKey: env.MPESA_PUBLIC_KEY,
      serviceProviderCode: env.MPESA_SERVICE_PROVIDER_CODE,
    },
    airtel: {
      label: 'Airtel Money',
      driver: env.AIRTEL_DRIVER || 'mock',
      baseUrl: env.AIRTEL_BASE_URL || 'https://openapiuat.airtel.africa',
      clientId: env.AIRTEL_CLIENT_ID,
      clientSecret: env.AIRTEL_CLIENT_SECRET,
      encryptedPin: env.AIRTEL_DISBURSEMENT_PIN,
    },
    orange: {
      label: 'Orange Money',
      driver: env.ORANGE_DRIVER || 'mock',
    },
  },

  aggregator: {
    baseUrl: env.AGGREGATOR_BASE_URL || 'https://api.sandbox.pawapay.io',
    apiToken: env.AGGREGATOR_API_TOKEN,
  },

  cards: { driver: env.CARDS_DRIVER || 'mock' },

  // Vérification du numéro par code SMS (inscription et connexion depuis un nouvel appareil).
  otp: {
    ttlSeconds: 300, // validité d'un code
    maxAttempts: 5, // essais par code
    resendSeconds: 60, // délai minimal entre deux envois au même numéro
    maxPerHour: 5, // envois max par numéro et par heure (anti « SMS bombing » et coût)
  },

  // Vérification d'identité (KYC niveau 2) : pièces chiffrées au repos, revue manuelle au back-office.
  kycReview: {
    // ⚠ Avec plusieurs instances, ce dossier doit être partagé (volume réseau) ou remplacé par un stockage objet.
    storageDir: env.KYC_STORAGE_DIR || path.resolve('./data/kyc'),
    encryptionKey: env.KYC_ENCRYPTION_KEY || DEV_KYC_KEY, // 32 octets en hexadécimal (openssl rand -hex 32)
    devKey: DEV_KYC_KEY,
    maxUploadBytes: 5 * 1024 * 1024,
    minAge: 18,
  },

  // Rapprochement et suivi des transactions Mobile Money en attente.
  recon: {
    sweepIntervalMs: Number(env.RECON_SWEEP_INTERVAL_MS || 5 * 60_000), // fréquence du contrôle des « pending »
    checkAfterSeconds: 120, // délai avant la première interrogation de statut
    collectionExpireMinutes: Number(env.RECON_COLLECTION_EXPIRE_MINUTES || 30), // encaissement sans réponse -> échec + alerte
    payoutAlertMinutes: Number(env.RECON_PAYOUT_ALERT_MINUTES || 60), // décaissement bloqué -> alerte (jamais d'échec automatique)
    tzOffsetMinutes: Number(env.RECON_TZ_OFFSET_MINUTES ?? 60), // journée comptable : heure de Kinshasa (UTC+1)
  },

  // Agents du back-office. En sandbox, sans ADMIN_KEYS, une clé aléatoire est générée et affichée au démarrage.
  admin: {
    keys: parseAdminKeys(env.ADMIN_KEYS) || [{ name: 'sandbox', key: `adm_${crypto.randomBytes(18).toString('base64url')}`, generated: true }],
  },

  // Emails transactionnels (codes de vérification à l'inscription et sur un nouvel appareil).
  email: {
    driver: env.EMAIL_DRIVER || 'mock', // mock | resend
    from: env.EMAIL_FROM || 'Pay243 <no-reply@pay243.com>',
    replyTo: env.EMAIL_REPLY_TO || null, // ex. support@pay243.com
    resend: { apiKey: env.RESEND_API_KEY },
  },

  // Requêtes par minute et par adresse IP sur la connexion et l'inscription.
  rateLimits: { auth: Number(env.RATE_LIMIT_AUTH || 20), otp: Number(env.RATE_LIMIT_OTP || 10) },

  sms: {
    driver: env.SMS_DRIVER || 'mock', // mock | africastalking
    africastalking: {
      username: env.AT_USERNAME || 'sandbox',
      apiKey: env.AT_API_KEY,
      senderId: env.AT_SENDER_ID, // expéditeur alphanumérique (ex. PAY243), à faire valider
    },
  },
};

/** Contre-valeur en cents USD d'un montant en unités mineures. */
export function toUsdMinor(amount, currency) {
  return currency === 'USD' ? amount : Math.round(amount / config.fx.usdToCdf);
}

/** Les codes à usage unique ne sont renvoyés dans l'API que si aucun message réel ne part (démo et tests). */
export function exposesCodes(channel) {
  if (config.mode === 'live') return false;
  return (channel === 'email' ? config.email.driver : config.sms.driver) === 'mock';
}

export function assertProductionConfig() {
  // Valable dans tous les modes : un fournisseur réel sans identifiants ferait échouer chaque inscription.
  if (config.email.driver === 'resend' && !config.email.resend.apiKey) throw new Error('EMAIL_DRIVER=resend exige RESEND_API_KEY.');
  if (config.email.driver !== 'mock' && !/<[^@\s]+@[^>\s]+>$|^[^@\s]+@[^@\s]+$/.test(config.email.from)) throw new Error('EMAIL_FROM invalide (ex. "Pay243 <no-reply@pay243.com>").');
  if (config.sms.driver === 'africastalking' && !config.sms.africastalking.apiKey) throw new Error('SMS_DRIVER=africastalking exige AT_API_KEY.');
  if (config.mode !== 'live') return;
  const weak = ['dev-only-secret-change-me', 'change-me', ''];
  if (weak.includes(config.jwtSecret) || weak.includes(config.callbackSecret)) {
    throw new Error('JWT_SECRET et CALLBACK_SECRET doivent être définis en mode live.');
  }
  for (const [op, p] of Object.entries(config.providers)) {
    if (p.driver === 'mock') throw new Error(`Le pilote "mock" est interdit en mode live (${op}).`);
  }
  if (config.cards.driver === 'mock') throw new Error('Le pilote cartes "mock" est interdit en mode live.');
  if (config.sms.driver === 'mock') throw new Error('Le pilote SMS "mock" est interdit en mode live.');
  if (config.email.driver === 'mock') throw new Error('Le pilote email "mock" est interdit en mode live.');
  if (!config.db.url) throw new Error('DATABASE_URL (serveur PostgreSQL) est obligatoire en mode live : PGlite est réservé au développement.');
  if (!/^[0-9a-f]{64}$/i.test(config.kycReview.encryptionKey) || config.kycReview.encryptionKey === config.kycReview.devKey) {
    throw new Error('KYC_ENCRYPTION_KEY (64 caractères hexadécimaux) doit être défini en mode live.');
  }
  if (config.admin.keys.some((a) => a.generated)) throw new Error('ADMIN_KEYS doit être défini en mode live (format nom:clé, clé de 24 caractères min.).');
}
