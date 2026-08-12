# TESTREPORT.md — Suivi des tests

Ce document fait le point sur les tests réellement exécutés à ce jour et définit la stratégie de test future. Un framework de test (Vitest) est installé depuis le Sprint 2 et couvre l'isolation multi-tenant de la couche d'accès aux données ; depuis le Sprint 5, il couvre également le premier module métier (véhicules, locations) ; depuis le Sprint 6, la facturation, les paiements et les rapports — voir section 3.

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

**Premier test métier disponible depuis le Sprint 5** (véhicules, locations) — jusqu'ici, aucun module métier n'existait dans le code (voir [HANDOFF.md](./HANDOFF.md) et [PROJECT_MAP.md](./PROJECT_MAP.md)). La couche d'accès aux données technique (`src/lib/db.ts`), l'authentification, le CRUD tenants/agences et désormais véhicules/locations disposent de tests d'isolation multi-tenant et multi-agence.

## 2. Tests disponibles et non encore disponibles

- Framework installé : **Vitest** (`npm run test`), choisi en Sprint 2 pour sa compatibilité native avec TypeScript/ESM et Next.js 16.
- Base de test dédiée : **`xrent_test`**, distincte de `xrent_dev`. `vitest.config.mts` charge `DATABASE_URL` depuis `.env.test` via `loadEnv` de Vite (mode `test`) ; la migration `init_tenant_agency_user` y est appliquée via `prisma migrate deploy`.
- Tests disponibles : isolation multi-tenant de la couche d'accès aux données (`src/__tests__/db.test.ts`, section 3 « Tests multi-tenant ») ; tests métier véhicules/locations depuis le Sprint 5 (section 3 « Tests métier véhicules et locations (Sprint 5) ») ; tests métier facturation/paiements/rapports depuis le Sprint 6 (section 3 « Tests facturation, paiements et rapports (Sprint 6) »).
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
