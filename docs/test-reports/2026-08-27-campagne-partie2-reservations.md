# Rapport — Campagne de validation QA, partie 2 : Création, consultation et validation des réservations (2026-08-27)

Session de reprise de la campagne de validation manuelle du tenant QA fictif (`QA FICTIF - XRent Validation`, id `cmta2y6uy0000m4n9xvm0hr18`). Périmètre exclusif de cette partie : les 42 points du brief « Création, consultation et validation des réservations ». Voir [docs/runbooks/campagne-validation-qa.md](../runbooks/campagne-validation-qa.md) pour la procédure et [HANDOFF.md](../../HANDOFF.md) pour l'état global.

## 1. État Git initial et final

- Initial : working tree propre, branche `main`, synchronisée avec `origin/main`, dernier commit `8cf84f1`.
- Final : working tree modifié (5 fichiers de code/tests + documentation), **aucun commit créé, aucun push effectué**, conformément aux règles de la session.

## 2. Comptes QA utilisés

| Compte | Rôle | Tenant | Agence(s) | Source d'authentification | Scénarios |
|---|---|---|---|---|---|
| `qa.agent.rak@fictif.test` | MEMBER (groupe personnalisé « AGENT ») | QA FICTIF - XRent Validation | RAK | `.env.qa.local` (mot de passe partagé, jamais affiché) | Création RAK→RAK (partielle, voir section 5), sélecteur véhicule/disponibilité/double réservation, modification/annulation/persistance, visibilité agent RAK, refus 403 sur actions hors permission |
| `qa.agent.casa@fictif.test` | MEMBER (groupe personnalisé « AGENT ») | QA FICTIF - XRent Validation | CASA | `.env.qa.local` | Visibilité agent CASA (y compris via l'agence de retour), refus d'accès à une réservation RAK-only, refus 403 sur actions hors permission |
| `qa.superadmin@fictif.test` | ADMIN | QA FICTIF - XRent Validation | toutes (bypass permissions) | `.env.qa.local` | Création RAK→RAK et RAK→CASA (voir section 5 pour la raison du choix de ce compte), reproduction/vérification du correctif BUG-008, création de la réservation CASA→CASA de test d'isolation |

Avant chaque scénario nécessitant un périmètre particulier, l'identité affichée dans le header (nom, rôle, tenant) a été vérifiée à l'écran avant d'agir — jamais supposée. Déconnexion propre (menu utilisateur → « Se déconnecter ») avant chaque changement de compte. Aucun mot de passe, token, cookie ni valeur de `.env.qa.local` n'a été affiché dans ce rapport ni dans aucun fichier suivi par Git.

**Compte non disponible** : `qa.sanspermission@fictif.test` (signalé indisponible dès la partie 1, mot de passe non réinitialisé) — non nécessaire pour cette partie, les refus de permission ont été vérifiés directement via les comptes `AGENT` (qui n'ont pas toutes les clés `reservations.*`, voir section 8).

## 3. Constat préalable important : `Reservation` ne réserve aucun véhicule

Avant de tester, lecture du code (`NewReservationForm.tsx`, `POST /api/reservations`) et de DOMAINRULES.md section 21 : **`Reservation` est un modèle volontairement distinct de `Location`**, sans sélection de véhicule réel, sans vérification de disponibilité, sans blocage de calendrier — `vehicleCategory`/`pickupAgency`/`dropoffAgency` restent du texte (résolu en `pickupAgencyId`/`dropoffAgencyId` uniquement pour la visibilité, jamais pour un blocage). C'est une décision produit documentée (Sprint 12C), pas un défaut.

En conséquence, les points du brief portant sur la sélection d'un véhicule réel, l'exclusion des véhicules loués/en maintenance, la disponibilité sur la période et la double réservation (points 4, 5, 6, 24, 25, 26) ont été vérifiés sur `Location` (`/dashboard/locations/new`), le modèle qui réserve réellement un véhicule et applique ces règles (DOMAINRULES.md section 7). Ce choix est documenté explicitement à chaque point concerné ci-dessous, conformément à CLAUDE.md règle 1 (ne jamais présenter une fonctionnalité comme existante si elle ne l'est pas dans le code visé).

## 4. Constat préalable — points 16/17 « hors horaires » : fonctionnalité non implémentée

Recherche exhaustive dans `src/lib/reservations.ts`, `src/lib/locations.ts` et les formulaires associés (`horaire`, `surcharge`, `out.of.hours`, etc.) : **aucun mécanisme de supplément ou de gestion « hors horaires » n'existe dans le code**, à aucun niveau (réservation ou contrat). Ce n'est pas un bug — c'est une fonctionnalité absente, jamais spécifiée dans DOMAINRULES.md ni mentionnée dans HANDOFF.md/aucun sprint antérieur. Les points 16 et 17 sont donc classés **N/A (fonctionnalité non implémentée)**, pas testés comme un refus/une acceptation, conformément à CLAUDE.md règle 1/2.

## 5. Découverte : travail non documenté déjà présent au début de cette partie

Avant toute action de cette session, l'état de `xrent_dev` contenait déjà deux réservations `QA-RES-001` (RAK→RAK, `CONVERTED`, notes « QA FICTIF — Parcours 1 RAK to RAK ») et `QA-RES-002` (RAK→CASA, `CONVERTED`, notes « QA FICTIF — Parcours 2 RAK to CASA (test prioritaire...) »), toutes deux datées du 2026-08-26 (horodatages `createdAt`/`updatedAt` confirmés en base), converties respectivement en contrats `00001` (`PENDING`) et `00002` (le contrat déjà connu des sessions BUG-004/005, `COMPLETED`). **Ce travail n'était mentionné dans aucun document** (HANDOFF.md, runbook, rapport de partie 1) — même schéma qu'un incident de processus déjà rencontré (rapport de session jamais écrit, voir INC-1/INC-8). N'ayant pas été créées par cette session, ces données n'ont pas été modifiées ni supprimées ; elles sont mentionnées ici pour que HANDOFF.md reflète l'état réel de `xrent_dev`, pas pour revendiquer ce travail. Aucun bug ni incohérence trouvé sur ces deux réservations lors de leur consultation.

**Conséquence sur le choix de compte** : le formulaire `/dashboard/reservations/new` fait dépendre ses listes déroulantes « Ville de départ »/« Ville de retour » de `GET /api/agencies`, qui exige la permission `agencies.view` (`src/app/api/agencies/route.ts`). Le groupe personnalisé « AGENT » assigné à `qa.agent.rak`/`qa.agent.casa` (33 clés, **pas** l'un des 4 groupes par défaut `ADMIN`/`MEMBER`/`COMPTABILITÉ`/`AGENCE` de l'application — voir `src/lib/permissions.ts`) ne contient pas cette clé, contrairement aux vrais groupes par défaut `MEMBER`/`AGENCE`, qui l'ont explicitement depuis un correctif du Sprint 17 (`src/lib/permissions.ts`, commentaire : « sans `agencies.view`, `GET /api/agencies` renvoie 403 pour ce groupe »). **Ce n'est pas un bug applicatif** — le code des groupes par défaut est correct et déjà vérifié par le Sprint 17 — c'est une lacune de la configuration du groupe QA « AGENT » (donnée de fixture, pas du code). Pour ne pas bloquer les scénarios de création avec sélection de ville, la création RAK→RAK et RAK→CASA a été effectuée avec `qa.superadmin@fictif.test` (ADMIN, bypass permissions), conformément à la répartition recommandée par le brief (« agent RAK **ou** administrateur QA selon les permissions prévues »). La création elle-même (sans sélection de ville) reste possible avec `qa.agent.rak`/`qa.agent.casa` (`reservations.create` bien présent dans leur groupe) — vérifié séparément (voir section 8, refus 403 uniquement sur les actions hors permission, jamais sur la création). **Recommandation** (pas appliquée sans autorisation, modification de configuration réelle) : ajouter `agencies.view` au groupe « AGENT » si son usage prévu est de couvrir le même périmètre que le groupe `AGENCE` par défaut.

## 6. Scénarios exécutés, résultats attendus et observés

Légende « Méthode » : **UI** = interaction navigateur réelle (Playwright/Chromium) ; **Serveur** = requête `fetch()` directe depuis le navigateur authentifié (bypass du JavaScript du formulaire, mêmes cookies de session) ; **SQL** = lecture directe en base pour confirmer la persistance (jamais une écriture) ; **N/A** = fonctionnalité non implémentée, pas un résultat de test.

| # | Scénario | Résultat attendu | Méthode | Résultat observé |
|---|---|---|---|---|
| 1 | Création réservation RAK → RAK | Réservation créée, statut `PENDING` | UI (`qa.superadmin`) | ✅ `QA-PART2-RES-RAK-001`, ville départ/retour Marrakech, source `TJS`, confirmé en base |
| 2 | Création réservation RAK → CASA | Réservation créée avec agences distinctes | UI (`qa.superadmin`) | ✅ `Dir-0001` (voucher DIRECT auto-généré), pickupAgencyId=RAK, dropoffAgencyId=CASA, confirmé en base |
| 3 | Sélection d'un client existant | Client résolu par nom | UI | ✅ « Ahmed Fictif-Majeur » sélectionné/saisi sur les deux réservations |
| 4 | Sélection d'un véhicule disponible | Seuls les véhicules `AVAILABLE` proposés | UI, sur `Location` (voir section 3) — `qa.agent.rak` | ✅ `/dashboard/locations/new` : 3 véhicules RAK `AVAILABLE` proposés (Dacia Duster, Renault Clio, Dacia Logan) |
| 5 | Absence des véhicules loués dans les sélecteurs | Véhicule `RENTED` exclu | UI, sur `Location` | ✅ Hyundai Accent QA-DejaLoue-RAK (`RENTED`) absent du sélecteur |
| 6 | Absence des véhicules en maintenance dans les sélecteurs | Véhicule `MAINTENANCE` exclu | UI, sur `Location` | ✅ Peugeot 208 QA-Maintenance-RAK (`MAINTENANCE`) absent du sélecteur |
| 7 | Sélection de la catégorie du véhicule | Champ texte libre saisissable | UI | ✅ « Citadine »/« Berline »/« SUV » saisis sans contrainte (texte libre, DOMAINRULES.md section 21) |
| 8 | Sélection de l'agence de départ dans une liste | Liste déroulante dérivée des agences réelles | UI | ✅ Combobox « Ville de départ » : Casablanca/Marrakech |
| 9 | Sélection de l'agence de retour dans une liste | Liste déroulante dérivée des agences réelles | UI | ✅ Combobox « Ville de retour » : Casablanca/Marrakech |
| 10 | Préremplissage automatique de l'agence de retour | Retour = départ à la sélection du départ | UI | ✅ Sélection « Marrakech » (départ) préremplit « Marrakech » (retour) |
| 11 | Modification possible de l'agence de retour | Retour modifiable indépendamment | UI | ✅ Retour changé manuellement de Marrakech à Casablanca, persisté (`dropoffAgencyId` = CASA) |
| 12 | Saisie des dates de départ et de retour | Champs date fonctionnels | UI | ✅ Conforme |
| 13 | Saisie des heures de départ et de retour | Champs heure fonctionnels | UI | ✅ Conforme (10:00 saisi et persisté) |
| 14 | Refus d'une date de retour antérieure au départ | Refus serveur (400) | UI + Serveur | ✅ `endDate` 05/11 < `startDate` 10/11 → 400, message « endDate doit être postérieure ou égale à startDate. », aucune création (confirmé en base) |
| 15 | Refus d'une heure de retour incohérente | — | UI + SQL | ⚠️ **Non implémenté, constat documenté (pas un bug)** — `startTime`/`endTime` sont des champs `String?` informatifs sur `Reservation` (`prisma/schema.prisma`), jamais combinés à `startDate`/`endDate` pour une comparaison réelle (contrairement à `Location`, section 3). Testé empiriquement : départ 18:00, retour 08:00 le même jour → accepté (201), confirmé en base. Aucune règle DOMAINRULES.md ne spécifie ce contrôle pour `Reservation` — à soumettre au propriétaire du projet si un contrôle est souhaité (CLAUDE.md règle 8, pas de règle métier nouvelle sans validation) |
| 16 | Gestion des réservations hors horaires | — | N/A | ℹ️ Fonctionnalité non implémentée (voir section 4) |
| 17 | Calcul des suppléments hors horaires | — | N/A | ℹ️ Fonctionnalité non implémentée (voir section 4) |
| 18 | Option GPS | Case à cocher + prix, persisté | UI + SQL | ✅ GPS coché, prix 50 MAD → `hasGps=true`, `gpsPrice=5000` (centimes) |
| 19 | Option siège bébé | Case à cocher + prix, persisté | UI + SQL | ✅ Siège bébé coché, prix 30 MAD → `hasBabySeat=true`, `babySeatPrice=3000` |
| 20 | Autres options disponibles | — | UI | ℹ️ Une seule autre option existe : « Conducteur supplémentaire » (testée, 20 MAD → `extraDriverPrice=2000`) ; aucune autre option n'est proposée par le formulaire actuel |
| 21 | Calcul du prix journalier | Prix/jour appliqué correctement | UI, sur `Location` | ✅ 450,00 MAD/jour (Dacia Duster) affiché et utilisé dans le calcul |
| 22 | Calcul du prix total | `pricePerDay × jours` | UI, sur `Location` | ✅ « 3 jour(s) × 450,00 MAD = 1 350,00 MAD » affiché en temps réel, confirmé après création |
| 23 | Vérification de la durée facturée | Arrondi au jour supérieur | UI, sur `Location` | ✅ 10/10 10:00 → 13/10 10:00 = exactement 3 jours (72h), conforme à `calculateTotalPrice` (DOMAINRULES.md section 14) |
| 24 | Vérification de la disponibilité pendant toute la période | Alerte si conflit | UI, sur `Location` | ✅ Message « Véhicule indisponible sur cette période (1 conflit(s)). » affiché en temps réel, bouton « Créer » désactivé |
| 25 | Tentative de double réservation du même véhicule | Refus | UI, sur `Location` | ✅ Période chevauchante (12/10→15/10 sur un véhicule déjà réservé 10/10→13/10) bloquée côté client |
| 26 | Refus de la double réservation côté serveur | 409, message clair, aucune écriture partielle | Serveur, sur `Location` (bypass du bouton désactivé) | ✅ `POST /api/locations` → 409, `{ error, conflictingLocations: [{id, startDate, endDate, status}] }` (aucune donnée client/prix exposée, conforme SECURITY.md section 25/Sprint 16) ; confirmé en base : aucune seconde location créée, la première intacte |
| — | Période adjacente non chevauchante (limite de date/heure) | Acceptée | UI + Serveur, sur `Location` | ✅ 13/10 10:00 → 16/10 10:00 (juste après la fin de la première, 13/10 09:00 UTC) acceptée sans avertissement, créée avec succès (contrat `00007`) — conforme à la règle « une reprise le jour même de la restitution n'est pas un conflit » (DOMAINRULES.md section 7) |
| 27 | Modification d'une réservation | Modification persistée | UI | ✅ Catégorie SUV, prix total 950 MAD, remarque ajoutée — tous persistés |
| 28 | Annulation d'une réservation | Statut `CANCELLED`, actions disparaissent | UI | ✅ Bouton « Annuler » → statut « Annulée », plus aucune action de transition (état terminal) |
| 29 | Actions du menu trois points | Menu contextuel fonctionnel, reflète les permissions | UI | ✅ Menu « Actions » : Détails/Valider/Modifier/Annuler (`ADMIN` : + No Show/Supprimer) ; le menu d'un compte `AGENT` (sans `reservations.delete`/`reservations.no_show`) masque correctement ces deux entrées |
| 30 | Suppression d'une réservation si cette fonction est prévue | Suppression avec confirmation | UI | ✅ Boîte de dialogue de confirmation (« Cette action est irréversible »), suppression effective après confirmation, confirmée en base (0 ligne restante) |
| 31 | Persistance après rechargement | Données inchangées après un rechargement complet | UI (navigation directe par URL, pas de soft-navigation) | ✅ Catégorie/prix/remarque/statut confirmés identiques après rechargement complet de la page |
| 32 | Visibilité des réservations par un agent RAK | Voit les réservations où RAK est départ ou retour | Serveur (`qa.agent.rak`) | ✅ 5 réservations visibles (toutes avec RAK comme départ ou retour), la réservation CASA→CASA (`QA-PART2-RES-CASA-001`) absente |
| 33 | Visibilité des réservations par un agent CASA | Voit les réservations où CASA est départ ou retour | Serveur (`qa.agent.casa`) | ✅ 3 réservations visibles (`QA-PART2-RES-CASA-001`, `Dir-0001`, `QA-RES-002`), les réservations RAK-only absentes |
| 34 | Visibilité d'une réservation dont l'agence de retour concerne l'agent | Visible même si l'agent n'a pas accès à l'agence de départ | Serveur (`qa.agent.casa`) | ✅ `Dir-0001` et `QA-RES-002` (départ RAK, retour CASA) visibles par `qa.agent.casa`, qui n'a pourtant aucun accès à RAK |
| 35 | Refus d'accès direct à une réservation non autorisée | 404 (jamais 403, pas de fuite d'existence) | Serveur + UI (page complète) | ✅ `qa.agent.rak` → `GET /api/reservations/{id CASA-CASA}` = 404 ; `qa.agent.casa` → `GET /api/reservations/{id RAK-only}` = 404 ; page `/dashboard/reservations/{id}` renvoie un vrai statut HTTP 404 (pas un soft-404), titre « Page introuvable » |
| 36 | Isolation entre tenants | Réservation d'un autre tenant invisible | Serveur + UI (page complète), `qa.superadmin` | ✅ Réservation réelle d'un tenant tiers (`QA Validation Alpha`) : `GET /api/reservations/{id}` = 404, message générique ; page complète = vrai 404 HTTP |
| 37 | Contrôle des permissions | Refus serveur (403) pour une action hors permission du groupe | Serveur (`qa.agent.casa`, groupe « AGENT » sans `reservations.delete`/`reservations.no_show`) | ✅ `DELETE` → 403 ; `PATCH status=NO_SHOW` → 403 |
| 38 | Validation des champs obligatoires | Blocage client-side, aucun appel réseau | UI | ✅ Formulaire vide → « Voucher, prénom, nom et dates de départ/retour sont requis. », confirmé qu'aucune requête `POST /api/reservations` n'a été émise |
| 39 | Refus des chaînes composées uniquement d'espaces | Refus (400/blocage client) | UI + Serveur | ❌→✅ **Bug trouvé (BUG-008)** : accepté avant correctif (`clientFirstName`/`clientLastName` = `"   "` persistés). **Corrigé et revérifié** — voir section 7 et INCIDENTS.md INC-11 |
| 40 | Responsive desktop (1280×800) | Aucun débordement | UI (captures d'écran) | ✅ Liste, filtres et formulaire correctement alignés |
| 41 | Responsive tablette (834×1112) | Aucun débordement de page (tableau scrollable en interne accepté) | UI (captures d'écran + `document.documentElement.scrollWidth === window.innerWidth`) | ✅ Sidebar en tiroir, bottom nav, tableau tronqué visuellement mais aucun débordement horizontal de la page (largeurs identiques, 834px) |
| 42 | Responsive mobile (390×844) | Idem + menu « Actions » utilisable | UI (captures d'écran + vérification `scrollWidth`) | ✅ Formulaire et filtres empilés lisiblement, menu « Actions » (dropdown) entièrement visible et cliquable au-dessus de la barre de navigation basse, aucun débordement horizontal |

## 7. Bug détecté et corrigé

**BUG-008** : `clientFirstName`/`clientLastName`/`voucherNumber` d'une réservation acceptaient une chaîne composée uniquement d'espaces — même défaut qu'INC-9 (BUG-006) sur `Client`, jamais appliqué à `Reservation`. Voir [INCIDENTS.md](../../INCIDENTS.md) INC-11 pour le détail complet (cause racine, correction, tests). Résumé :

- `POST /api/reservations` : `.trim()` ajouté aux contrôles `clientFirstName`/`clientLastName`/`voucherNumber`.
- `PATCH /api/reservations/[id]` : **aucun contrôle de présence n'existait sur ces trois champs avant ce correctif** (contrairement à `POST`) — un agent pouvait silencieusement effacer le client/voucher d'une réservation existante. Nouveau bloc de validation ajouté.
- Formulaires dashboard (`NewReservationForm.tsx`, `EditReservationForm.tsx`) : mêmes contrôles côté client, avant tout appel réseau.
- 2 tests automatisés ajoutés (`src/__tests__/reservations.test.ts`), suite complète 1311/1311, `npx tsc --noEmit`/`npm run lint`/`npm run build` verts, vérification manuelle en navigateur réel avant/après correctif.

Distinction demandée par le brief : le bug est **corrigé et vérifié** (tests automatisés + vérification manuelle). Le test ajouté a été confirmé comme échouant réellement sans le correctif (reproduit manuellement en navigateur avant de coder le correctif, puis revérifié après). Aucun bug reproductible et corrigeable ne reste ouvert dans le périmètre de cette partie.

## 8. Tests non exécutés et raisons

- **Refus 403 pour un compte totalement sans permission `reservations.*`** : non exécuté avec un compte dédié « sans accès » (indisponible, voir section 2) — compensé par la vérification directe des refus 403 sur les actions hors du périmètre réel du groupe « AGENT » (suppression, No Show — section 6 point 37), qui démontre que le contrôle serveur fonctionne bien indépendamment de l'UI.
- **Second conducteur** : hors périmètre explicite des 42 points de cette partie (le formulaire de réservation n'a pas de champ second conducteur — ce champ existe uniquement au niveau de la conversion en contrat, `ConvertReservationForm.tsx`, déjà couvert par la partie 1 et par la suite automatisée Sprint 30).
- **Import Excel, conversion en contrat, numérotation automatique du contrat, surclassement, paiements, retour véhicule, PDF, transferts/déplacements, export, audit, alertes** : hors périmètre explicite des 42 points de cette partie (« création, consultation et validation des réservations ») — restent dans le runbook pour une partie future.

## 9. Données créées, conservées, supprimées et modifiées

| Type | Identifiant | Tenant/Agence | Statut | Lien avec la suite |
|---|---|---|---|---|
| Créée, conservée | Réservation `QA-PART2-RES-RAK-001` (RAK→RAK) | QA FICTIF / RAK | `CANCELLED` (démontre création→édition→annulation) | Aucun, démonstration complète du cycle de vie |
| Créée, conservée | Réservation `Dir-0001` (RAK→CASA, voucher DIRECT auto-généré) | QA FICTIF / RAK→CASA | `PENDING` | Utile pour de futurs tests de conversion/visibilité |
| Créée, conservée | Réservation `QA-PART2-RES-CASA-001` (CASA→CASA) | QA FICTIF / CASA | `PENDING` | Utile pour de futurs tests d'isolation par agence |
| Créée, conservée | Contrat `00006` (Location, Dacia Duster, RAK) | QA FICTIF / RAK | `PENDING` | Démonstration double réservation ; numérotation RAK continue à `00008` |
| Créée, conservée | Contrat `00007` (Location, Dacia Duster, RAK) | QA FICTIF / RAK | `PENDING` | Démonstration période adjacente non chevauchante |
| Créée puis supprimée | Réservation `QA-PART2-WHITESPACE-TEST` | QA FICTIF | — | Reproduction de BUG-008 avant correctif, supprimée via `DELETE /api/reservations/[id]` après vérification (aucune dépendance) |
| Créée puis supprimée | Réservation `QA-PART2-DATE-TEST-1` | QA FICTIF | — | Démonstration point 14/15 (dates/heures), supprimée après vérification (aucune dépendance) |
| Découverte, non modifiée | Réservations `QA-RES-001`/`QA-RES-002` et contrats `00001`/`00002` | QA FICTIF | `CONVERTED`/`PENDING`/`COMPLETED` | Travail antérieur non documenté (voir section 5) — signalé, non touché |

Avant chaque suppression : vérifié via lecture directe (`GET`) qu'aucune autre donnée (paiement, facture, audit critique) n'y était liée, et que la donnée n'était pas une fixture d'origine — jamais de suppression directe en base, toujours via `DELETE /api/reservations/[id]` de l'application. Aucune donnée de la campagne existante (clients fictifs, agences, contrat n°00002 déjà `COMPLETED`) n'a été modifiée.

## 10. Fichiers modifiés

Code et tests : `src/app/api/reservations/route.ts`, `src/app/api/reservations/[id]/route.ts`, `src/app/dashboard/reservations/new/NewReservationForm.tsx`, `src/app/dashboard/reservations/[id]/edit/EditReservationForm.tsx`, `src/__tests__/reservations.test.ts`. Documentation : `INCIDENTS.md`, `TESTREPORT.md`, `HANDOFF.md`, `docs/runbooks/campagne-validation-qa.md`, ce rapport.

## 11. Prochaine partie exacte

Partie 3 : reprendre le runbook à partir du point 11 (« Conversion en contrat »), en suivant [docs/runbooks/campagne-validation-qa.md](../runbooks/campagne-validation-qa.md) section 6 (liste à jour des scénarios restants).

## 12. Complément du 2026-08-27 — passe de correction et de clôture avant la partie 3

Passe dédiée, sur brief explicite du propriétaire du projet, à corriger/clore les points restants de cette partie avant de commencer la conversion en contrat. Aucune fonctionnalité de la partie 3 n'a été développée.

### 12.1 Modèle métier confirmé (aucune correction nécessaire)

Relecture complète du schéma (`prisma/schema.prisma`) et des formulaires (`NewReservationForm.tsx`/`EditReservationForm.tsx`) : confirmé que `Reservation` **n'a pas** de champ `vehicleId` et qu'aucun sélecteur de véhicule n'existe sur ces formulaires — le modèle décrit dans la section 3 de ce rapport est exact et n'a jamais été contredit par le code. Voir DOMAINRULES.md section 69 (nouvelle) pour la confirmation formelle et le détail des contrôles déjà en place à la conversion (tenant, agence, disponibilité, exclusion `MAINTENANCE`/`TRANSFERRING`/`ON_TRIP`/`INACTIVE`, atomicité par verrou de ligne).

### 12.2 Bug trouvé et corrigé : véhicule `INACTIVE` non bloqué (INC-12)

En vérifiant les contrôles de disponibilité au moment de la conversion, un véhicule `INACTIVE` (immobilisé de façon permanente) s'est révélé **acceptable sans réserve** pour une nouvelle `Location` — que ce soit par création directe (`POST /api/locations`) ou par conversion de réservation (`POST /api/reservations/[id]/convert`) — alors qu'il est déjà bloqué pour les transferts et bons de déplacement. Corrigé (`VEHICLE_STATUSES_BLOCKING_LOCATION` étendu, `src/lib/locations.ts`), tests étendus (3 `it.each` existants), suite complète 1314/1314. Voir INCIDENTS.md INC-12 et DOMAINRULES.md section 43 (complément)/section 69.

### 12.3 Surclassement — état réel documenté, non corrigé (Bloqué par décision métier)

Le surclassement existe déjà côté formulaire de conversion (Sprint 22 : case « Autoriser un surclassement », case « Gratuit », supplément éditable) mais **n'est vérifié ni enregistré côté serveur** — `POST /api/reservations/[id]/convert` accepte n'importe quelle catégorie de véhicule sans comparaison à `reservation.vehicleCategory`, le supplément étant simplement replié dans `totalPrice`/`notes` (champs déjà génériques, pas de trace structurée). Aucune règle métier ne tranche aujourd'hui si un contrôle serveur strict est requis — documenté dans DOMAINRULES.md section 69, **non implémenté dans cette passe**, explicitement réservé à la partie 3.

### 12.4 Permission `agencies.view` du groupe QA « AGENT » — corrigée (sur autorisation explicite)

Reconfirmé par lecture de code que le groupe personnalisé « AGENT » (33 permissions) manquait `agencies.view`, contrairement aux vrais groupes par défaut de l'application (`MEMBER`/`AGENCE`, Sprint 17). Après confirmation de la règle (code, DOMAINRULES.md, test existant `permissions.test.ts`) et validation explicite du propriétaire du projet, la permission a été ajoutée via `PATCH /api/permission-groups/[id]` (34 permissions au total, aucune permission d'administration des agences ajoutée) :

- **Statut HTTP** : `200`, réponse confirmant `permissions.length === 34` et la présence de `agencies.view`.
- **Base de données** : 34 lignes `GroupPermission`, 34 valeurs distinctes (aucun doublon) ; seule `agencies.view` ajoutée sous le préfixe `agencies.*`.
- **Audit** : entrée `AuditLog` (`action: "permission_group.updated"`, `resource: "PermissionGroup"`, acteur `qa.superadmin@fictif.test`, horodatage confirmé) créée par la route elle-même.
- **Effet immédiat, sans reconnexion** : confirmé par lecture de code (`getEffectivePermissions()`, `src/lib/permissions.ts`, relit `GroupPermission` en base à chaque appel de `can()` — jamais mis en cache dans le JWT de session, qui ne porte que `id`/`tenantId`/`role`) et par test en navigateur réel : après la modification, `qa.agent.rak` (reconnecté pour permettre le test dans cet outil, un seul jeu de cookies partagé entre onglets — voir limite ci-dessous) obtient immédiatement `GET /api/agencies` → `200` avec Casablanca/Marrakech, sans qu'aucun mécanisme de rafraîchissement explicite n'ait été nécessaire.
- **Limite d'outillage documentée** : l'outil de navigateur utilisé dans cette session partage un seul jeu de cookies entre onglets, empêchant de garder une session `qa.agent.rak` **déjà ouverte avant la modification** simultanément à la session `qa.superadmin` ayant réalisé le `PATCH`. La preuve de « aucune reconnexion techniquement nécessaire » repose donc sur la lecture de code (déterministe, sans ambiguïté) plutôt que sur une démonstration empirique d'une session non rafraîchie — la reconnexion effectuée dans cette session est un artefact de l'outil, pas une exigence de l'application.
- **Vérifié pour `qa.agent.rak` et `qa.agent.casa`** : consultation des agences (200, RAK et CASA toutes deux visibles pour les deux comptes — `agencies.view` n'est pas scopé par agence, cohérent avec `GET /api/agencies` qui liste tout le tenant), `/dashboard/reservations/new` affiche désormais Casablanca/Marrakech dans les deux listes déroulantes, sélection fonctionnelle (testée par interaction, sans soumission), aucune donnée d'un autre tenant exposée. **Absence confirmée de droits d'administration** : `POST`/`PATCH`/`DELETE /api/agencies*` refusés (403) pour les deux comptes après la modification — seule la lecture a été accordée.
- **Aucune réservation supplémentaire créée** pour cette vérification (vérifications en lecture jugées suffisantes, conformément au brief).

### 12.5 Tests exécutés (passe de correction)

`node scripts/test-grouped.mjs` : **1314/1314**, 0 échec/timeout/résiduel. `npx tsc --noEmit`/`npm run lint`/`npm run build` : verts. Fichiers isolés `locations.test.ts` + `reservations.test.ts` : 213/213.

### 12.6 Données modifiées par cette passe

| Type | Identifiant | Avant | Après | Action |
|---|---|---|---|---|
| Configuration (PermissionGroup) | Groupe « AGENT » (id `cmta3a9t00074m4n9c4542mf0`, tenant QA) | 33 permissions, sans `agencies.view` | 34 permissions, avec `agencies.view` | `PATCH /api/permission-groups/[id]`, journalisé |

Aucune donnée métier (réservation, contrat, client, véhicule) créée, modifiée ou supprimée pendant cette passe — seule une configuration de permission a été corrigée, sur autorisation explicite.

### 12.7 Points restant ouverts avant la partie 3

- Surclassement : contrôle serveur non implémenté (décision métier à trancher, section 12.3) — la partie 3 devra soit l'implémenter, soit documenter explicitement le choix de rester purement déclaratif.
- Le doublon apparent « Omar Fictif-SecondCondValide » reste non élucidé (hors périmètre, signalé depuis la partie 1).
- Aucun autre point bloquant identifié pour démarrer la partie 3 (conversion en contrat).
