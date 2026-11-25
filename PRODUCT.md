# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Grand public urbain de la RDC (Kinshasa, Lubumbashi, Goma…) qui utilise déjà M-Pesa, Airtel Money ou Orange Money. Ils veulent un wallet en CDF et en USD pour envoyer, recevoir, convertir et payer en ligne, le plus souvent sur un téléphone Android. Audience secondaire : les commerçants et entreprises qui encaissent via l'espace marchand.

## Product Purpose

Pay243 est un wallet et une passerelle de paiement en ligne pour la RDC, « comme PayPal, mais pour le Congo ». Le wallet permet de recharger, d'envoyer, de retirer et de convertir de l'argent. Les marchands encaissent par API, par page de paiement hébergée ou par lien de paiement partagé sur WhatsApp. Le succès, c'est qu'un utilisateur fasse confiance au wallet pour garder et faire circuler son argent au quotidien.

## Positioning

- Un seul wallet relié à tous les opérateurs : M-Pesa (Vodacom), Airtel Money, Orange Money et les cartes Visa/Mastercard.
- Double devise CDF/USD, avec conversion intégrée.
- Paiement marchand complet : API, liens de paiement par WhatsApp, page de paiement hébergée, SDK.
- Confiance et sécurité : KYC à plusieurs niveaux, grand livre en partie double, protection contre le SIM swap, appareils de confiance.

## Operating Context

L'appli est utilisée sur téléphone, souvent dehors et en plein soleil, sur des Android d'entrée de gamme et des connexions 3G lentes. Les actions courantes sont : consulter les soldes, recharger par Mobile Money, envoyer à un autre utilisateur, retirer vers un numéro, convertir CDF⇄USD, gérer ses cartes, vérifier son identité (KYC) et, pour les marchands, créer des liens de paiement.

## Capabilities and Constraints

- Web statique : des pages HTML dans `public/`, du JavaScript vanilla en ligne, les styles partagés `public/assets/style.css` et `landing.css`, servis par Express. Aucun framework frontend, aucune étape de build.
- La politique de sécurité (CSP) interdit les polices et ressources externes : tout est hébergé sur le site (`public/assets/fonts/`).
- Interface uniquement en français.
- Doit rester légère et rapide sur des téléphones modestes avec une connexion lente.
- Doit rester lisible en plein soleil, donc avec un contraste élevé.
- Le JavaScript repose sur les IDs et classes existants : une refonte visuelle ne doit pas les casser.

## Brand Commitments

- Nom : Pay243 (anciennement Kongo Wallet ; deux chaînes `kongowallet` héritées doivent rester).
- Le logo actuel est conservé tel quel.
- Ancrage congolais : les couleurs du drapeau de la RDC (bleu ciel, jaune, rouge) font partie de l'identité.
- Direction visuelle demandée par le propriétaire : « gold premium », noir et or, avec une touche discrète des couleurs RDC.

## Evidence on Hand

- Logos des opérateurs et réseaux de cartes dans `public/assets/brands`.
- Aucun témoignage, aucune statistique d'usage, aucun partenaire officiel à afficher : ne pas en inventer.
- Le MVP fonctionne en mode sandbox, avec des opérateurs simulés.

## Product Principles

1. La confiance d'abord : chaque montant, frais et statut est clair et vérifiable.
2. Rapide sur un petit téléphone : rien ne doit ralentir une opération courante.
3. Lisible partout : du contraste et de grands chiffres, y compris dehors.
4. Un wallet unique pour tous les opérateurs : l'utilisateur n'a pas à penser au réseau.

## Accessibility & Inclusion

Contraste élevé (usage en plein soleil), cibles tactiles confortables, et respect de la préférence de réduction des animations.
