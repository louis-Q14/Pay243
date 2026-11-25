# Accueil Pay243 (public/index.html)

Mode : Persuade. Visiteur : grand public urbain de la RDC sur Android, souvent dehors ; secondaire : marchands et développeurs.
Action : créer un wallet (email → /signup), ou ouvrir un compte marchand.
Preuve disponible : frais réels (0 FC entre wallets, recharge sans frais Pay243, 1 % retrait, 2,5 % marchand), logos opérateurs, exemple de code API. Aucun témoignage ni statistique d'usage.
Contraintes : HTML statique + CSS partagé, pas de build, CSP sans ressources externes, JS existant (data-switch, data-guest/data-member, burger, #year, signupLinks) à garder.

## Direction contract

THESIS : Pay243 sort comme un album de rumba congolaise. La page refuse le « titre + bouton à gauche, téléphone à droite, trois cartes » : elle est une pochette de 33 tours, et ses sections sont les faces du disque.

OWN-WORLD : carton noir de pochette (#0d0c0a / #15130f), dorure à chaud (#d4ad5a, #ebcb84) pour le titre et les chiffres, ivoire pour le texte, sillons du vinyle en anneaux concentriques fins, rond central doré, fil tricolore RDC au pied de la pochette. Bricolage Grotesque très gras et serré pour le titre de pochette ; listes de titres en lignes filetées avec pointillés jusqu'au chiffre, chiffres tabulaires. Aucune carte arrondie : filets, carrés, cercles. Seule exception voulue : la bulle du message WhatsApp (face B, B1) garde les coins arrondis de l'application, parce qu'elle représente l'écran WhatsApp lui-même.

STORY : le visiteur comprend en un écran que c'est un wallet unique pour tous les Mobile Money, voit ce que coûte chaque geste, et crée son compte depuis la pochette. Plus bas, la face B parle aux marchands (lien WhatsApp, API), puis les notes de pochette (sécurité), les paroles (FAQ), et la fin de la face.

FIRST VIEWPORT : à gauche, la pochette carrée (≈ 560–620 px) : « Pay 243 » en dorure géante, villes en haut, opérateurs et fil RDC en bas ; le disque glisse à moitié hors de la pochette vers la droite, étiquette dorée « Face A ». À droite : intitulé « Face A — Particuliers », titre H1, liste A1–A4 avec frais alignés, puis formulaire email + bouton or « Créer mon wallet ». Bascule Face A / Face B (particuliers / entreprises) remplace la liste et l'action.

FORM : pochette de rumba, candidat 3 de ma liste (1 billet, 2 cambiste, 3 pochette de rumba, 4 étiquette de sapeur, 5 raphia Kuba, 6 lisière de wax, 7 poinçon d'or). seed:8383ccd03dc98e44. Signature : le disque sort de la pochette au chargement puis tourne lentement quand on survole la liste ; la bascule Face A/Face B retourne le disque. Mouvement : sortie du disque en ease-out exponentielle, chiffres qui se posent avec inertie ; tout figé sous prefers-reduced-motion.

FINISH : unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
