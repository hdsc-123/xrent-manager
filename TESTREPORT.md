# TESTREPORT.md — Suivi des tests

Ce document fait le point sur les tests réellement exécutés à ce jour et définit la stratégie de test future. Un framework de test (Vitest) est installé depuis le Sprint 2 et couvre l'isolation multi-tenant de la couche d'accès aux données ; depuis le Sprint 5, il couvre également le premier module métier (véhicules, locations) ; depuis le Sprint 6, la facturation, les paiements et les rapports ; depuis le Sprint 7, la maintenance et les alertes ; depuis le Sprint 8, le module clients dédié ; depuis le Sprint 9, la gestion des utilisateurs/invitations/audit et la résolution de tenant ; depuis le Sprint 10, le journal d'audit exhaustif sur tout le CRUD métier, l'édition de profil et un scénario end-to-end complet ; depuis le Sprint 11, le rafraîchissement de la session JWT après édition de profil et une garde de non-régression sur `POST /api/tenants` (retiré) ; depuis le Sprint 12A, les nouveaux champs professionnels des formulaires agences/véhicules/clients/locations ; depuis le Sprint 12B, la génération automatique de facture à la création d'une location et son impact sur la suppression d'une location ; depuis le Sprint 12C, le module réservations (CRUD, machine à états, import Excel via un fichier généré en mémoire avec `exceljs`, conversion en contrat), le système de permissions granulaires (CRUD groupes, assignation, application réelle sur une route gated) et la détection de doublons clients — voir section 3.

## 1. Tests déjà exécutés et résultats

| Date | Commande | Résultat | Détail |
|---|---|---|---|
| 2026-08-11 | `npm run lint` | ✅ Validé | Aucune erreur ESLint (config `eslint-config-next`) |
| 2026-08-11 | `npm run build` | ✅ Validé | Build de production Next.js 16.3.0 réussi (Turbopack), 2 routes statiques générées (`/`, `/_not-found`) |
| 2026-08-11 | `npm run test` (Vitest) | ✅ Validé | 5/5 tests passés — `src/__tests__/db.test.ts`, isolation multi-tenant de `getTenantById`/`getAgencyById`/`getUserById`, exécutés contre `xrent_dev` avec nettoyage systématique (`afterAll`) |
| 2026-08-11 | `npm run build` (après ajout de la couche d'accès aux données) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur, aucune régression sur les routes existantes |
| 2026-08-11 | `npm run test` (Vitest, après bascule sur base de test dédiée) | ✅ Validé | 5/5 tests passés — `vitest.config.mts` charge désormais `DATABASE_URL` depuis `.env.test` via `loadEnv` (Vite, mode `test`) ; tests exécutés contre `xrent_test` (base PostgreSQL distincte de `xrent_dev`, migration `init_tenant_agency_user` appliquée via `prisma migrate deploy`), aucune donnée résiduelle après nettoyage |
| 2026-08-11 | `npm run lint` (Sprint 3, après authentification + CRUD tenants/agences) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-11 | `npm run build` (Sprint 3) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; 10 routes API compilées (`/api/auth/*`, `/api/tenants*`, `/api/agencies*`) + Proxy (`src/proxy.ts`) enregistré |
| 2026-08-11 | `npm run test` (Vitest, Sprint 3) | ✅ Validé | 37/37 tests passés sur 4 fichiers (`db.test.ts`, `auth.test.ts`, `tenants.test.ts`, `agencies.test.ts`), voir section 3 « Tests d'intégration authentification et CRUD » |
| 2026-08-11 | `npm run lint` (Sprint 4, dashboard admin + UI) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-11 | `npm run build` (Sprint 4) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelle route API `/api/users` (GET) + 9 pages `/dashboard/*` + `/login` + `/register` compilées |
| 2026-08-11 | `npm run test` (Vitest, Sprint 4) | ✅ Validé | 46/46 tests passés sur 5 fichiers (ajout de `ui.test.tsx`), voir section 3 « Tests UI (Sprint 4) » |
| 2026-08-11 | `npm run lint` (Sprint 5, véhicules + locations) | ✅ Validé | Aucune erreur ESLint (dont une correction du pattern de fetch/chargement dans `dashboard/locations/new/page.tsx` pour respecter la règle `react-hooks/set-state-in-effect` du React Compiler) |
| 2026-08-11 | `npm run build` (Sprint 5) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelles routes API `/api/vehicles*`, `/api/locations*`, `/api/clients` + 6 nouvelles pages `/dashboard/vehicles*`/`/dashboard/locations*` compilées |
| 2026-08-11 | `npm run test` (Vitest, Sprint 5) | ✅ Validé | 76/76 tests passés sur 7 fichiers (ajout de `vehicles.test.ts` et `locations.test.ts`), voir section 3 « Tests métier véhicules et locations (Sprint 5) » |
| 2026-08-11 | `npm run lint` / `npm run test` / `npm run build` (changement de devise par défaut EUR → MAD) | ✅ Validé | Aucune régression : 76/76 tests toujours passés après migration `20260811203931_change_default_currency_to_mad` et mise à jour des assertions `currency` dans `vehicles.test.ts`/`locations.test.ts` |
| 2026-08-11 | `npm run lint` (Sprint 6, facturation + paiements + rapports) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-11 | `npm run build` (Sprint 6) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelles routes API `/api/invoices*`, `/api/payments*`, `/api/reports/*` + 4 nouvelles pages `/dashboard/invoices*`/`/dashboard/payments`/`/dashboard/reports` compilées |
| 2026-08-11 | `npm run test` (Vitest, Sprint 6) | ✅ Validé | 106/106 tests passés sur 10 fichiers (ajout de `invoices.test.ts`, `payments.test.ts`, `reports.test.ts`), voir section 3 « Tests facturation, paiements et rapports (Sprint 6) » |
| 2026-08-12 | `npm run lint` (Sprint 7, maintenance + alertes + notifications) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 7) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelles routes API `/api/maintenances*`, `/api/alerts*`, `/api/tasks/check-alerts` + 3 nouvelles pages `/dashboard/maintenances*`/`/dashboard/alerts` compilées |
| 2026-08-12 | `npm run test` (Vitest, Sprint 7) | ✅ Validé | 133/133 tests passés sur 12 fichiers (ajout de `maintenances.test.ts` et `alerts.test.ts`), voir section 3 « Tests maintenance et alertes (Sprint 7) » |
| 2026-08-12 | Vérification manuelle (Sprint 7) | ✅ Validé | Serveur `next dev` réel : inscription → agence → véhicule → maintenance planifiée aujourd'hui → `POST /api/tasks/check-alerts` → alerte visible dans le badge du header, le widget « À faire aujourd'hui » et `/dashboard/alerts` → acquittement → résolution → badge revenu à zéro ; second appel à `check-alerts` sans doublon d'alerte ; données de test nettoyées après vérification |
| 2026-08-12 | `npm run lint` (Sprint 8, module clients dédié) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 8) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelle route API `/api/clients/[id]` + 3 nouvelles pages `/dashboard/clients*` compilées (31 routes API + 25 pages `/dashboard/*` au total) |
| 2026-08-12 | `npm run test` (Vitest, Sprint 8) | ✅ Validé | 146/146 tests passés sur 13 fichiers (ajout de `clients.test.ts`), voir section 3 « Tests module clients (Sprint 8) » |
| 2026-08-12 | `npm run lint` (Sprint 9, gestion des utilisateurs, invitations, audit, résolution de tenant) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 9) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelles routes API `/api/users/[id]`, `/api/invitations*`, `/api/audit` + nouvelles pages `/dashboard/users/[id]`, `/dashboard/invitations`, `/dashboard/audit`, `/invitations/[id]` (publique) compilées |
| 2026-08-12 | `npm run test` (Vitest, Sprint 9) | ✅ Validé | 187/187 tests passés sur 18 fichiers (ajout de `password-policy.test.ts`, `users.test.ts`, `invitations.test.ts`, `audit.test.ts`, `e2e.test.ts`, extension de `auth.test.ts`), voir section 3 « Tests utilisateurs, invitations, audit et résolution de tenant (Sprint 9) » |
| 2026-08-12 | Vérification manuelle (Sprint 9) | ✅ Validé | Serveur `next dev` réel : inscription → connexion → invitation créée depuis `/dashboard/invitations` → page publique `/invitations/[id]` → acceptation → user créé avec le rôle invité → entrée visible dans `/dashboard/audit` → tentative de rétrogradation du dernier ADMIN refusée (409) ; données de test nettoyées après vérification |
| 2026-08-12 | `npm run lint` (Sprint 10, MVP production-ready) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 10) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; nouvelle route API `/api/users/me` (37 routes API au total) + `/dashboard/settings` restructurée (formulaire d'édition de profil) |
| 2026-08-12 | `npm run test` (Vitest, Sprint 10) | ✅ Validé | 206/206 tests passés sur 19 fichiers (extension de `audit.test.ts`, `users.test.ts`, `reports.test.ts` ; ajout de `e2e-full.test.ts`), voir section 3 « Tests Sprint 10 » |
| 2026-08-12 | `npm run lint` (Sprint 11, consolidation post-MVP) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 11) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; `POST /api/tenants` retiré (37 routes API inchangées en nombre de chemins, une méthode en moins), `/dashboard/tenants/new` retirée (28 pages `/dashboard/*`) |
| 2026-08-12 | `npm run test` (Vitest, Sprint 11) | ✅ Validé | 206/206 tests passés sur 19 fichiers (extension de `users.test.ts` : +1 test de rafraîchissement de session ; `tenants.test.ts` : describe `POST /api/tenants` remplacé par 1 test de garde 405, net −1), voir section 3 « Tests Sprint 11 » |
| 2026-08-12 | Vérification manuelle (Sprint 11) | ✅ Validé | Serveur `next dev` réel, via requêtes HTTP directes (`curl`) reproduisant le flux `useSession().update()` : inscription → connexion → `GET /dashboard` (nom affiché dans le `Header`) → `PATCH /api/users/me` (nouveau nom) → `GET /dashboard` sans update (nom **toujours** l'ancien, confirme la régression documentée avant correctif) → `GET /api/auth/csrf` + `POST /api/auth/session` (trigger update) → `GET /dashboard` (nouveau nom affiché, sans reconnexion) ; données de test nettoyées après vérification |
| 2026-08-12 | `npm run lint` (Sprint 12A, formulaires professionnels complets) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 12A) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; aucune nouvelle route (mêmes 37 routes API), migration `20260812170214_add_sprint12a_professional_fields` appliquée sur `xrent_dev` et `xrent_test` |
| 2026-08-12 | `npm run test` (Vitest, Sprint 12A) | ✅ Validé | 224/224 tests passés sur 19 fichiers (+18 tests, extension de `agencies.test.ts`, `vehicles.test.ts`, `clients.test.ts`, `locations.test.ts`, aucun nouveau fichier), voir section 3 « Tests Sprint 12A » |
| 2026-08-12 | Vérification manuelle (Sprint 12A) | ✅ Validé | Serveur `next dev` réel, piloté par un script Playwright headless (Chrome local, `playwright-core`, aucune dépendance ajoutée au projet) : inscription → connexion → création d'une agence/d'un véhicule/d'un client/d'une location avec tous les nouveaux champs remplis, composant téléphone à indicatif pays (`PhoneInput`) exercé, aperçu du nombre de jours vérifié (10/01 10:00 → 12/01 11:00 = 3 jours facturés, dépassement d'1h) — chaque formulaire redirige correctement ; captures d'écran des 4 formulaires vérifiées visuellement ; données de test nettoyées après vérification |
| 2026-08-12 | `npm run lint` (Sprint 12B, facturation auto, correctif déconnexion, invitations) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 12B) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; aucune nouvelle route (mêmes 37 routes API + 28 pages `/dashboard/*`), aucune migration de schéma (aucun champ ajouté, voir HANDOFF.md) |
| 2026-08-12 | `npm run test` (Vitest, Sprint 12B) | ✅ Validé | 224/224 tests passés sur 19 fichiers — aucun nouveau test ajouté (le sprint modifie un comportement transverse, pas un nouveau module), mais `clients.test.ts`/`locations.test.ts`/`vehicles.test.ts` ont dû être corrigés : leur nettoyage `afterAll` supprimait les `Location` avant les `Invoice` désormais générées automatiquement à leur création, provoquant une violation de contrainte de clé étrangère (`Invoice_locationId_fkey`) — ordre de suppression corrigé (`payment` → `invoice` → `location`), voir section 3 « Tests Sprint 12B » |
| 2026-08-12 | Vérification manuelle (Sprint 12B) | ✅ Validé | Serveur `next dev` réel, requêtes HTTP directes (`curl`, pas de navigateur — aucun outil d'automatisation navigateur disponible dans cette session, voir section 3) : inscription → connexion → agence → véhicule → client → `POST /api/locations` → réponse contenant `invoice` (facture `DRAFT` `INV-2026-00001` générée automatiquement, montant = `totalPrice` de la location) → page `/dashboard/locations/[id]` contient bien le bouton « Voir facture » → `GET /api/invoices/[id]/pdf` renvoie un PDF (200) → `DELETE /api/locations/[id]` réussit désormais (200, la facture DRAFT sans paiement est supprimée avec la location) → déconnexion (`POST /api/auth/logout`) 200. Le clic réel sur le menu utilisateur du `Header` (déclencheur du bug Base UI corrigé) n'a **pas** pu être exercé faute d'outil de navigateur automatisé dans cette session — le correctif est néanmoins directement conforme à l'anatomie documentée de `@base-ui/react` (`node_modules/@base-ui/react/docs/react/components/menu.md`, section « Anatomy » : `<Menu.GroupLabel>` toujours enfant de `<Menu.Group>`) et validé par le build TypeScript strict ; données de test nettoyées après vérification |
| 2026-08-12 | `npm run lint` (Sprint 12C, réservations + permissions + design + rapports + audit + profil) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-12 | `npm run build` (Sprint 12C) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur (vérifié à chaque étape via `npx tsc --noEmit`, pas seulement en fin de sprint) ; nouvelles routes API `/api/reservations*`, `/api/permission-groups*`, `/api/users/[id]/permissions` + nouvelles pages `/dashboard/reservations*`, `/dashboard/permissions`, `/dashboard/permission-groups*`, `/dashboard/users/[id]/permissions` compilées ; migration `20260812181105_add_sprint12c_reservations_and_permissions` appliquée sur `xrent_dev` et `xrent_test` |
| 2026-08-12 | `npm run test` (Vitest, Sprint 12C) | ✅ Validé | 263/263 tests passés sur 21 fichiers (+39 tests : ajout de `reservations.test.ts` et `permissions.test.ts`, extension de `clients.test.ts` et `users.test.ts`), voir section 3 « Tests Sprint 12C ». **Correctif de nettoyage nécessaire sur 16 fichiers existants** : l'inscription crée désormais 4 `PermissionGroup` par tenant (`ensureDefaultGroups`), et le nettoyage `afterAll` de ces fichiers supprimait le `Tenant` avant ses `PermissionGroup`, violant `PermissionGroup_tenantId_fkey` — un `prisma.permissionGroup.deleteMany(...)` a été inséré avant chaque `prisma.tenant.deleteMany(...)`, aucun changement de comportement testé |
| 2026-08-12 | Vérification (Sprint 12C) | ✅ Validé, sans navigateur | Aucun outil d'automatisation navigateur disponible dans cette session (comme le Sprint 12B) — le parcours complet (import Excel avec aperçu → réservation → doublon client détecté à la conversion → conversion en Location+Invoice → assignation de permissions à un user → sidebar filtrée en conséquence → nouveaux graphiques de rapports avec données réelles → export CSV de l'audit → profil avec téléphone/photo) est couvert par les 263 tests d'intégration HTTP réels contre un vrai serveur `next dev` de test, pas par une interaction navigateur. **Limite documentée, à lever lors d'un prochain sprint si une vérification visuelle est jugée nécessaire** (même limite que le Sprint 12B). |

**Premier test métier disponible depuis le Sprint 5** (véhicules, locations) — jusqu'ici, aucun module métier n'existait dans le code (voir [HANDOFF.md](./HANDOFF.md) et [PROJECT_MAP.md](./PROJECT_MAP.md)). La couche d'accès aux données technique (`src/lib/db.ts`), l'authentification, le CRUD tenants/agences et désormais véhicules/locations disposent de tests d'isolation multi-tenant et multi-agence.

## 2. Tests disponibles et non encore disponibles

- Framework installé : **Vitest** (`npm run test`), choisi en Sprint 2 pour sa compatibilité native avec TypeScript/ESM et Next.js 16.
- Base de test dédiée : **`xrent_test`**, distincte de `xrent_dev`. `vitest.config.mts` charge `DATABASE_URL` depuis `.env.test` via `loadEnv` de Vite (mode `test`) ; la migration `init_tenant_agency_user` y est appliquée via `prisma migrate deploy`.
- Tests disponibles : isolation multi-tenant de la couche d'accès aux données (`src/__tests__/db.test.ts`, section 3 « Tests multi-tenant ») ; tests métier véhicules/locations depuis le Sprint 5 (section 3 « Tests métier véhicules et locations (Sprint 5) ») ; tests métier facturation/paiements/rapports depuis le Sprint 6 (section 3 « Tests facturation, paiements et rapports (Sprint 6) ») ; tests maintenance/alertes depuis le Sprint 7 (section 3 « Tests maintenance et alertes (Sprint 7) ») ; tests module clients depuis le Sprint 8 (section 3 « Tests module clients (Sprint 8) ») ; tests gestion des utilisateurs/invitations/audit/résolution de tenant à la connexion depuis le Sprint 9 (section 3 « Tests utilisateurs, invitations, audit et résolution de tenant (Sprint 9) ») ; tests audit exhaustif/profil/sécurité consolidée/E2E complet depuis le Sprint 10 (section 3 « Tests Sprint 10 ») ; test de rafraîchissement de session et garde de non-régression `POST /api/tenants` depuis le Sprint 11 (section 3 « Tests Sprint 11 ») ; tests des champs professionnels agences/véhicules/clients/locations depuis le Sprint 12A (section 3 « Tests Sprint 12A ») ; correctif de nettoyage/suppression lié à la génération automatique de facture depuis le Sprint 12B (section 3 « Tests Sprint 12B ») ; tests du module réservations (CRUD, machine à états, import Excel, conversion), du système de permissions granulaires et de la détection de doublons clients depuis le Sprint 12C (section 3 « Tests Sprint 12C »).
- Non encore disponible : tests de concurrence, de charge, de sécurité (OWASP WSTG) ou de régression.

## 3. Stratégie future de tests

Le framework de test unitaire/intégration est désormais **tranché : Vitest** (Sprint 2). L'outil e2e et l'outil de test de charge restent **À DÉCIDER**. Les principes suivants sont actés (dont certains confirmés lors de la validation du Sprint 1, voir [HANDOFF.md](./HANDOFF.md)) :

- **Décision validée (Sprint 1)** : chaque module métier devra être accompagné de tests dès sa création (voir [CLAUDE.md](./CLAUDE.md)), pas ajoutés a posteriori.
- **Décision validée (Sprint 1)** : priorité aux tests d'isolation multi-tenant, le modèle d'isolation par `tenant_id` partagé étant désormais retenu (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 8 et [SECURITY.md](./SECURITY.md) section 1).
- Les règles de sécurité critiques (isolation tenant/agence, autorisation, montants financiers) devront être couvertes par des tests avant toute mise en production.

### Tests unitaires
Cibleront la logique métier pure (calculs de montants, règles de transition d'état, validations). Aucun test unitaire n'existe à ce jour.

### Tests d'intégration
Cibleront les interactions entre la logique serveur et la future couche d'accès aux données (ex. une action serveur qui crée une réservation et vérifie les règles de disponibilité). Aucun test d'intégration n'existe à ce jour.

### Tests end-to-end
Cibleront les parcours utilisateurs complets (ex. création d'une réservation jusqu'à la signature d'un contrat), notamment en mobile-first. Aucun test end-to-end n'existe à ce jour.

### Tests métier
Vérifient le respect des règles définies dans [DOMAINRULES.md](./DOMAINRULES.md) au fur et à mesure qu'elles sont tranchées et implémentées — en particulier les règles de représentation des montants (section 14) et des dates (section 15). Premier module couvert au Sprint 5 (véhicules, locations) — voir « Tests métier véhicules et locations (Sprint 5) » ci-dessous.

### Tests de permissions
Vérifieront qu'un utilisateur ne peut jamais accéder à une action ou une ressource hors de son rôle. Aucun test de permission n'existe à ce jour.

### Tests multi-tenant
Priorité de test la plus élevée du projet (décision Sprint 1) : le modèle d'isolation retenu (`tenant_id` partagé, voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 8) rend l'omission d'un filtre tenant le risque de sécurité le plus critique (voir [SECURITY.md](./SECURITY.md) section 1). Ces tests vérifient explicitement qu'aucune donnée d'un tenant n'est accessible depuis un autre tenant, y compris par accès direct par identifiant (IDOR, voir [SECURITY.md](./SECURITY.md) section 7).

**Premier test multi-tenant en place (Sprint 2)** : `src/__tests__/db.test.ts` crée deux tenants de test, une agence et un utilisateur pour chacun, puis vérifie que `getAgencyById(tenantA, agencyIdDeB)` et `getUserById(tenantA, userIdDeB)` retournent systématiquement `null` — jamais la ressource de l'autre tenant. Les données créées sont supprimées en fin de suite (`afterAll`). Ce test s'exécute contre `xrent_test`, base de test dédiée distincte de `xrent_dev` (voir section 2).

Limites connues de ce premier test, à traiter dans une prochaine itération :
- Il couvre uniquement la couche d'accès aux données (`src/lib/db.ts`), pas encore une action ou route serveur réelle (aucune n'existe).
- Il ne couvre pas l'écriture (création/modification/suppression), uniquement la lecture — à étendre dès que des fonctions d'écriture existeront dans la couche d'accès aux données.

**Extension Sprint 3 — isolation au niveau des routes API** : `src/__tests__/tenants.test.ts` et `src/__tests__/agencies.test.ts` vérifient, à travers de vraies requêtes HTTP authentifiées, qu'un ADMIN d'un tenant ne peut ni lister, ni lire, ni modifier, ni supprimer les ressources (`Tenant`, `Agency`) d'un autre tenant (404, jamais de fuite d'existence — SECURITY.md section 7), et qu'au sein d'un même tenant, un MEMBER non rattaché à une agence via `UserAgency` ne peut pas non plus y accéder (SECURITY.md section 2). Ces écritures (création/modification/suppression) sont désormais couvertes, en plus de la lecture.

### Tests d'intégration authentification et CRUD (Sprint 3)

`src/__tests__/auth.test.ts`, `tenants.test.ts` et `agencies.test.ts` sont des tests d'intégration HTTP réels, pas des appels directs aux fonctions des route handlers : NextAuth (`auth()`) utilise en interne `next/headers`, une API qui lève une erreur (« headers was called outside a request scope ») si elle n'est pas invoquée dans le contexte d'une vraie requête servie par Next.js — vérifié empiriquement pendant ce sprint. `vitest.global-setup.ts` démarre donc un vrai serveur `next dev` (port dédié 3811, pointé sur `xrent_test` via `.env.test`) avant la suite de tests et l'arrête à la fin ; les tests utilisent `fetch` et gèrent eux-mêmes le cookie de session (`authjs.session-token`).

Couverture :
- **`auth.test.ts`** : inscription (tenant + admin), rejet d'un mot de passe trop court, rejet d'un slug de tenant dupliqué, `passwordHash` jamais présent dans une réponse API (vérifié aussi bien sur `/register` que `/login`) tout en confirmant via Prisma que le hash est bien stocké et distinct du mot de passe en clair, `/me` sans session → 401, `/login` avec mauvais mot de passe et avec compte inexistant → même code et même message d'erreur (SECURITY.md section 3), cycle complet login → me → logout avec vérification que `/logout` efface bien le cookie de session côté serveur (`Max-Age=0`).
- **`tenants.test.ts`** : CRUD complet avec vérification systématique de l'isolation multi-tenant (404 sur toute tentative d'accès au tenant d'un autre admin) et du contrôle de rôle (403 pour un MEMBER sur les routes réservées ADMIN), y compris le refus de suppression d'un tenant ayant des utilisateurs actifs (contrainte de clé étrangère, 409).
- **`agencies.test.ts`** : CRUD complet avec isolation multi-tenant (404 sur une agence d'un autre tenant) **et** multi-agence (404 pour un MEMBER non explicitement rattaché via `UserAgency`, 200 une fois rattaché), contrôle de rôle (403 pour un MEMBER sur la création/modification, même rattaché), et refus de suppression d'une agence ayant des utilisateurs rattachés (409).

Limite connue : ces tests valident le comportement HTTP réel (le plus proche des conditions de production), mais ajoutent une dépendance à un serveur `next dev` démarré pour la durée de la suite — plus lent qu'un test unitaire pur, et sensible à la disponibilité du port 3811 en local.

### Tests UI (Sprint 4)

`src/__tests__/ui.test.tsx` prolonge l'approche « intégration HTTP réelle » des fichiers ci-dessus plutôt que d'introduire un second paradigme de test (jsdom/@testing-library) : les pages sont interrogées via `fetch` contre le même serveur `next dev` de test, et les assertions portent sur le code HTTP et le contenu HTML rendu (SSR).

Couverture :
- `/login` et `/register` accessibles sans authentification, formulaires présents (`name="email"`, `name="password"`, `name="tenantName"`).
- `/dashboard*` redirige vers `/login` si non authentifié (307, via `src/proxy.ts`) et rend le contenu attendu une fois authentifié.
- `/dashboard/users` (lecture seule, voir HANDOFF.md) : rend la liste pour un ADMIN, redirige un MEMBER vers `/dashboard`.
- `GET /api/users` : 401 sans session, 403 pour un MEMBER, 200 avec la liste du tenant pour un ADMIN — et vérifie explicitement que `passwordHash` n'est jamais présent dans la réponse.

**Point technique découvert pendant ce sprint** (breaking change vs. connaissances par défaut sur Next.js, cf. AGENTS.md) : `redirect()` appelé depuis un Server Component (pas depuis `src/proxy.ts`) ne renvoie **pas** un vrai 307 HTTP lorsque la route est en contexte de streaming (ex. présence d'un `loading.tsx` sur le segment) — il renvoie un 200 contenant une balise `<meta http-equiv="refresh">`, conformément à `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`. Vérifié empiriquement : le code situé après l'appel à `redirect()` ne s'exécute bien jamais (pas de fuite de données), seul le mécanisme de transport du redirect change. Les tests de ce fichier vérifient donc le contenu de la balise meta plutôt qu'un code de statut 307/308 pour les redirections émises depuis une page, et distinguent ce cas de celui de `src/proxy.ts` (vrai 307, avant tout rendu).

### Tests métier véhicules et locations (Sprint 5)

`src/__tests__/vehicles.test.ts` et `src/__tests__/locations.test.ts` prolongent l'approche « intégration HTTP réelle contre un vrai serveur `next dev` de test » des fichiers précédents.

Couverture `vehicles.test.ts` :
- CRUD complet (`POST`/`GET`/`PATCH`/`DELETE /api/vehicles*`), immatriculation unique par tenant (409 en cas de doublon).
- Isolation multi-tenant (404 sur un véhicule d'un autre tenant) **et** multi-agence (403 pour un MEMBER non rattaché à l'agence du véhicule, 200/201 une fois rattaché via `UserAgency`).
- **Régression de sécurité détectée et corrigée pendant ce sprint** : `canAccessAgency` (`src/lib/authz.ts`) autorisait initialement un ADMIN à agir sur une agence de *n'importe quel* tenant (elle ne vérifiait que le rôle, jamais que l'agence appartenait au tenant de l'utilisateur) — un test (« refuse une agence appartenant à un autre tenant ») a révélé le problème avant tout déploiement ; corrigé en ajoutant une vérification `agency.tenantId === user.tenantId` en tête de la fonction, ce qui renforce au passage `agencies/[id]/route.ts` de façon strictement défensive (comportement inchangé, car ces routes vérifiaient déjà le tenant en amont via `getAgencyById`).
- Suppression bloquée (409) pour un véhicule ayant au moins une location, quel qu'en soit le statut (règle explicite de l'énoncé du sprint).
- Disponibilité (`GET /api/vehicles/[id]/availability`) : disponible en l'absence de location, conflit détecté sur chevauchement, pas de conflit sur des périodes adjacentes (chevauchement strict, voir DOMAINRULES.md section 7).

Couverture `locations.test.ts` :
- Création : validation `endDate > startDate` (400), isolation multi-tenant sur `vehicleId`/`clientId` (404), calcul `totalPrice = pricePerDay × jours` avec arrondi au jour supérieur, statut `PENDING` par défaut, devise reprise du véhicule (`EUR`).
- Conflits de réservation : 409 avec `conflictingLocations` sur chevauchement, 201 sur période strictement adjacente.
- Contrôle de rôle : 403 pour un MEMBER non rattaché à l'agence du véhicule.
- Machine à états (`PATCH /api/locations/[id]`) : transition valide acceptée (`PENDING → CONFIRMED`), transition invalide refusée (409, ex. `PENDING → COMPLETED`), recalcul de `totalPrice` lors d'un changement de dates.
- Suppression : autorisée pour `PENDING`/`CANCELLED`, refusée (409) pour tout autre statut — un test vérifie explicitement le parcours « refus sur CONFIRMED → annulation via PATCH → suppression acceptée après annulation ».
- Isolation multi-tenant sur `GET`/`PATCH /api/locations/[id]` (404 sur une ressource d'un autre tenant).

Limite connue, partagée avec les autres suites HTTP : dépendance à un serveur `next dev` démarré pour la durée de la suite (port 3811).

### Tests facturation, paiements et rapports (Sprint 6)

`src/__tests__/invoices.test.ts` et `src/__tests__/payments.test.ts` prolongent l'approche « intégration HTTP réelle » ; `src/__tests__/reports.test.ts` teste directement les fonctions de `src/lib/reports.ts` (pas de route dédiée par métrique, juste `/api/reports/revenue` et `/api/reports/vehicles`).

Couverture `invoices.test.ts` :
- Création à partir d'une `Location` : `subtotal` = snapshot de `Location.totalPrice`, `agencyId`/`clientId`/`currency` toujours dérivés de la location (jamais du client), statut `DRAFT` par défaut.
- Isolation multi-tenant sur `locationId` (404) et contrôle d'agence (403 pour un MEMBER non rattaché).
- Numérotation : format `INV-{année}-{5 chiffres}` vérifié par regex, unicité vérifiée en créant deux factures consécutives pour le même tenant.
- Calcul `taxAmount`/`totalAmount` à partir de `taxRate` (points de base) et `discountAmount` ; refus (400) si la remise dépasse sous-total + TVA.
- Machine à états : transition manuelle `DRAFT → SENT` acceptée, transition manuelle vers `PARTIALLY_PAID`/`PAID` refusée (409, ces statuts ne sont atteignables qu'automatiquement via un paiement, jamais par `PATCH` direct).
- Édition de `taxRate`/`discountAmount` bloquée (409) une fois la facture sortie de `DRAFT`.
- Suppression : autorisée pour `DRAFT`, refusée (409) pour `SENT`.

Couverture `payments.test.ts` :
- Isolation multi-tenant sur `invoiceId` (404) ; refus (409) d'un montant dépassant le solde restant dû.
- Paiement partiel → facture `PARTIALLY_PAID` ; paiement soldant intégralement → facture `PAID` ; refus (409) de tout paiement sur une facture `CANCELLED`.
- `PATCH`/`DELETE /api/payments/[id]` recalculent systématiquement `amountPaid`/`status` de la facture à partir de la somme réelle des paiements (`recomputeInvoiceStatus`), jamais par incrément/décrément direct — testé explicitement après modification et après suppression d'un paiement.
- **Point notable** : après suppression du dernier paiement d'une facture `PAID`, le statut retombe à `SENT`, jamais à `DRAFT` — décision délibérée pour ne jamais rouvrir l'édition de `taxRate`/`discountAmount` d'une facture déjà émise (voir `InvoiceNotEditableError` dans `src/lib/invoices.ts`).

Couverture `reports.test.ts` :
- `getRevenueReport` : agrégation des `Payment.amount` par mois d'encaissement (`paidAt`), isolée par tenant.
- `getVehicleUtilizationReport` : jours loués = chevauchement entre la période de la `Location` et la période demandée (même convention de calcul — différence de temps, pas décompte inclusif — que `calculateTotalPrice` dans `src/lib/locations.ts`) ; les locations `PENDING`/`CANCELLED` ne comptent jamais.
- `getTopVehicles` : classement par revenu facturé (`Location.totalPrice`, statuts `ACTIVE`/`COMPLETED` uniquement), limite respectée.

Limite connue : `getRevenueReport` suppose une devise unique par tenant (voir DOMAINRULES.md section 14) ; pas de test multi-devises (aucun tenant multi-devises n'existe à ce jour).

### Tests maintenance et alertes (Sprint 7)

`src/__tests__/maintenances.test.ts` prolonge l'approche « intégration HTTP réelle » ; `src/__tests__/alerts.test.ts` combine appels directs à `src/lib/alerts.ts` (aucune route `POST /api/alerts` n'existe : une alerte n'est jamais créée directement par un client, seulement par le système — voir DOMAINRULES.md) et intégration HTTP pour `acknowledge`/`resolve`/filtrage.

Couverture `maintenances.test.ts` :
- Création : `agencyId`/`currency` toujours dérivés du véhicule (jamais du client), isolation multi-tenant sur `vehicleId` (404), contrôle d'agence (403 pour un MEMBER non rattaché), refus (400) d'un coût négatif.
- Isolation multi-tenant sur `GET /api/maintenances`.
- Machine à états (`PATCH /api/maintenances/[id]`) : `SCHEDULED → COMPLETED` accepté avec `completedDate` fixée automatiquement, transition invalide `COMPLETED → SCHEDULED` refusée (409).
- Historique conservé : modification (`notes`) et suppression refusées (409) une fois `COMPLETED` ; suppression autorisée pour `SCHEDULED`.
- Génération d'alertes : `POST /api/tasks/check-alerts` (réservé ADMIN, 403 pour un MEMBER) crée une alerte `MAINTENANCE_DUE` pour une maintenance planifiée aujourd'hui, et un second appel ne la duplique pas tant qu'elle n'est pas résolue (`hasUnresolvedAlert`, `src/lib/scheduled-tasks.ts`).

Couverture `alerts.test.ts` :
- `createAlert`/`getAlerts` : statut `PENDING` et priorité `MEDIUM` par défaut, isolation multi-tenant, tri par priorité (`URGENT` en premier).
- Machine à états (`acknowledgeAlert`/`resolveAlert`) : `PENDING → ACKNOWLEDGED → RESOLVED`, résolution directe depuis `PENDING` sans passer par `ACKNOWLEDGED`, refus de rouvrir une alerte `RESOLVED` (état terminal).
- `getPendingAlerts` exclut les alertes résolues.
- `PATCH /api/alerts/[id]/acknowledge`/`resolve` : 401 non authentifié, 404 sur une alerte d'un autre tenant **et** sur une alerte rattachée à une agence à laquelle un MEMBER n'est pas rattaché (agencyId non nul), cycle complet acquittement → résolution via HTTP, refus (409) de résoudre une alerte déjà résolue.
- `GET /api/alerts` : filtrage par `priority`/`status`, rejet (400) d'un `status` invalide.

Limite connue, partagée avec les autres suites HTTP : dépendance à un serveur `next dev` démarré pour la durée de la suite (port 3811).

### Tests module clients (Sprint 8)

`src/__tests__/clients.test.ts` prolonge l'approche « intégration HTTP réelle » des suites précédentes.

Couverture :
- Création : refus (401) non authentifié, refus (400) `name` manquant, création réussie rattachée au tenant de l'utilisateur connecté ; **contrairement à `Vehicle`/`Location`, un `MEMBER` peut créer un client sans rattachement à une agence** (pas de champ `agencyId` sur `Client`, DOMAINRULES.md section 9), vérifié explicitement.
- Isolation multi-tenant : `GET /api/clients` ne retourne jamais les clients d'un autre tenant ; `GET`/`PATCH /api/clients/[id]` retournent 404 sur un client d'un autre tenant.
- Recherche : `GET /api/clients?search=...` filtre par nom/email (insensible à la casse).
- Modification : `PATCH /api/clients/[id]` met à jour nom/email/téléphone ; refus (400) d'un `name` vide.
- Suppression : autorisée pour un client sans location ; refusée (409, `ClientHasLocationsError`) pour un client ayant au moins une location associée — même principe testé que `DELETE /api/vehicles/[id]` (Sprint 5).

Limite connue, partagée avec les autres suites HTTP : dépendance à un serveur `next dev` démarré pour la durée de la suite (port 3811).

### Tests utilisateurs, invitations, audit et résolution de tenant (Sprint 9)

`src/__tests__/{password-policy,users,invitations,audit,e2e}.test.ts` et l'extension de `src/__tests__/auth.test.ts` prolongent l'approche « intégration HTTP réelle » des suites précédentes (sauf `password-policy.test.ts`, unitaire pur, aucun serveur requis).

Couverture `users.test.ts` :
- `PATCH`/`DELETE /api/users/[id]` réservés ADMIN (403 pour un MEMBER), isolation multi-tenant (404 sur un user d'un autre tenant).
- **Garde « dernier ADMIN »** : rétrogradation et suppression du dernier `ADMIN` d'un tenant refusées (409, `LastAdminError`), y compris quand l'action porte sur soi-même.
- Réinitialisation de mot de passe par un ADMIN : validée par `validatePassword` (400 si non conforme), connexion possible avec le nouveau mot de passe après réinitialisation.
- Suppression : nettoyage effectif des `UserAgency` associées (vérifié directement via Prisma après suppression).

Couverture `invitations.test.ts` :
- `POST /api/invitations` réservé ADMIN, refuse un email déjà utilisateur du tenant (409).
- `GET /api/invitations/[id]` public (pas de session requise), n'expose que des champs non sensibles.
- `POST /api/invitations/[id]/accept` : crée le user avec l'email et le rôle de l'invitation, **ignore tout email fourni par le client** (vérifié explicitement) ; refuse une invitation déjà acceptée (409), expirée (410, avec passage automatique au statut `EXPIRED`), ou un mot de passe non conforme (400).
- `POST /api/invitations/[id]/decline` marque l'invitation `DECLINED`.
- `DELETE /api/invitations/[id]` (révocation) réservé ADMIN et tenant-scopé (404 sur une invitation d'un autre tenant, voir `e2e.test.ts`).

Couverture `audit.test.ts` :
- `logAction` insère une entrée lors d'un changement de rôle et lors de la création d'une invitation.
- `GET /api/audit` : 401 non authentifié, 403 pour un MEMBER, isolation multi-tenant (jamais de log d'un autre tenant).

Couverture de l'extension de `auth.test.ts` (résolution du tenant à la connexion, Option B) :
- Deux tenants enregistrés avec le même email + mot de passe → `POST /api/auth/login` sans `tenantId` renvoie `{ requiresTenantSelection: true, tenants: [...] }`, **aucun cookie de session posé**.
- Fourniture explicite de `tenantId` → connexion réussie au tenant précis.
- Mot de passe invalide sur un email partagé → 401 générique, sans jamais révéler la liste des tenants (vérifié explicitement, cohérent avec SECURITY.md section 3).
- **Piège découvert pendant ce sprint** : `signIn()` de NextAuth (appelé côté serveur) sérialise ses options via `URLSearchParams`, qui coerce une valeur `undefined` en la chaîne littérale `"undefined"` — passer `tenantId: undefined` directement cassait silencieusement le lookup tenant-scopé (l'`authorize()` cherchait un tenant `"undefined"` inexistant). Corrigé en n'incluant la clé `tenantId` dans les options que lorsqu'elle est réellement définie (`src/app/api/auth/login/route.ts`).

Couverture `e2e.test.ts` :
- Scénario complet : inscription → agence → véhicule → client → location → facture → paiement (facture `PAID`) → rapport de revenu (`/api/reports/revenue`) → invitation d'un second utilisateur → acceptation → connexion du nouvel utilisateur.
- Sécurité ciblée sur les nouvelles surfaces Sprint 9 : un ADMIN ne peut ni lire ni modifier un user d'un autre tenant (404), ni révoquer l'invitation d'un autre tenant (404) ; un MEMBER reçoit 403 sur `/api/audit`, `/api/invitations` (GET) et `PATCH /api/users/[id]`.

Limite connue, partagée avec les autres suites HTTP : dépendance à un serveur `next dev` démarré pour la durée de la suite (port 3811). Limite propre à ce sprint (**levée au Sprint 10**, voir ci-dessous) : le journal d'audit n'était testé que sur les actions instrumentées (rôle/suppression user, invitations) — pas de test généralisé sur le reste du CRUD.

### Tests Sprint 10 (audit exhaustif, profil, sécurité consolidée, E2E complet)

Extension de `src/__tests__/audit.test.ts`, `users.test.ts`, `reports.test.ts` et nouveau fichier `e2e-full.test.ts`, tous dans la continuité de l'approche « intégration HTTP réelle contre un vrai serveur `next dev` de test » des suites précédentes.

Couverture de l'extension de `audit.test.ts` :
- Un nouveau describe (« Journal d'audit exhaustif sur le CRUD métier ») vérifie qu'une entrée `AuditLog` est bien créée, avec la bonne `action`, pour chaque étape du cycle création → modification → suppression sur `Vehicle` et `Client`, et pour le cycle complet `Location` → `Invoice` → `Payment` → `Maintenance` → `Alert` (création, changement de statut le cas échéant, acquittement/résolution pour les alertes).
- Cas volontairement vérifié comme *négatif* : une `Maintenance` `COMPLETED` n'est pas supprimable (règle Sprint 7, historique conservé) — aucune entrée `maintenance.deleted` n'est donc attendue pour cette tentative, et le test ne l'assert pas.

Couverture de l'extension de `users.test.ts` (`GET`/`PATCH /api/users/me`) :
- `GET` : 401 non authentifié, 200 avec le profil de l'user connecté (lecture directe en base, pas la session).
- `PATCH` : 401 non authentifié ; un user peut modifier son propre nom ; **aucun autre user n'est jamais affecté** (vérifié explicitement via Prisma après une tentative de modification par un autre user — la route n'accepte de toute façon aucun id cible, donc ce test documente une garantie structurelle plutôt qu'un contrôle d'accès à proprement parler) ; email déjà utilisé dans le tenant → 409 ; changement de mot de passe sans `currentPassword` → 400 ; `currentPassword` incorrect → 400 ; changement de mot de passe réussi avec le bon `currentPassword`, vérifié par une connexion effective avec le nouveau mot de passe.

Couverture de l'extension de `reports.test.ts` (gap de couverture comblé pendant la revue de sécurité Sprint 10) :
- `GET /api/reports/revenue` et `GET /api/reports/vehicles` : 401 non authentifié, 403 pour un MEMBER, 200 pour un ADMIN — ces routes n'étaient auparavant testées qu'au niveau des fonctions `src/lib/reports.ts` directement, jamais au niveau HTTP, donc l'enforcement du rôle ADMIN sur la route elle-même n'était jamais vérifié par un test.

Couverture `e2e-full.test.ts` :
- Scénario complet : inscription de deux tenants partageant le même email admin → connexion sans `tenantId` (email ambigu → `requiresTenantSelection: true`, aucun cookie de session posé, liste jamais révélée avec un mauvais mot de passe) → connexion avec `tenantId` explicite (Option B, Sprint 9) → agence → véhicule → client → location (création + transition `CONFIRMED`) → facture → paiement (facture `PAID`) → maintenance (création + `COMPLETED`) → alerte (créée directement via `createAlert`, comme le ferait `scheduled-tasks.ts` ; acquittée puis résolue via les routes API) → rapport de revenu → édition du profil de l'admin (`PATCH /api/users/me`) → vérification finale que `GET /api/audit` contient bien une entrée pour chacune des actions du scénario (`vehicle.created`, `location.created`, `location.status_changed`, `invoice.created`, `payment.created`, `maintenance.created`, `maintenance.status_changed`, `alert.acknowledged`, `alert.resolved`, `user.profile_updated`) et que toutes les entrées sont scopées au tenant connecté.
- Distinct de `e2e.test.ts` (Sprint 9, toujours en place) : ce dernier reste plus court (pas de sélection de tenant, pas de maintenances/alertes/profil/vérification d'audit) et conserve son propre bloc de sécurité ciblé sur les surfaces Sprint 9 — les deux fichiers sont complémentaires, pas redondants.

Limite connue, partagée avec les autres suites HTTP : dépendance à un serveur `next dev` démarré pour la durée de la suite (port 3811).

### Tests Sprint 11 (rafraîchissement de session, sprint de consolidation)

Extension de `src/__tests__/users.test.ts` et `tenants.test.ts`, même approche « intégration HTTP réelle contre un vrai serveur `next dev` de test ».

Couverture de l'extension de `users.test.ts` :
- Nouveau test (« GET/PATCH /api/users/me (Sprint 10) ») : reproduit exactement ce que fait `useSession().update()` côté client, sans passer par React — `GET /api/auth/session` (état initial) → `PATCH /api/users/me` (changement de nom) → `GET /api/auth/session` **sans** update explicite (vérifie que le nom reste l'ancien : garde de non-régression contre un retour silencieux au comportement pré-Sprint 11) → `GET /api/auth/csrf` (jeton + cookie CSRF) → `POST /api/auth/session` avec ce jeton (déclenche `trigger: "update"` dans le callback `jwt()`) → vérifie que la réponse contient déjà le nouveau nom, puis qu'un `GET /api/auth/session` avec le cookie de session rafraîchi (renvoyé par le `POST`) le confirme.

Couverture de l'extension de `tenants.test.ts` :
- Le describe `POST /api/tenants` (2 tests : refus MEMBER, création par ADMIN) est remplacé par un unique test vérifiant que `POST /api/tenants` renvoie désormais `405 Method Not Allowed` — garde de non-régression contre la réintroduction accidentelle de cette route (voir HANDOFF.md point 36 : elle créait des tenants orphelins, jamais rattachés à aucun user).

Vérification manuelle complémentaire (hors suite Vitest, contre un serveur `next dev` réel via `curl`) : le scénario complet SSR (inscription → `GET /dashboard`, nom affiché dans le `Header` → `PATCH /api/users/me` → `GET /dashboard` toujours avec l'ancien nom, sans update → échange CSRF + `POST /api/auth/session` → `GET /dashboard` avec le nouveau nom, sans reconnexion) a été rejoué pour confirmer que le comportement observable dans l'application réelle correspond bien à ce que teste `users.test.ts` au niveau HTTP.

### Tests Sprint 12A (formulaires professionnels complets)

Extension de `agencies.test.ts`, `vehicles.test.ts`, `clients.test.ts`, `locations.test.ts` (18 nouveaux tests), même approche « intégration HTTP réelle contre un vrai serveur `next dev` de test ». Aucun nouveau fichier de test : les nouveaux champs prolongent les modules déjà couverts.

- `agencies.test.ts` : persistance des nouveaux champs (`city`/`address`/`phone`/`email`/`managerName`/`managerPhone`) à la création et en `PATCH` sans exiger `name` ; rétrocompatibilité d'une création minimale (`name` seul) — les nouveaux champs restent `null`.
- `vehicles.test.ts` : persistance de la fiche technique complète (`color`/`doors`/`seats`/`transmission`/`fuel`/`horsepower`/`powerKW`/`engineSize`/`ac`/`gps`/`chassisNumber`/`imageUrl`) ; rétrocompatibilité d'une création minimale ; validation `transmission`/`fuel` invalides (400) et valeur numérique négative (400) ; `PATCH` peut positionner puis effacer (`null`) un champ optionnel.
- `clients.test.ts` : `name` dérivé de `firstName`/`lastName` quand `name` n'est pas fourni explicitement (à la création et en `PATCH`, resynchronisé si `firstName`/`lastName` changent) ; refus si ni `name` ni `firstName`/`lastName` ; persistance des champs identité/permis/adresse (`idType`/`idNumber`/`licenseNumber`/`licenseIssueDate`/`licenseExpiryDate`/`address`/`city`/`country`/`altPhone`/`notes`) ; validation `idType` invalide (400).
- `locations.test.ts` : persistance de `startOdometer`/`endOdometer`/`deposit` ; validation kilométrage négatif (400) ; `PATCH` peut enregistrer le kilométrage de retour après création ; **règle de calcul des jours vérifiée avec heure** — un dépassement, même d'une minute, compte comme un jour supplémentaire (`Math.ceil`, minimum 1 jour, règle déjà en place depuis le Sprint 5 et simplement revérifiée avec des horaires non ronds, voir DOMAINRULES.md section 14).

Vérification manuelle complémentaire (hors suite Vitest, contre un serveur `next dev` réel, pilotée par un script Playwright headless) : inscription → connexion → parcours complet des 4 formulaires de création (`/dashboard/agencies/new`, `/dashboard/vehicles/new`, `/dashboard/clients/new`, `/dashboard/locations/new`) avec tous les nouveaux champs remplis, y compris le composant téléphone à indicatif pays (`PhoneInput`) et l'aperçu du nombre de jours en temps réel sur le formulaire de location — chaque soumission redirige vers la liste correspondante (le formulaire de location redirige vers le détail de la location créée, cohérent avec le comportement existant depuis le Sprint 5) ; aucune erreur console au-delà d'un artefact de vitesse d'automatisation identifié et écarté (remplissage de champ avant la fin de l'hydratation React, reproductible à l'identique sur une page non modifiée par ce sprint) ; données de test nettoyées après vérification.

### Tests Sprint 12B (facturation automatique, correctif déconnexion, invitations)

Aucun nouveau fichier de test ni nouveau test ajouté : ce sprint modifie un comportement transverse déjà couvert (création de location, suppression de location) plutôt que d'ajouter un module métier. La suite existante (224/224) a néanmoins nécessité une correction dans 3 fichiers, révélée en la faisant tourner :

- `clients.test.ts`, `locations.test.ts`, `vehicles.test.ts` : leur nettoyage `afterAll` supprimait les `Location` de test avant les `Invoice`, désormais toujours présentes (une facture `DRAFT` est générée automatiquement à la création de chaque location, voir HANDOFF.md section 1) — violation de contrainte de clé étrangère (`Invoice_locationId_fkey`). Corrigé en insérant `prisma.payment.deleteMany`/`prisma.invoice.deleteMany` avant `prisma.location.deleteMany`, même ordre que `invoices.test.ts`/`payments.test.ts`/`e2e*.test.ts`/`audit.test.ts` qui géraient déjà ce cas (ces fichiers créaient déjà des factures explicitement).
- `locations.test.ts` (tests existants, sans ajout) : les deux tests `DELETE /api/locations/[id]` (suppression d'une location `PENDING`, refus sur une location `CONFIRMED`) échouaient en 500 pour la même raison au niveau applicatif, pas seulement au niveau du nettoyage de test — voir « Correctif appliqué » ci-dessous.

**Correctif appliqué en cours de sprint (pas une décision produit, une régression introduite par la génération automatique de facture puis corrigée avant la fin du sprint)** : `deleteLocation` (`src/lib/locations.ts`) supprime désormais explicitement, dans une transaction, les `Invoice` liées avant la `Location` elle-même — mais uniquement si elles sont encore `DRAFT` sans paiement (`amountPaid === 0`), même règle que `deleteInvoice`. Si une facture est allée au-delà (`SENT`/`PARTIALLY_PAID`/`PAID`) ou a reçu un paiement, la suppression de la location est bloquée (409, nouvelle erreur `LocationHasInvoiceError`) plutôt que de perdre silencieusement un document financier réel.

Vérification manuelle complémentaire (hors suite Vitest, contre un serveur `next dev` réel, requêtes `curl` — aucun outil de navigateur automatisé disponible dans cette session, voir section 1) : inscription → connexion → agence → véhicule → client → `POST /api/locations` → réponse contenant la facture `DRAFT` générée automatiquement (`INV-2026-00001`, montant = `totalPrice`) → `/dashboard/locations/[id]` affiche le bouton « Voir facture » → `GET /api/invoices/[id]/pdf` renvoie un PDF (200, template inchangé depuis le Sprint 6) → `DELETE /api/locations/[id]` réussit (200, la facture `DRAFT` sans paiement est supprimée avec la location) → déconnexion (`POST /api/auth/logout`, 200) ; données de test nettoyées après vérification. Le clic réel sur le menu utilisateur du `Header` (reproduction du bug Base UI corrigé, voir HANDOFF.md) n'a pas pu être exercé en interaction navigateur faute d'outil d'automatisation disponible dans cette session — le correctif suit néanmoins exactement l'anatomie documentée de `@base-ui/react` (`node_modules/@base-ui/react/docs/react/components/menu.md`, section « Anatomy » : `<Menu.GroupLabel>` toujours enfant de `<Menu.Group>`) et compile sans erreur TypeScript.

### Tests Sprint 12C (réservations, permissions, design, rapports, audit, profil)

Deux nouveaux fichiers (`reservations.test.ts`, `permissions.test.ts`) et extension de `clients.test.ts`/`users.test.ts` — 39 nouveaux tests, même approche « intégration HTTP réelle contre un vrai serveur `next dev` de test ».

- `reservations.test.ts` : CRUD (champs requis, refus `endDate < startDate`, statut `PENDING`/devise `MAD` par défaut) ; isolation multi-tenant (`GET`) ; machine à états (`PENDING→CONFIRMED` autorisé, `CONFIRMED→PENDING` refusé 409) ; suppression restreinte à `PENDING`/`CANCELLED` ; **import Excel** : un fichier `.xlsx` généré en mémoire avec `exceljs` (mêmes en-têtes que `RESERVATION_IMPORT_COLUMNS`) est envoyé en `multipart/form-data` — lignes valides importées, ligne avec `clientLastName` manquant rapportée en erreur, ligne avec un `voucherNumber` déjà existant comptée comme doublon et non réimportée, `mode: "preview"` ne persiste rien, fichier non `.xlsx` refusé (400) ; **conversion en contrat** : `vehicleId` requis, conversion réussie crée `Location`+`Invoice` et marque `CONVERTED` (`convertedLocationId` = id de la location), reconversion d'une réservation déjà `CONVERTED` refusée (409), doublon client détecté par téléphone à la conversion (409 `{ duplicate }`) puis résolu avec `useExistingClientId` (la location créée référence bien le client existant). Chaque test de conversion utilise des dates non chevauchantes sur le même véhicule pour ne pas déclencher accidentellement `VehicleNotAvailableError` à la place de l'assertion réellement visée.
- `permissions.test.ts` : `GET /api/permission-groups` (401/403/200, les 4 groupes par défaut sont bien créés à l'inscription, le groupe `MEMBER` contient `reservations.view` mais pas `reservations.delete`) ; `POST`/`PATCH`/`DELETE /api/permission-groups/[id]` (création, refus d'un nom déjà utilisé — 409, modification nom+permissions, isolation multi-tenant — 404, suppression bloquée tant qu'un user est rattaché — 409, puis autorisée après réassignation) ; `GET`/`PATCH /api/users/[id]/permissions` — **vérifie l'application réelle, pas seulement le CRUD** : un `MEMBER` sans groupe ni permission individuelle reçoit 403 sur `POST /api/reservations` ; assigner le groupe `MEMBER` accorde `reservations.create` (201) mais pas `reservations.delete` (403, absent du groupe par défaut) ; une permission individuelle (`reservations.view` seul) accorde la lecture mais pas la création (additif, jamais un retrait) ; un `ADMIN` a toujours accès à tout indépendamment de son groupe/ses permissions individuelles (bypass vérifié directement via une requête réelle).
- `clients.test.ts` (extension) : doublon exact par email, par téléphone (après normalisation des espaces/tirets), par `idNumber` (409, `matchType: "exact"`) ; doublon probable par similarité de nom, distance de Levenshtein < 3 (409, `matchType: "fuzzy"`) ; `useExistingClientId` réutilise le client et met à jour son téléphone ; `forceCreate` crée quand même un nouveau client, avec une note ajoutée automatiquement.
- `users.test.ts` (extension) : `PATCH /api/users/me` accepte et persiste `phone`/`avatar` ; refuse un `avatar` qui n'est pas une URL `http(s)://` (400).

**Correctif de nettoyage nécessaire sur 16 fichiers de test existants** (pas un nouveau test, une conséquence mécanique d'un comportement transverse ajouté ce sprint) : `POST /api/auth/register` crée désormais automatiquement les 4 `PermissionGroup` par défaut pour chaque nouveau tenant (`ensureDefaultGroups`) ; le nettoyage `afterAll` de `agencies.test.ts`, `alerts.test.ts`, `audit.test.ts`, `auth.test.ts`, `clients.test.ts`, `e2e.test.ts`, `e2e-full.test.ts`, `invitations.test.ts`, `invoices.test.ts`, `locations.test.ts`, `maintenances.test.ts`, `payments.test.ts`, `reports.test.ts`, `tenants.test.ts`, `ui.test.tsx`, `vehicles.test.ts` supprimait le `Tenant` avant ses `PermissionGroup`, violant `PermissionGroup_tenantId_fkey` (`GroupPermission` est en cascade sur `groupId`, donc aucun nettoyage supplémentaire n'était nécessaire pour cette table). Corrigé en insérant `prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } })` avant chaque `prisma.tenant.deleteMany(...)`. `db.test.ts` n'a pas nécessité de correctif : ses tenants sont créés directement via `prisma.tenant.create`, pas via `/api/auth/register`, donc sans groupes de permissions associés.

Vérification (hors suite Vitest) : aucun outil d'automatisation navigateur disponible dans cette session (comme le Sprint 12B) — voir HANDOFF.md et la ligne « Vérification (Sprint 12C) » du tableau section 1 pour le détail de ce qui a été couvert par les 263 tests d'intégration HTTP à la place d'une interaction navigateur réelle.

### Tests de concurrence
Vérifieront le comportement du système en cas d'accès concurrent à une même ressource (ex. deux réservations simultanées sur le même véhicule). Aucun test de concurrence n'existe à ce jour.

### Tests de charge
Vérifieront le comportement du système sous charge réaliste avant mise en production. Aucun test de charge n'existe à ce jour, et aucun environnement de staging n'est encore disponible pour les exécuter.

### Tests de sécurité
S'appuieront sur les principes de l'OWASP WSTG définis dans [SECURITY.md](./SECURITY.md) section 22. Aucun test de sécurité n'existe à ce jour.

### Tests de régression
Chaque correction de bug ou d'incident (voir [INCIDENTS.md](./INCIDENTS.md)) devra être accompagnée d'un test de non-régression avant clôture de l'incident. Aucun test de régression n'existe à ce jour, faute d'incident enregistré.

## 4. Format attendu des futurs rapports

Chaque exécution future de la suite de tests devra être consignée dans ce document (ou dans un rapport daté associé) selon le format suivant :

```
## Rapport du <date>

Environnement : <dev|test|staging|production>
Commande exécutée : <commande>

| Type de test | Nombre exécuté | Réussis | Échoués | Ignorés |
|---|---|---|---|---|
| Unitaires | | | | |
| Intégration | | | | |
| End-to-end | | | | |
| Sécurité | | | | |

Échecs notables : <description ou "aucun">
Actions de suivi : <description ou "aucune">
```

Ce format sera ajusté une fois les outils de test choisis (**À DÉCIDER**).
