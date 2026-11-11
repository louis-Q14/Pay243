# Pay243 — wallet et passerelle de paiement en ligne pour la RDC

Pay243 fonctionne comme PayPal, mais pour la République démocratique du Congo :

- **Wallet double devise** en **CDF** et en **USD**, avec conversion intégrée.
- **Recharge** par **M-Pesa (Vodacom)**, **Airtel Money**, **Orange Money** ou **carte Visa/Mastercard** enregistrée.
- **Transferts P2P** instantanés entre utilisateurs et **retraits** vers n'importe quel numéro Mobile Money.
- **API marchands** : paiements, page de paiement hébergée, remboursements, versements, webhooks signés.
- **Liens de paiement** à partager par WhatsApp, pour les marchands sans site web.
- **SDK** navigateur (bouton « Payer avec Pay243 ») et Node.js, plus une boutique de démonstration.

> **Statut.** Ce dépôt est un MVP complet et testé (30 tests de bout en bout, dont 5 de concurrence) qui fonctionne en mode **sandbox** avec des opérateurs simulés. Les connecteurs M-Pesa, Airtel et agrégateur sont écrits d'après les documentations publiques. Ils doivent être validés avec les identifiants et la documentation obtenus lors de l'onboarding chez chaque opérateur. Voir la [feuille de route vers la production](#feuille-de-route-vers-la-production).

---

## Démarrage rapide

Prérequis : **Node.js 20 ou plus récent**. La base est **PostgreSQL**. En développement, rien à installer : le moteur PostgreSQL embarqué (PGlite, compilé en WebAssembly) stocke les données dans `./data/pglite`. En production, définissez `DATABASE_URL`.

```bash
npm install
npm start            # http://localhost:3000
npm test             # tests de bout en bout (PostgreSQL embarqué, en mémoire)

# Sur un vrai serveur PostgreSQL (base dédiée, VIDÉE à chaque passage) :
TEST_DATABASE_URL=postgres://user:mdp@localhost:5432/pay243_test npm run test:pg

# Test de charge : 2 instances sur la même base, transferts croisés, doubles paiements, idempotence (base VIDÉE)
LOAD_DATABASE_URL=postgres://user:mdp@localhost:5432/pay243_load npm run test:load

# Production / préproduction :
DATABASE_URL=postgres://user:mdp@hote:5432/pay243 npm start
```

| URL | Contenu |
|---|---|
| `http://localhost:3000/` | Page d'accueil (présentation particuliers et entreprises) |
| `http://localhost:3000/signup` | Création de compte (particulier ou entreprise) par email |
| `http://localhost:3000/app` | Application wallet et espace marchand |
| `http://localhost:3000/settings` | Paramètres du compte : profil, coordonnées, adresses, sécurité, notifications, relevés |
| `http://localhost:3000/checkout/:id` | Page de paiement hébergée |
| `http://localhost:3000/docs` | Documentation de l'API marchands |
| `http://localhost:3000/health` | Santé et contrôle d'équilibre du grand livre |
| `http://localhost:3000/admin` | Back-office conformité et finance : revue KYC, rapprochement, cantonnement, journal d'audit (clé affichée dans la console au démarrage en sandbox) |

### Scénario de test en 2 minutes

1. Sur `/signup`, choisissez **Particulier** ou **Entreprise**, puis saisissez votre email. En sandbox, aucun email n'est envoyé : le code s'affiche à l'écran et dans la console du serveur. Ajoutez un numéro **081…** (M-Pesa) pour recharger, puis cliquez sur **Recharger** : le crédit arrive après environ 3 s.
2. Créez un deuxième compte avec un numéro **097…** (Airtel) et envoyez-lui de l'argent.
3. Dans **Espace marchand**, créez votre boutique, puis générez un **lien de paiement** et ouvrez-le.
4. **Rapprochement :** une recharge vers un numéro finissant par `9999` perd son callback, `8888` simule un délai dépassé alors que l'opérateur a encaissé, `7777` ne répond jamais. Dans `/admin`, onglet **Rapprochement**, lancez la vérification des transactions en attente, importez un relevé CSV et traitez les écarts.
5. **KYC :** dans le wallet, cliquez sur **Vérifier mon identité** et envoyez trois photos (n'importe quelles images en sandbox). Ouvrez ensuite `/admin` avec la clé affichée dans la console du serveur, puis validez : les plafonds passent au niveau 2.
6. Payez avec le wallet, en Mobile Money (un numéro finissant par `0000` simule un refus) ou par carte (`4242 4242 4242 4242`).

### Boutique de démonstration (intégration marchand)

```bash
# Récupérez sk_test_… et whsec_… dans l'espace marchand, avec comme webhook http://localhost:4000/webhooks/pay243
PAY243_SECRET_KEY=sk_test_xxx PAY243_WEBHOOK_SECRET=whsec_xxx npm run demo:boutique
# → http://localhost:4000
```

---

## Architecture

```
src/
├── server.js / app.js        Démarrage Express, routes, gestion d'erreurs
├── config.js                 Frais, taux de change, plafonds KYC, pilotes opérateurs
├── db.js                     PostgreSQL (pg en production, PGlite en développement), transactions, verrous, baux
├── migrations.js             Migrations versionnées (appliquées au démarrage, sous verrou consultatif)
├── ledger.js                 Grand livre en partie double (wallets, écritures)
├── auth.js                   Mots de passe/PIN (scrypt), JWT, clés API marchands
├── routes/kyc.js             Vérification d'identité (utilisateur) et API du back-office
├── otp.js                    Codes SMS (inscription, nouvel appareil), appareils de confiance
├── netguard.js               Protection SSRF des webhooks sortants
├── limits.js                 Plafonds par opération, journaliers et de solde selon le niveau KYC
├── middleware.js             Idempotence, limitation de débit, en-têtes de sécurité
├── providers/
│   ├── mobileMoney/          mock | mpesa (Vodacom Open API) | airtel (Airtel Africa Open API) | aggregator
│   ├── cards/                mock (sandbox) ; interface prête pour un acquéreur PCI DSS
│   └── sms/                  mock | africastalking
├── services/
│   ├── mobileMoney.js        Encaissements, décaissements, dénouement idempotent des callbacks
│   ├── kyc.js                Pièces chiffrées (AES-256-GCM), dossiers, détection de doublons, validation
│   ├── reconciliation.js     Contrôle des transactions en attente, rapprochement des relevés, cantonnement
│   ├── payments.js           Cycle de vie des paiements marchands, commissions, remboursements
│   └── webhooks.js           Webhooks sortants signés HMAC, réessais exponentiels
└── routes/                   auth, wallet, merchants (admin et API), checkout, callbacks, sandbox
public/                       Wallet web, checkout hébergé, back-office (admin.html), docs, SDK navigateur
sdk/node/                     SDK serveur Node.js
examples/boutique-demo/       Exemple d'intégration complète côté marchand
test/                         Tests de bout en bout (node:test)
```

### Principes financiers

- **Partie double** : chaque mouvement crée deux écritures opposées. Pour chaque devise, la somme des soldes de tous les wallets vaut toujours 0, et `/health` le vérifie. Les comptes techniques (`float_mpesa`, `float_airtel`, `float_orange`, `float_card`, `payout_pending`, `fees`, `fx_pool`) représentent l'argent détenu hors plateforme. Ils servent de base au rapprochement avec les relevés opérateurs.
- **Entiers en unités mineures** : aucun calcul en virgule flottante sur les montants.
- **Atomicité et concurrence** : chaque mouvement de fonds s'exécute dans une transaction PostgreSQL qui verrouille les wallets concernés (`SELECT … FOR UPDATE`, dans l'ordre des identifiants), puis contrôle le solde. Les changements d'état passent par des mises à jour conditionnelles, dont une seule peut réussir :
  - un paiement passe de `requires_payment` à `processing` ;
  - un remboursement réserve son montant (`refunded_amount + x <= amount`) ;
  - un code OTP est consommé ;
  - une demande KYC est tranchée.

  Les dénouements opérateurs verrouillent la transaction, et les plafonds sont contrôlés sous verrou utilisateur. Ces garanties tiennent avec **plusieurs instances** derrière un répartiteur de charge.
- **Contraintes en base (défense en profondeur)** : un solde client ou marchand ne peut pas être négatif, un remboursement ne peut pas dépasser le paiement, une seule demande KYC peut être en cours par utilisateur, et un même relevé n'est importé qu'une fois.
- **Multi-instance sans Redis** : l'idempotence (clé réservée en base avant le traitement), la limitation de débit, la file des webhooks (`FOR UPDATE SKIP LOCKED`) et le contrôle des transactions en attente (bail en base) sont partagés via PostgreSQL. Il n'y a pas d'infrastructure supplémentaire à exploiter au lancement.
- **Idempotence** : l'en-tête `Idempotency-Key` est accepté sur tous les POST qui déplacent de l'argent, ce qui est indispensable sur les réseaux mobiles instables. Les callbacks opérateurs sont traités une seule fois.
- **Issue incertaine ≠ échec** : une coupure réseau, un délai dépassé ou une erreur 5xx de l'opérateur laisse la transaction `pending`. L'opérateur a peut-être exécuté l'opération : on ne conclut donc jamais à un échec sans preuve.
- **Trois filets de sécurité** :
  1. le contrôle automatique des transactions en attente interroge l'opérateur toutes les 5 min. Un encaissement sans réponse au bout de 30 min est déclaré échoué et signalé ; un décaissement n'est **jamais** restitué d'office, il est signalé au bout d'une heure ;
  2. le rapprochement quotidien compare chaque ligne du relevé opérateur au grand livre. Il détecte les opérations non créditées, inconnues, absentes chez l'opérateur ou dont le montant diffère ;
  3. le rapport de cantonnement compare la monnaie électronique en circulation au solde du compte bancaire dédié.

  Chaque écart se traite au back-office avec une note obligatoire, et chaque décision est journalisée.
- **Réservation des retraits** : le montant et les frais sont débités immédiatement vers `payout_pending`, puis restitués intégralement si l'opérateur échoue.
- **Commission marchand** (2,5 % par défaut) prélevée au moment de l'encaissement. Elle n'est pas restituée en cas de remboursement.

### Flux d'une recharge Mobile Money

```
Client ──POST /v1/topups──▶ Pay243 ──collect()──▶ Opérateur ──push USSD──▶ Téléphone du client
                                ▲                                                   │ PIN
                                └──── callback /webhooks/mobile-money/:op ◀─────────┘
                                      → crédit du wallet (float_op → wallet client)
```

---

## API

### Application wallet (session utilisateur `Authorization: Bearer <jwt>`)

| Méthode | Endpoint | Description |
|---|---|---|
| POST | `/v1/auth/otp` | `{ email }` : envoie un code à 6 chiffres par email (valable 5 min, renvoyé dans `sandbox_code` en sandbox) |
| POST | `/v1/auth/register` | `{ account_type: "personal" \| "business", email, otp_code, full_name, password, pin, phone?, business_name? (entreprise), device_id? }`. Un compte entreprise reçoit aussitôt son espace marchand et une clé `sk_test_` |
| POST | `/v1/auth/login` | `{ identifier (email ou téléphone), password, device_id?, otp_code? }` → `{ token }`. Depuis un appareil inconnu : `403 otp_required`, un code est envoyé par email (ou par SMS pour un compte sans email), puis on rejoue la requête avec `otp_code` |
| GET | `/v1/me` | Profil et plafonds KYC |
| GET | `/v1/me/settings` | Tout pour la page Paramètres : profil, adresses, appareils (en-tête `X-Device-Id` pour marquer l'appareil courant), marchand, statut KYC |
| PATCH | `/v1/me` | `{ full_name?, handle?, timezone?, nationality? }`. Nom et nationalité verrouillés après vérification d'identité |
| PUT/DELETE | `/v1/me/avatar` | Photo de profil, image brute JPEG/PNG/WebP de 300 Ko max. (contenu contrôlé) |
| POST | `/v1/me/email/otp` puis `/v1/me/email` | Changement d'email : code envoyé à la nouvelle adresse, puis `{ email, otp_code, password }`. L'ancienne adresse est prévenue |
| POST | `/v1/me/phone/otp` puis `/v1/me/phone` ; DELETE `/v1/me/phone` | Ajout ou changement de numéro vérifié par SMS ; retrait avec `{ password }` |
| GET/POST/PATCH/DELETE | `/v1/me/addresses[/:id]` | 5 adresses max., une seule principale (garanti par la base) |
| POST | `/v1/me/password` | `{ current_password, new_password }` : déconnecte les autres sessions, renvoie un nouveau `token` |
| POST | `/v1/me/pin` | `{ current_pin, new_pin }` |
| GET/DELETE | `/v1/me/devices[/:id]` | Appareils de confiance |
| POST | `/v1/me/sessions/revoke` | Déconnecte toutes les autres sessions, renvoie un nouveau `token` |
| PUT | `/v1/me/notifications` | `{ payments_email?, payments_sms?, product_email? }` (alertes de sécurité toujours actives) |
| POST | `/v1/me/business` | `{ business_name }` : passage en compte entreprise, crée l'espace marchand |
| GET | `/v1/me/export` | Export JSON de toutes les données personnelles |
| GET | `/v1/me/statements` / `/v1/me/statements/AAAA-MM` | Mois disponibles / relevé CSV (dates dans le fuseau du compte) |
| POST | `/v1/me/close` | `{ password, confirm: "FERMER", reason? }` : solde à zéro et aucune opération en cours exigés |
| GET | `/v1/wallets` | Soldes CDF et USD, taux de change |
| GET | `/v1/transactions` / `/v1/transactions/:id` | Historique et statut |
| POST | `/v1/topups` | `{ method: "mobile_money", amount, currency, phone?, operator? }` ou `{ method: "card", card_id, amount, currency }` |
| POST | `/v1/transfers` | `{ to (@identifiant, email ou téléphone), amount, currency, pin, note? }`. Le destinataire est prévenu selon ses préférences |
| POST | `/v1/withdrawals` | `{ amount, currency, pin, phone?, operator? }` (frais de 1 %) |
| POST | `/v1/conversions` | `{ from_currency, to_currency, amount, pin }` |
| GET/POST/DELETE | `/v1/cards` | Cartes enregistrées (jeton uniquement) |
| GET | `/v1/kyc` | Niveau, plafonds, statut de la dernière demande, pièces acceptées |
| POST | `/v1/kyc/files/{id_front\|id_back\|selfie}` | Image brute (`Content-Type: image/jpeg`, `png` ou `webp`, 5 Mo max.) → `{ id }` |
| POST | `/v1/kyc/submissions` | `{ document_type, document_number, date_of_birth, files: { id_front, id_back?, selfie } }` |
| POST | `/v1/merchants` | Crée le compte marchand et renvoie la première clé `sk_test_` |
| GET/PATCH | `/v1/merchants/me` | Profil, soldes, clés, webhook |
| POST | `/v1/merchants/me/keys` | Nouvelle clé API |
| POST | `/v1/merchants/me/payment-links` | Lien de paiement à partager |

### API d'intégration marchands (`Authorization: Bearer sk_test_…`)

Voir **`/docs`** pour le détail complet : `POST /v1/payments`, `GET /v1/payments/:id`, `POST /v1/payments/:id/refunds`, `POST /v1/payments/:id/cancel`, `GET /v1/balance`, `POST /v1/payouts`, `GET /v1/events`.

### Back-office (`Authorization: Bearer <clé agent>`)

Clés définies dans `ADMIN_KEYS="nom:clé,nom2:clé2"`, une par agent. Chaque consultation de dossier, ouverture d'image et décision est inscrite dans `admin_audit`.

| Méthode | Endpoint | Description |
|---|---|---|
| GET | `/v1/admin/kyc/submissions?status=pending\|approved\|rejected` | File d'attente, avec un indicateur `flagged` si la pièce ou une image est déjà utilisée sur un autre compte |
| GET | `/v1/admin/kyc/submissions/:id` | Dossier complet, doublons, demandes précédentes |
| GET | `/v1/admin/kyc/submissions/:id/files/:kind` | Image déchiffrée (`Cache-Control: no-store`) |
| POST | `/v1/admin/kyc/submissions/:id/approve` | `{ note?, override_duplicates? }` → niveau 2 et SMS. Une pièce déjà validée ailleurs exige `override_duplicates` et une note |
| POST | `/v1/admin/kyc/submissions/:id/reject` | `{ reason }` (envoyé à l'utilisateur par SMS) |
| GET | `/v1/admin/audit` | Journal d'audit |

### Rapprochement et cantonnement (back-office, même clé agent)

| Méthode | Endpoint | Description |
|---|---|---|
| POST | `/v1/admin/reconciliation/statements?operator=mpesa&date=AAAA-MM-JJ[&replace=1]` | Relevé opérateur en `text/csv` → rapport : lignes, concordances, écarts, différence nette par devise |
| GET | `/v1/admin/reconciliation/exceptions?status=open\|resolved` | Écarts à traiter |
| POST | `/v1/admin/reconciliation/exceptions/:id/resolve` | `{ action: "apply_success" \| "apply_failure" \| "acknowledge", note }` |
| POST | `/v1/admin/reconciliation/sweep` | Lance tout de suite le contrôle des transactions en attente (sinon toutes les 5 min) |
| GET | `/v1/admin/reconciliation/safeguarding?trust_CDF=…&trust_USD=…` | Monnaie électronique en circulation et couverture par le compte de cantonnement |

Format du relevé (une adaptation par opérateur reste à écrire à partir d'un vrai export) :

```csv
provider_ref,reference,type,amount,currency,status,timestamp
MP2611100001,txn_abc…,collect,200.00,USD,succeeded,2026-11-10T09:12:00Z
```

### Callbacks opérateurs (entrants)

URL à déclarer chez chaque opérateur ou agrégateur :

```
{BASE_URL}/webhooks/mobile-money/{mpesa|airtel|orange}?token={CALLBACK_SECRET}
```

En plus du jeton, filtrez les adresses IP sources des opérateurs au niveau du reverse proxy.

---

## Déploiement (Easypanel)

L'image est décrite par le [Dockerfile](Dockerfile) : Node 22, dépendances de production uniquement, utilisateur non root, contrôle de santé sur `/health`.

1. **Base :** dans le projet Easypanel, ajoutez un service **Postgres** et copiez son URL de connexion interne.
2. **Application :** ajoutez un service **App**, source GitHub `louis-Q14/Pay243`, branche `main`, construction par **Dockerfile**.
3. **Variables d'environnement :** `PAY243_MODE`, `BASE_URL=https://pay243.com`, `DATABASE_URL`, `JWT_SECRET`, `CALLBACK_SECRET`, `KYC_ENCRYPTION_KEY`, `KYC_STORAGE_DIR=/app/data/kyc`, `ADMIN_KEYS`, `WEBHOOK_BLOCK_PRIVATE=1`. Générez chaque secret avec `openssl rand -hex 32`.
4. **Volume :** montez un volume persistant sur `/app/data`. Les pièces d'identité chiffrées y sont stockées.
5. **Domaines :** ajoutez `pay243.com` et `www.pay243.com` vers le port **3000**, avec HTTPS. Côté DNS, faites pointer un enregistrement `A` de chaque nom vers l'IP du serveur.
6. **Mise à jour :** à chaque `git push` sur `main`, cliquez sur **Deploy**, ou activez le déploiement automatique. Les migrations s'appliquent au démarrage.

Tant que les contrats opérateurs, l'acquéreur cartes, le fournisseur d'emails et l'agrément BCC ne sont pas en place, laissez `PAY243_MODE=sandbox` : aucune somme réelle ne circule. Le passage à `live` refuse de démarrer si un pilote simulé reste actif.

## Brancher les vrais opérateurs

Chaque opérateur se configure indépendamment avec `MPESA_DRIVER`, `AIRTEL_DRIVER` et `ORANGE_DRIVER` (voir `.env.example`).

| Opérateur | Pilote | Ce qu'il faut obtenir |
|---|---|---|
| **Vodacom M-Pesa** | `mpesa` | Compte marchand Vodacom RDC, accès au portail M-Pesa Open API (marché `vodacomDRC`), clé API, clé publique, *Service Provider Code*, **IP de vos serveurs whitelistée**. Certains marchands sont encore raccordés à l'ancienne passerelle IPG (SOAP) : vérifiez lequel des deux systèmes vous est attribué. |
| **Airtel Money** | `airtel` | Application sur developers.airtel.africa (produits *Collection* et *Disbursement*), validation KYC pour la production, `client_id` et `client_secret`, PIN de décaissement chiffré. Pays `CD`, devises `CDF` et `USD`. |
| **Orange Money** | `aggregator` | L'accès API direct se négocie avec Orange RDC. En attendant, passez par un **agrégateur** qui couvre les trois opérateurs (le pilote fourni suit l'API *deposits/payouts* de type pawaPay ; FlexPay, MaxiCash, CinetPay, etc. s'adaptent en modifiant `aggregator.js`). |
| **Cartes** | à écrire | Acquéreur local (banque) ou PSP certifié **PCI DSS** avec champs de saisie hébergés et **3-D Secure**. Implémentez `retrieveToken`, `charge` et `refund` dans `src/providers/cards/`. |

> Astuce : pour aller vite, mettez les trois opérateurs sur `aggregator`. Un seul contrat suffit alors pour lancer le produit, et vous négocierez les intégrations directes, moins chères, une fois le volume atteint.

---

## Conformité en RDC (à traiter avant le lancement)

> Ces points sont des repères, pas un avis juridique. Faites-vous accompagner par un cabinet local.

- **Agrément BCC** : l'émission de monnaie électronique est encadrée par la Banque Centrale du Congo, notamment par l'**Instruction n°24** relative aux établissements de monnaie électronique (EME) et par la **loi n°18/019 de 2018** sur les systèmes de paiement. Deux options : obtenir un agrément d'EME, ce qui implique des exigences de capital et de cantonnement des fonds, ou opérer sous l'agrément d'une **banque partenaire**.
- **Cantonnement** : la monnaie électronique émise doit être couverte par des fonds équivalents déposés sur un compte dédié. Les wallets `float_*` du grand livre servent au rapprochement quotidien avec ce compte.
- **KYC / LCB-FT** : les niveaux et plafonds de `config.kyc` sont des exemples. Alignez-les sur les exigences BCC et la CENAREF (déclarations de soupçon, filtrage des listes de sanctions).
- **Double devise** : la politique de dédollarisation de la BCC pousse à l'usage du CDF (par exemple, la configuration des TPE en francs congolais imposée depuis août 2024). Gardez le CDF comme devise par défaut et suivez les instructions sur les opérations en devises.
- **Taux de change** : `FX_USD_CDF` est une valeur fixe d'exemple. Synchronisez-la chaque jour sur le taux indicatif de la BCC ou sur celui de votre banque partenaire.
- **Données personnelles** : hébergement, conservation et droit d'accès doivent respecter la réglementation congolaise et les exigences de l'agrément.

---

## Feuille de route vers la production

**Indispensable**

- [x] Vérification du numéro par **OTP SMS** à l'inscription et au changement d'appareil (pilote Africa's Talking à valider avec un compte réel et un expéditeur `PAY243` approuvé).
- [x] KYC niveau 2 : pièce d'identité (carte d'électeur, carte d'identité, passeport, permis), selfie et validation manuelle au back-office.
- [ ] Vérification automatique par un prestataire couvrant la RDC (lecture de la pièce, comparaison faciale, détection du vivant) avant la revue manuelle. Croisement avec les listes de sanctions.
- [ ] Stockage des pièces sur un stockage objet avec une clé gérée par KMS, et une durée de conservation fixée avec le conseil juridique.
- [ ] Pilote cartes réel (acquéreur PCI DSS et 3-D Secure) ; aucun numéro de carte ne doit transiter par vos serveurs.
- [x] **PostgreSQL** avec `SELECT … FOR UPDATE` sur les wallets. L'idempotence, la limitation de débit et les tâches de fond sont partagées entre instances via PostgreSQL.
- [x] Suite complète validée sur PostgreSQL 16 (`npm run test:pg`) et test de charge à deux instances (`npm run test:load`) : 180 transferts concurrents, aucun découvert ni double encaissement.
- [ ] Rejouer `test:pg` et `test:load` sur la préproduction réelle (réseau, taille de pool, PgBouncer éventuel) avant chaque mise en production.
- [ ] Stockage objet pour les pièces KYC (le dossier local `data/kyc` ne convient pas à plusieurs instances), sauvegardes PostgreSQL chiffrées avec rétention et restauration testée.
- [ ] Redis seulement si la charge le justifie (limitation de débit à très fort trafic) : l'interface `rateLimit` permet de changer de stockage.
- [x] Tâche de **rapprochement quotidien** entre les relevés opérateurs, `float_*` et le compte de cantonnement, plus une tâche de relance des transactions `pending` restées bloquées.
- [ ] Adaptateurs de relevés réels (export portail M-Pesa, Airtel, agrégateur) vers le format canonique, téléchargement automatique quand l'opérateur fournit une API (SFTP, API de relevé), et rapprochement des cartes avec les fichiers de l'acquéreur.
- [ ] Validation des codes de statut M-Pesa (`INS-*`, `queryTransactionStatus`) et du suivi des décaissements Airtel avec la documentation d'onboarding.
- [ ] Secrets dans un coffre (Vault ou KMS), HTTPS obligatoire, filtrage IP des callbacks, journaux d'audit immuables.
- [ ] Back-office, suite : support, gel de compte, déblocage du PIN, validation KYB des marchands, export comptable. Les comptes agents et les rôles doivent passer par une authentification forte (SSO + 2FA) plutôt que par des clés partagées.
- [ ] Clés `sk_live_` distinctes avec un **grand livre séparé** entre le test et la production.

**Fortement recommandé**

- [ ] Application mobile (React Native ou Flutter) réutilisant cette API ; menu **USSD** pour les téléphones basiques.
- [ ] Notifications SMS et push à chaque mouvement.
- [ ] Lingala et swahili en plus du français.
- [ ] Moteur antifraude : vélocité, appareils, montants inhabituels.
- [ ] Plugins WooCommerce et PrestaShop, paiement par QR code en magasin.

---

## Sécurité déjà en place

- Mots de passe et PIN hachés avec **scrypt** ; PIN bloqué après 5 erreurs.
- **OTP SMS** à l'inscription et sur tout nouvel appareil : code à 6 chiffres stocké en HMAC, 5 essais, 5 min de validité, 60 s entre deux envois et 5 envois par heure au maximum par numéro. Aucun SMS n'est envoyé sans le bon mot de passe.
- **Pièces KYC** chiffrées au repos (AES-256-GCM, rattachées à leur identifiant), servies uniquement aux agents et jamais mises en cache. Type réel vérifié par signature d'octets. Les images sont ré-encodées dans le navigateur, ce qui supprime les métadonnées EXIF, dont la position GPS. Doublons de numéro de pièce et d'image détectés entre comptes.
- **Anti-SSRF** sur les webhooks marchands en production : adresses privées, de loopback et link-local refusées (DNS vérifié à chaque envoi), redirections non suivies.
- Clés API stockées en **SHA-256** et affichées une seule fois ; révocables.
- Webhooks signés **HMAC-SHA256** avec horodatage contre le rejeu.
- Cartes : seul un **jeton** est stocké, avec la marque, les 4 derniers chiffres et la date d'expiration.
- Limitation de débit sur la connexion et le paiement, en-têtes de sécurité (CSP, HSTS, anti-iframe).
- Mode `live` refusé si des pilotes simulés ou des secrets par défaut sont configurés (`assertProductionConfig`).
