/**
 * Migrations PostgreSQL, appliquées dans l'ordre au démarrage (table schema_migrations).
 * Ne modifiez jamais une migration déjà déployée : ajoutez-en une nouvelle.
 *
 * Conventions : montants en BIGINT (unités mineures), horodatages en TEXT ISO 8601 UTC
 * (comparables lexicographiquement), identifiants préfixés générés par l'application.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'schema initial',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  kyc_level INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

-- Un wallet par (propriétaire, devise). owner_type : user | merchant | system
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, currency),
  -- Filet de sécurité : seuls les comptes techniques peuvent être négatifs.
  CHECK (owner_type = 'system' OR balance >= 0)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  amount BIGINT NOT NULL,
  fee BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  from_wallet TEXT,
  to_wallet TEXT,
  merchant_id TEXT,
  payment_id TEXT,
  method TEXT,
  operator TEXT,
  phone TEXT,
  provider TEXT,
  provider_ref TEXT,
  failure_reason TEXT,
  description TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_txn_from ON transactions (from_wallet, created_at);
CREATE INDEX idx_txn_to ON transactions (to_wallet, created_at);
CREATE INDEX idx_txn_provider_ref ON transactions (provider_ref);
CREATE INDEX idx_txn_payment ON transactions (payment_id);
CREATE INDEX idx_txn_pending ON transactions (status, created_at) WHERE status = 'pending';
CREATE INDEX idx_txn_operator_day ON transactions (operator, created_at);

-- Grand livre en partie double : la somme des écritures d'une devise vaut toujours 0.
CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  txn_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ledger_wallet ON ledger_entries (wallet_id);
CREATE INDEX idx_ledger_txn ON ledger_entries (txn_id);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_token TEXT NOT NULL,
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cards_user ON cards (user_id);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  prefix TEXT UNIQUE NOT NULL,
  key_hash TEXT NOT NULL,
  last4 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  description TEXT,
  reference TEXT,
  status TEXT NOT NULL,
  fee BIGINT NOT NULL DEFAULT 0,
  refunded_amount BIGINT NOT NULL DEFAULT 0,
  method TEXT,
  customer_user_id TEXT,
  payer_phone TEXT,
  payer_operator TEXT,
  card_token TEXT,
  txn_id TEXT,
  return_url TEXT,
  cancel_url TEXT,
  metadata TEXT,
  last_error TEXT,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (refunded_amount >= 0 AND refunded_amount <= amount)
);
CREATE INDEX idx_payments_merchant ON payments (merchant_id, created_at);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webhooks_due ON webhook_events (next_attempt_at) WHERE delivered_at IS NULL;
CREATE INDEX idx_webhooks_merchant ON webhook_events (merchant_id, created_at);

-- status_code = 0 : requête en cours de traitement (verrou partagé entre instances)
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_otp_phone ON otp_codes (phone, purpose, created_at);

CREATE TABLE trusted_devices (
  user_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);

CREATE TABLE kyc_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  submission_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_kyc_files_user ON kyc_files (user_id, created_at);
CREATE INDEX idx_kyc_files_sub ON kyc_files (submission_id);
CREATE INDEX idx_kyc_files_sha ON kyc_files (sha256);

CREATE TABLE kyc_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  status TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_number TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  reviewer TEXT,
  review_note TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_kyc_sub_status ON kyc_submissions (status, created_at);
CREATE INDEX idx_kyc_sub_doc ON kyc_submissions (document_type, document_number);
-- Une seule demande en cours par utilisateur, garanti par la base (plusieurs instances).
CREATE UNIQUE INDEX uq_kyc_pending ON kyc_submissions (user_id) WHERE status = 'pending';

CREATE TABLE recon_runs (
  id TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL,
  rows INTEGER NOT NULL,
  matched INTEGER NOT NULL,
  exceptions INTEGER NOT NULL,
  summary TEXT NOT NULL,
  imported_by TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_recon_run_completed ON recon_runs (operator, business_date) WHERE status = 'completed';

CREATE TABLE recon_exceptions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  txn_id TEXT,
  operator TEXT,
  provider_ref TEXT,
  amount BIGINT,
  currency TEXT,
  details TEXT,
  status TEXT NOT NULL,
  resolution TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_recon_exc ON recon_exceptions (status, created_at);
CREATE INDEX idx_recon_exc_run ON recon_exceptions (run_id);
-- Pas deux alertes ouvertes du même type sur la même transaction.
CREATE UNIQUE INDEX uq_recon_exc_open ON recon_exceptions (txn_id, kind) WHERE status = 'open' AND txn_id IS NOT NULL;

CREATE TABLE admin_audit (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

-- Limitation de débit partagée entre instances (fenêtre fixe).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  hits INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Baux des tâches de fond : une seule instance exécute une tâche donnée à la fois.
CREATE TABLE job_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  locked_until TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'inscription par email et type de compte',
    sql: `
-- L'email devient l'identifiant principal ; le téléphone (Mobile Money) devient facultatif.
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD CONSTRAINT users_account_type_check CHECK (account_type IN ('personal', 'business'));
ALTER TABLE users ADD CONSTRAINT users_identifier_check CHECK (email IS NOT NULL OR phone IS NOT NULL);
UPDATE users SET email = lower(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE email IS NOT NULL;

-- Les codes à usage unique partent par SMS ou par email : la colonne désigne la destination.
ALTER TABLE otp_codes RENAME COLUMN phone TO destination;
ALTER TABLE otp_codes ADD COLUMN channel TEXT NOT NULL DEFAULT 'sms';
`,
  },
  {
    version: 3,
    name: 'paramètres du compte',
    sql: `
-- Profil : identifiant public (@pseudo), photo, fuseau horaire, nationalité, préférences.
ALTER TABLE users ADD COLUMN handle TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;               -- image JPEG/PNG/WebP en data URL (256 px, compressée côté navigateur)
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Kinshasa';
ALTER TABLE users ADD COLUMN nationality TEXT NOT NULL DEFAULT 'CD';
ALTER TABLE users ADD COLUMN notification_prefs TEXT;   -- JSON
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;
ALTER TABLE users ADD COLUMN sessions_valid_after BIGINT NOT NULL DEFAULT 0; -- jetons émis avant cet instant (epoch ms) refusés
ALTER TABLE users ADD COLUMN closed_at TEXT;
CREATE UNIQUE INDEX uq_users_handle ON users (handle) WHERE handle IS NOT NULL;

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  province TEXT,
  postal_code TEXT,
  country TEXT NOT NULL DEFAULT 'CD',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_addresses_user ON addresses (user_id);
-- Une seule adresse principale par utilisateur, garantie par la base.
CREATE UNIQUE INDEX uq_addresses_primary ON addresses (user_id) WHERE is_primary;
`,
  },
];
