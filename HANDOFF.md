# HANDOFF.md — Transmission du projet

Document destiné à toute personne (ou assistant IA) reprenant le projet, pour comprendre rapidement où en est XRent Manager sans avoir à relire tout l'historique.

Dernière mise à jour : 2026-08-12 — Sprint 7 (maintenance + alertes + notifications) validé : modèles `Maintenance`/`Alert`, CRUD API + dashboard complets (maintenances), liste triée priorité+date + acknowledge/resolve (alertes), génération automatique d'alertes via `src/lib/scheduled-tasks.ts`/`POST /api/tasks/check-alerts` (réservé ADMIN, scopé au tenant), badge d'alertes dans le header, widgets « À faire aujourd'hui »/« Alertes récentes » sur le dashboard, alertes in-app uniquement (pas d'email, pas de prestataire SMTP), isolation multi-tenant/multi-agence testée (133/133 tests).

## 1. État actuel

Le projet est au stade **Sprint 7 — maintenance des véhicules et alertes/notifications**. Le dépôt contient désormais, en plus des sprints précédents :

- `prisma/schema.prisma` : modèles `Maintenance`, `Alert` + enums `MaintenanceType`/`MaintenanceStatus`/`AlertType`/`AlertPriority`/`AlertStatus`, migration `20260812090456_add_maintenance_and_alert_models` appliquée sur `xrent_dev` et `xrent_test` ;
- `src/lib/{maintenances,alerts,scheduled-tasks}.ts` : couche métier (CRUD maintenances avec machine à états et historique conservé, CRUD alertes sans suppression avec machine à états acknowledge/resolve, génération idempotente d'alertes par tenant), toujours scopée `tenantId` (+ `agencyId` dérivé du `Vehicle` pour les maintenances) ;
- routes API `/api/maintenances*` (CRUD), `/api/alerts` (liste filtrable) + `/api/alerts/[id]/{acknowledge,resolve}` (aucune route `POST`/`DELETE` pour les alertes — créées par le système uniquement, jamais supprimables), `/api/tasks/check-alerts` (`POST`, réservé ADMIN, scopé au tenant connecté) — toutes vérifient tenant + appartenance à l'agence côté serveur ;
- pages `/dashboard/maintenances*` (liste avec filtres statut/type/véhicule/dates, actions modifier/terminer/annuler, création) et `/dashboard/alerts` (liste triée priorité puis date, filtres type/priority/status, actions acknowledge/resolve) branchées sur ces routes ;
- `Header.tsx` : badge d'alertes en attente (nombre calculé côté serveur dans `dashboard/layout.tsx`, lien vers `/dashboard/alerts`) ; `dashboard/page.tsx` : widgets « À faire aujourd'hui » (retours du jour, maintenances dues, factures en retard) et « Alertes récentes » ;
- `src/__tests__/{maintenances,alerts}.test.ts` : 27 nouveaux tests (CRUD, machine à états, historique conservé, génération d'alertes idempotente, acknowledge/resolve, filtrage priorité/status, isolation multi-tenant/multi-agence) — 133/133 tests passés au total ;
- `npm run lint` / `npm run test` / `npm run build` validés, plus une vérification manuelle contre un serveur `next dev` réel (voir section 2).

### Sprint 6 (rappel)

- `prisma/schema.prisma` : modèles `Invoice`, `Payment` + enums `InvoiceStatus`/`PaymentMethod`, migration `20260811205048_add_invoice_and_payment_models` appliquée sur `xrent_dev` et `xrent_test` ;
- `src/lib/{invoices,payments,reports}.ts` : couche métier (CRUD, génération de numéro de facture, calcul TVA/remise/total, machine à états `canTransition`, `recomputeInvoiceStatus`, `getRevenueReport`/`getVehicleUtilizationReport`/`getTopVehicles`), toujours scopée `tenantId` (+ `agencyId` dérivé de la `Location`/`Invoice` ciblée) ;
- routes API `/api/invoices*` (CRUD + `/[id]/pdf`), `/api/payments*` (CRUD), `/api/reports/{revenue,vehicles}` (réservées `ADMIN`) — toutes vérifient tenant + appartenance à l'agence côté serveur ;
- pages `/dashboard/invoices*` (liste avec filtres, création depuis une location, détail avec téléchargement PDF/enregistrement de paiement/changement de statut), `/dashboard/payments` (liste avec filtres), `/dashboard/reports` (KPIs, graphiques `recharts`, export CSV `papaparse`, réservée ADMIN) branchées sur ces routes ;
- `src/components/invoices/InvoicePdf.tsx` : template PDF (`@react-pdf/renderer`), sans logo (aucun asset de marque n'existe dans le dépôt) ;
- `src/__tests__/{invoices,payments,reports}.test.ts` : 30 nouveaux tests (CRUD, numérotation, calcul TVA/remise, machine à états, validation solde restant, recalcul automatique du statut de facture, rapports, isolation multi-tenant/multi-agence) — 106/106 tests passés au total ;
- `npm run lint` / `npm run test` / `npm run build` validés.

### Sprint 5 (rappel)

- `prisma/schema.prisma` : modèles `Client`, `Vehicle`, `Location` + enums `VehicleStatus`/`LocationStatus`, migration `20260811201341_add_vehicle_and_location_models` appliquée sur `xrent_dev` et `xrent_test` ;
- `src/lib/{vehicles,locations,clients}.ts` : couche métier (CRUD, `checkAvailability`, `calculateTotalPrice`, machine à états `canTransition`), toujours scopée `tenantId` (+ `agencyId` pour véhicules/locations) ;
- `src/lib/authz.ts` étendu : `canAccessAgency()` et `getAccessibleAgencyIds()`, centralisant une vérification auparavant dupliquée (agencies) et désormais réutilisée par vehicles/locations — **corrige au passage une lacune de sécurité découverte pendant ce sprint, voir section 6** ;
- routes API `/api/vehicles*` (CRUD + `/[id]/availability`), `/api/locations*` (CRUD), `/api/clients` (liste/création minimale) — toutes vérifient tenant + appartenance à l'agence côté serveur ;
- pages `/dashboard/vehicles*` et `/dashboard/locations*` (liste avec filtres, création, détail/édition, actions de changement de statut/annulation) branchées sur ces routes ; pas de page `/dashboard/clients` dédiée (sélection/création inline uniquement) ;
- `src/__tests__/{vehicles,locations}.test.ts` : 30 nouveaux tests (CRUD, disponibilité/conflits, pricing, machine à états, isolation multi-tenant/multi-agence) — 76/76 tests passés au total ;
- `npm run lint` / `npm run test` / `npm run build` validés ; parcours complet vérifié manuellement contre un serveur `next dev` réel (inscription → agence → véhicule → client → location → pages dashboard), données de test nettoyées après vérification.
- Correctif post-Sprint 5 (même date) : devise par défaut changée de `"EUR"` à `"MAD"` (migration `20260811203931_change_default_currency_to_mad`).

### Sprint 4 (rappel)

- shadcn/ui (style `base-nova`, composants `@base-ui/react`) initialisé, composants ajoutés : `button`, `input`, `label`, `card`, `table`, `dialog`, `dropdown-menu`, `avatar`, `badge`, `skeleton`, `sonner` ; ré-exportés depuis `src/components/ui/index.ts` ;
- `@tanstack/react-table` en version **9** (réécriture majeure vs. v8, voir `node_modules/@tanstack/react-table/skills/migrate-v8-to-v9/SKILL.md`) — `useTable` + `tableFeatures()` (pas `useReactTable`), encapsulé dans `src/components/layout/DataTable.tsx` (tri, pagination) ;
- `lucide-react` pour les icônes ;
- pages d'authentification `src/app/(auth)/login/page.tsx` et `register/page.tsx` (layout dédié centré, sans sidebar) : login via `signIn` client (`next-auth/react`), register via `POST /api/auth/register` ;
- coquille dashboard `src/components/layout/{Sidebar,Header,DashboardLayout}.tsx` + `src/app/dashboard/layout.tsx` (Server Component, résout la session et le tenant côté serveur, redirige vers `/login` si non authentifié — défense en profondeur en plus de `src/proxy.ts`) ;
- pages `/dashboard` (stats), `/dashboard/tenants` (+ `new`, `/[id]`), `/dashboard/agencies` (+ `new`, `/[id]`), `/dashboard/settings` — toutes branchées sur les routes API existantes (Sprint 3), aucune nouvelle route API mutante créée pour ces domaines ;
- `/dashboard/users` : **lecture seule** (liste, aucune action modifier/supprimer/changer le rôle) — décision explicite du propriétaire du projet en cours de sprint, voir section 6 ; nouvelle route `GET /api/users` (ADMIN uniquement, ne sélectionne jamais `passwordHash`) ;
- `src/lib/api.ts` (wrapper fetch), `src/hooks/{useUser,useTenant}.ts` (lecture client de la session/du tenant) ;
- `src/__tests__/ui.test.tsx` : tests d'intégration HTTP sur le rendu des pages (mêmes principes que les tests Sprint 3), voir [TESTREPORT.md](./TESTREPORT.md).

### Sprint 3 (rappel)

- authentification NextAuth.js (Auth.js) v5, sessions **JWT** (pas "database" — voir section 6 et [SECURITY.md](./SECURITY.md) section 5 pour la raison technique), fournisseur `CredentialsProvider` (email/password uniquement) ;
- `prisma/schema.prisma` étendu : `User.passwordHash` (nullable), `User.role` (`"ADMIN"` par défaut au premier user d'un tenant, `"MEMBER"` sinon), modèles `Account`/`Session`/`VerificationToken` de l'adaptateur Prisma (`@auth/prisma-adapter`, non utilisés pour les sessions actuelles — présents pour un futur ajout d'OAuth) ; migration `20260811141912_add_nextauth_models_and_user_auth_fields` appliquée sur `xrent_dev` et `xrent_test` ;
- routes API : `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, `/api/auth/[...nextauth]`, CRUD `/api/tenants`(`/[id]`) et `/api/agencies`(`/[id]`), toutes scopées serveur par tenant/agence/rôle ;
- `src/proxy.ts` (pas `middleware.ts` — déprécié et renommé dans cette version de Next.js, voir `node_modules/next/dist/docs/.../file-conventions/proxy.md`) : redirection optimiste vers `/login` pour `/dashboard` et `/settings` si non authentifié — les pages `/dashboard/*` existent désormais (Sprint 4), la protection est effectivement exercée ;
- tests d'intégration HTTP réels (`src/__tests__/auth.test.ts`, `tenants.test.ts`, `agencies.test.ts`) démarrant un vrai serveur `next dev` de test (voir [TESTREPORT.md](./TESTREPORT.md)).

### Sprints 0–2 (rappel) — socle hérité

- un socle Next.js 16.3.0 par défaut (généré via `create-next-app`, non modifié fonctionnellement) ;
- TypeScript, ESLint, Tailwind CSS v4, App Router, dossier `src/`, alias `@/*` ;
- la page d'accueil et le layout par défaut fournis par `create-next-app` (aucune page métier) ;
- Prisma 6.19.3 (`prisma`, `@prisma/client`) installé, connecté à PostgreSQL 17 local (`xrent_dev`) via `DATABASE_URL` dans `.env` (non versionné) ;
- un schéma `prisma/schema.prisma` avec 4 modèles minimaux : `Tenant`, `Agency`, `User`, `UserAgency` (aucun mot de passe, aucun rôle — voir section 6) ;
- une migration appliquée en développement : `20260811133155_init_tenant_agency_user` ;
- une couche d'accès aux données minimale (`src/lib/prisma.ts`, `src/lib/db.ts`) exposant `getTenantById`, `getAgencyById`, `getUserById`, chacune scopée par `tenantId` côté serveur ;
- Vitest installé comme framework de test (`npm run test`), configuré via `vitest.config.mts` (`loadEnv` de Vite, mode `test`) pour charger `.env.test` et exécuter les tests contre une base PostgreSQL de test dédiée `xrent_test`, distincte de `xrent_dev` ; migration `init_tenant_agency_user` également appliquée sur `xrent_test` ; premier test d'isolation multi-tenant (`src/__tests__/db.test.ts`) avec nettoyage systématique des données créées ;
- la documentation fondatrice du projet (ce document et les huit autres listés dans [README.md](./README.md)).

### Sprint 2 — Socle de données

- **Fait** : installation de Prisma, schéma minimal `Tenant`/`Agency`/`User`/`UserAgency`, migration `init_tenant_agency_user` appliquée sur `xrent_dev` puis sur `xrent_test` (base de test dédiée), couche d'accès aux données (`src/lib/prisma.ts`, `src/lib/db.ts`), tests d'isolation multi-tenant (Vitest, `src/__tests__/db.test.ts`, exécutés contre `xrent_test` via `.env.test`/`loadEnv`), `npm run lint` / `npm run test` / `npm run build` validés.
- **Restreint volontairement** : aucun champ mot de passe, aucun champ rôle, aucune table d'audit, aucune authentification, aucune donnée applicative fictive — conformément à CLAUDE.md et aux contraintes explicites de cette sous-étape.
- **Pas encore fait** : voir sections 3 et 8 (rôles, authentification, audit, etc.) — la plupart désormais traités par le Sprint 3 ci-dessous, à l'exception de l'audit.

### Sprint 3 — Authentification et CRUD Tenant/Agency

- **Fait** :
  - NextAuth.js (Auth.js) v5 installé, sessions **JWT** (`src/lib/auth.ts`), `CredentialsProvider` email/password, hachage `bcryptjs` (coût 12).
  - `prisma/schema.prisma` : `User.passwordHash` (nullable), `User.role` (`"ADMIN"`/`"MEMBER"`), modèles adaptateur Prisma `Account`/`Session`/`VerificationToken` ; migration `20260811141912_add_nextauth_models_and_user_auth_fields` appliquée sur `xrent_dev` et `xrent_test`.
  - Routes : `POST /api/auth/register` (crée un tenant + son premier user, `ADMIN`), `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET|POST /api/auth/[...nextauth]` (handler NextAuth), `GET|POST /api/tenants`, `GET|PATCH|DELETE /api/tenants/[id]`, `GET|POST /api/agencies`, `GET|PATCH|DELETE /api/agencies/[id]` — toutes vérifient identité/rôle/tenant/agence côté serveur (`src/lib/authz.ts`).
  - `src/proxy.ts` : redirection optimiste vers `/login` pour `/dashboard*` et `/settings*` si non authentifié (les pages n'existaient pas encore à ce stade — protection posée en amont, effectivement exercée depuis le Sprint 4).
  - Tests d'intégration HTTP réels (37/37 passés) : `src/__tests__/auth.test.ts`, `tenants.test.ts`, `agencies.test.ts` — voir [TESTREPORT.md](./TESTREPORT.md).
  - `npm run lint` / `npm run test` / `npm run build` validés après ces ajouts.
- **Déviations documentées par rapport à l'énoncé initial du sprint** (voir section 6 pour le détail et la justification) :
  - Sessions **JWT**, pas "database" : incompatibilité technique vérifiée dans le code de NextAuth v5 entre `CredentialsProvider` et `session.strategy: "database"` ; arbitrage explicite du propriétaire du projet en faveur de JWT.
  - `GET /api/tenants` ne retourne jamais que le tenant de l'ADMIN connecté, jamais une liste de tous les tenants de la plateforme : aucun rôle "superadmin" transverse n'existe dans ce schéma (seul `ADMIN`, scopé à un tenant), et retourner tous les tenants violerait SECURITY.md section 1. Un futur rôle plateforme devra être explicitement validé avant d'élargir ce comportement (voir section 8).
- **Pas encore fait** : invitation d'utilisateurs supplémentaires dans un tenant existant, limitation du nombre de tentatives de connexion, réinitialisation de mot de passe, MFA, table d'audit, tout module métier (voir section 3).

### Sprint 4 — Dashboard admin et UI de base

- **Fait** :
  - shadcn/ui initialisé (`npx shadcn@latest init`, style `base-nova` sur `@base-ui/react`, pas Radix — différence à noter par rapport aux générations shadcn plus anciennes) ; composants ajoutés : `button`, `input`, `label`, `card`, `table`, `dialog`, `dropdown-menu`, `avatar`, `badge`, `skeleton`, `sonner`, ré-exportés depuis `src/components/ui/index.ts`.
  - `@tanstack/react-table` **v9** installé (réécriture majeure de l'API vs. v8 — `useTable`/`tableFeatures()` remplacent `useReactTable`/options `getXRowModel`, voir `node_modules/@tanstack/react-table/skills/migrate-v8-to-v9/SKILL.md`), encapsulé une seule fois dans `src/components/layout/DataTable.tsx` (tri par colonne, pagination).
  - `lucide-react` installé pour les icônes.
  - Pages d'authentification : `src/app/(auth)/layout.tsx`, `login/page.tsx` (formulaire + `signIn("credentials", …)` côté client via `next-auth/react`, gestion d'erreur, redirection `callbackUrl`/`/dashboard`), `register/page.tsx` (formulaire + `POST /api/auth/register`, redirection `/login`).
  - Coquille dashboard : `src/components/layout/{Sidebar,Header,DashboardLayout}.tsx` (sidebar responsive avec tiroir mobile, menu utilisateur avec déconnexion) + `src/app/dashboard/layout.tsx` (Server Component : résout `getSessionUser()`/`getTenantById()`, redirige vers `/login` si non authentifié).
  - Pages : `/dashboard` (stats agences/utilisateurs, actions rapides), `/dashboard/tenants` (+ `new`, `/[id]`), `/dashboard/agencies` (+ `new`, `/[id]`), `/dashboard/settings` (nom du tenant éditable ; profil utilisateur affiché en lecture seule, voir ci-dessous) — toutes branchées sur les routes API `/api/tenants*`/`/api/agencies*` du Sprint 3, sans aucune nouvelle route mutante.
  - `/dashboard/users` : **volontairement en lecture seule** (liste uniquement, aucune action modifier/supprimer/changer le rôle, bouton « Inviter » désactivé) — décision explicite du propriétaire du projet prise en cours de sprint (voir section 6), le sujet restant marqué À DÉCIDER (section 8, points 2 et 17). Nouvelle route `GET /api/users` (ADMIN uniquement, tenant-scopée, ne sélectionne jamais `passwordHash`).
  - `src/lib/api.ts` (wrapper `fetch` normalisant les erreurs `{ error }` des routes API), `src/hooks/{useUser,useTenant}.ts` (lecture client de la session/du tenant courant, indépendants d'un `SessionProvider` — `next-auth/react` v5 ne l'exige que pour `useSession`, pas pour `signIn`/`signOut`, vérifié dans `node_modules/next-auth/react.js`).
  - `src/__tests__/ui.test.tsx` (46/46 tests passés au total) : tests d'intégration HTTP sur le rendu des pages, dans la continuité des tests Sprint 3 — voir [TESTREPORT.md](./TESTREPORT.md) pour le détail, notamment la découverte que `redirect()` dans un Server Component en contexte de streaming renvoie un 200 + balise meta refresh, pas un 307 HTTP (à la différence de `src/proxy.ts`).
  - `npm run lint` / `npm run test` / `npm run build` validés après ces ajouts ; parcours complet (inscription → connexion → dashboard → création d'une agence → visualisation) vérifié manuellement via requêtes HTTP contre un serveur `next dev` local.
- **Non traité, faute de backend existant ou de décision préalable** (voir section 8) :
  - Modification de rôle et suppression d'utilisateurs depuis `/dashboard/users` (backend `PATCH`/`DELETE /api/users/[id]` non créé — décision explicite de ne pas construire cette logique sensible sans validation dédiée).
  - Édition du profil utilisateur (nom, email, mot de passe) depuis `/dashboard/settings` : aucune route de mutation du profil n'existe (`/api/auth/me` est en lecture seule) ; affiché en lecture seule avec une note explicite plutôt que construit sans validation de sécurité préalable (changement de mot de passe notamment).
  - Fuseau horaire d'agence dans `/dashboard/settings` : champ absent du schéma (`Agency.timezone` n'existe pas), donc non affiché — pas de champ fictif ajouté à l'UI.
  - Invitation effective d'un utilisateur dans un tenant existant (bouton présent mais désactivé).

### Sprint 5 — Véhicules et locations (premier module métier)

- **Fait** :
  - `prisma/schema.prisma` : modèles `Client` (`name`, `email?`, `phone?`, tenant-scopé, sans login), `Vehicle` (`agencyId` requis, `licensePlate` unique par tenant, `category` en texte libre, `status` enum `VehicleStatus`, `pricePerDay`/`currency`), `Location` (fusion réservation+contrat, `status` enum `LocationStatus`, `pricePerDay`/`totalPrice`/`currency`, `notes`) ; migration `20260811201341_add_vehicle_and_location_models` appliquée sur `xrent_dev` et `xrent_test`.
  - `src/lib/vehicles.ts` : `getVehicles`/`getVehicleById`/`createVehicle`/`updateVehicle`/`deleteVehicle` (bloqué si des locations existent, `VehicleHasLocationsError`), `checkAvailability` (chevauchement strict de périodes, seules `PENDING`/`CONFIRMED`/`ACTIVE` bloquent).
  - `src/lib/locations.ts` : CRUD, `calculateTotalPrice` (jours arrondis au jour supérieur × `pricePerDay`, snapshot du tarif véhicule à la création), machine à états `canTransition` (`PENDING→CONFIRMED|CANCELLED`, `CONFIRMED→ACTIVE|CANCELLED`, `ACTIVE→COMPLETED|CANCELLED`, `COMPLETED`/`CANCELLED` terminaux), suppression restreinte à `PENDING`/`CANCELLED`.
  - `src/lib/clients.ts` : `getClients`/`getClientById`/`createClient`, minimal (pas de `update`/`delete` — non nécessaires pour ce sprint).
  - `src/lib/authz.ts` étendu : `canAccessAgency(user, agencyId)` et `getAccessibleAgencyIds(user)`, centralisant et **renforçant** une vérification déjà présente mais dupliquée pour `agencies` (voir « Déviations » ci-dessous pour la faille corrigée).
  - Routes API : `GET|POST /api/vehicles`, `GET|PATCH|DELETE /api/vehicles/[id]`, `GET /api/vehicles/[id]/availability`, `GET|POST /api/locations`, `GET|PATCH|DELETE /api/locations/[id]`, `GET|POST /api/clients` — toutes vérifient tenant + appartenance à l'agence côté serveur ; `agencyId` d'une location toujours dérivé du véhicule côté serveur, jamais accepté depuis le client.
  - Pages dashboard : `/dashboard/vehicles` (liste + filtres statut/catégorie/agence + `VehiclesTable`), `/new`, `/[id]` (édition + tableau des locations associées) ; `/dashboard/locations` (liste + filtres statut/véhicule/client/dates + `LocationsTable` avec action « Annuler »), `/new` (sélection véhicule disponible, vérification de disponibilité en direct, calcul du prix estimé, sélection/création de client inline), `/[id]` (détail + `LocationActions` : transitions de statut affichées selon `canTransition`, édition des notes). Navigation ajoutée dans `Sidebar.tsx`.
  - `src/lib/format.ts` (`formatMoney`) : utilitaire partagé d'affichage des montants (entiers + devise).
  - `src/__tests__/vehicles.test.ts` et `locations.test.ts` (30 tests) : CRUD, immatriculation unique, disponibilité/conflits, calcul de prix, machine à états, isolation multi-tenant **et** multi-agence — 76/76 tests passés au total (voir [TESTREPORT.md](./TESTREPORT.md)).
  - `npm run lint` / `npm run test` / `npm run build` validés ; parcours complet vérifié manuellement contre un serveur `next dev` réel (inscription → agence → véhicule → client → location → 6 pages dashboard, toutes en 200), données de test nettoyées après vérification.
- **Décisions prises pendant ce sprint** (validées explicitement par le propriétaire du projet avant implémentation, voir section 6) :
  - `Location` fusionne réservation et contrat en une seule entité (au lieu de deux modèles séparés envisagés dans DOMAINRULES.md section 7/8).
  - Modèle `Client` distinct de `User` (le locataire externe n'est pas un compte staff avec identifiants de connexion).
  - `Vehicle.agencyId` obligatoire (pas de véhicule multi-agence ni sans agence).
  - Colonne `currency` (défaut `"MAD"`, changé depuis `"EUR"` peu après le Sprint 5 — voir section 6) ajoutée à côté de chaque montant, en cohérence avec la règle déjà validée en Sprint 1 (ARCHITECTURE.md), malgré l'absence de décision multi-devises définitive.
- **Faille de sécurité détectée et corrigée pendant ce sprint** (avant tout déploiement, révélée par un test d'isolation) : `canAccessAgency` ne vérifiait initialement que le rôle (`ADMIN` → accès accordé) sans jamais vérifier que l'agence ciblée appartenait bien au tenant de l'utilisateur. Un `ADMIN` du tenant A aurait pu, en fournissant un `agencyId` du tenant B, créer un véhicule ou une location rattachés à l'agence d'un autre tenant. Corrigé en ajoutant une vérification `agency.tenantId === user.tenantId` en tête de la fonction (`src/lib/authz.ts`) avant toute logique de rôle. Les routes `agencies/[id]` existantes n'étaient pas exploitables (elles vérifiaient déjà le tenant via `getAgencyById` avant d'appeler `canAccessAgency`), mais en bénéficient désormais aussi de façon défensive. Voir [TESTREPORT.md](./TESTREPORT.md) pour le test qui a révélé le problème.
- **Décision de granularité de rôle (provisoire, à confirmer explicitement)** : un `MEMBER` rattaché à une agence via `UserAgency` peut créer/modifier/supprimer les véhicules et locations de cette agence (pas seulement les consulter) — contrairement à `Tenant`/`Agency` où l'écriture reste réservée à `ADMIN`. Voir [DOMAINRULES.md](./DOMAINRULES.md) section 4 et section 8 point 21 ci-dessous.
- **Non traité, hors périmètre explicite du sprint** :
  - Page `/dashboard/clients` dédiée (recherche, historique, modification, fusion de doublons) — uniquement sélection/création inline depuis le formulaire de location.
  - Modèle `Category` dédié pour les véhicules — `category` reste un champ texte libre sur `Vehicle`.
  - Paiements, cautions, incidents de location, contenu détaillé de contrat (conditions générales, franchise) — toujours hors périmètre.
  - Gestion de la maintenance et de l'historique kilométrique des véhicules.

### Sprint 7 — Maintenance des véhicules et alertes/notifications

- **Fait** :
  - `prisma/schema.prisma` : modèle `Maintenance` (`vehicleId` requis, `agencyId`/`currency` dérivés du véhicule, `status` enum `MaintenanceStatus`, `type` enum `MaintenanceType`, `cost` entier optionnel), modèle `Alert` (`tenantId` requis, `agencyId`/`userId` optionnels, `type`/`priority`/`status` enums, `entityType`/`entityId` texte libre) ; migration `20260812090456_add_maintenance_and_alert_models` appliquée sur `xrent_dev` et `xrent_test`.
  - `src/lib/maintenances.ts` : CRUD, machine à états `canTransition` (`SCHEDULED→IN_PROGRESS|COMPLETED|CANCELLED`, `IN_PROGRESS→COMPLETED|CANCELLED`, `COMPLETED`/`CANCELLED` terminaux), édition/suppression bloquées une fois `COMPLETED`/`CANCELLED` (historique conservé, `MaintenanceNotEditableError`/`MaintenanceNotDeletableError`), `getDueMaintenances(tenantId, daysAhead)`, `createMaintenanceFromSchedule(tenantId, vehicleId, type, scheduledDate)` (signature ajustée avec `tenantId` en premier paramètre — déviation documentée, voir ci-dessous).
  - `src/lib/alerts.ts` : CRUD sans suppression (aucune fonction `deleteAlert`), machine à états `canTransition` (`PENDING→ACKNOWLEDGED|RESOLVED`, `ACKNOWLEDGED→RESOLVED`, `RESOLVED` terminal), `acknowledgeAlert`/`resolveAlert` (idempotent si déjà `ACKNOWLEDGED`), `getPendingAlerts(tenantId, userId?)` (alertes non résolues, tri par priorité).
  - `src/lib/scheduled-tasks.ts` : `checkDueMaintenances`/`checkReturnsToday`/`checkOverdueInvoices`, chacune scopée à un tenant, génération idempotente d'alertes (pas de doublon tant qu'une alerte non résolue existe déjà pour la même ressource `entityType`/`entityId`).
  - Routes API : `GET|POST /api/maintenances`, `GET|PATCH|DELETE /api/maintenances/[id]`, `GET /api/alerts`, `PATCH /api/alerts/[id]/acknowledge`, `PATCH /api/alerts/[id]/resolve`, `POST /api/tasks/check-alerts` (réservé `ADMIN`) — toutes vérifient tenant + appartenance à l'agence côté serveur ; aucune route `POST`/`DELETE` pour `Alert` (créée par le système uniquement, jamais supprimable).
  - Pages dashboard : `/dashboard/maintenances` (liste + filtres statut/type/véhicule/dates + `MaintenancesTable` avec actions modifier/marquer terminée/annuler via dialogues), `/new` (formulaire de planification) ; `/dashboard/alerts` (liste triée priorité puis date + filtres type/priority/status + `AlertsList` avec actions acknowledge/resolve). Navigation ajoutée dans `Sidebar.tsx`.
  - `Header.tsx` : badge d'alertes en attente (icône cloche, lien vers `/dashboard/alerts`), compté côté serveur dans `dashboard/layout.tsx` (`getPendingAlerts` + filtrage par agence accessible, même principe que vehicles/locations) et transmis via `DashboardLayout`.
  - `dashboard/page.tsx` : widget « À faire aujourd'hui » (retours du jour, maintenances dues, factures en retard — requêtes de lecture directes, sans effet de bord, distinctes de `checkX()` qui créent des alertes) et widget « Alertes récentes » (5 dernières, badges priorité/statut).
  - `src/__tests__/maintenances.test.ts` et `alerts.test.ts` (27 tests) : CRUD, machine à états, historique conservé, génération d'alertes idempotente (`POST /api/tasks/check-alerts`), acknowledge/resolve, filtrage priorité/status, isolation multi-tenant **et** multi-agence — 133/133 tests passés au total (voir [TESTREPORT.md](./TESTREPORT.md)).
  - `npm run lint` / `npm run test` / `npm run build` validés ; parcours complet vérifié manuellement contre un serveur `next dev` réel (inscription → agence → véhicule → maintenance planifiée aujourd'hui → déclenchement des vérifications → alerte visible dans le badge/le widget/la liste → acquittement → résolution → badge revenu à zéro ; second déclenchement sans doublon d'alerte), données de test nettoyées après vérification.
- **Déviations documentées par rapport à l'énoncé initial du sprint** (voir section 6 pour le détail) :
  - `createMaintenanceFromSchedule` prend `tenantId` en premier paramètre (l'énoncé initial l'omettait) : toute requête doit rester scopée tenant côté serveur, conformément à CLAUDE.md section 5 — aucune exception, même pour une fonction interne.
  - `createAlert(...)` prend un objet `CreateAlertInput` plutôt que des paramètres positionnels (`type, priority, tenantId, agencyId?, userId?, message`) — cohérent avec le pattern déjà en place pour toutes les autres fonctions `create*` du projet (`CreateVehicleInput`, `CreateLocationInput`, etc.).
  - `acknowledgeAlert`/`resolveAlert` prennent `tenantId` en premier paramètre (l'énoncé les omettait) — même raison que `createMaintenanceFromSchedule` ci-dessus.
  - Machine à états `Maintenance` : `SCHEDULED → COMPLETED` directement est autorisé (pas seulement via `IN_PROGRESS`), pour ne pas forcer une étape « en cours » à une petite agence qui traite l'entretien le jour même — seules « Terminer »/« Annuler » sont exposées dans l'UI.
- **Décision non soumise à validation préalable, prise en cours d'implémentation et documentée a posteriori** : `POST /api/tasks/check-alerts` est réservé au rôle `ADMIN` et reste scopé au tenant de l'ADMIN déclencheur (pas de scan multi-tenant global, aucun rôle « superadmin » transverse n'existant — voir section 8 point 16) — même justification pragmatique que l'accès aux rapports financiers (Sprint 6). **À confirmer explicitement**, voir section 8 point 29.
- **Non traité, hors périmètre explicite du sprint** :
  - Notifications par email — aucun prestataire SMTP configuré, décision explicite du propriétaire du projet en début de sprint (alertes in-app uniquement pour ce sprint).
  - Assignation manuelle d'une alerte à un utilisateur précis (`Alert.userId` existe dans le schéma mais n'est jamais renseigné par le code actuel — toutes les alertes générées par le système ont `userId` null, donc diffusées à tout le tenant/l'agence).
  - Récurrence automatique de maintenance (planification du prochain entretien après complétion d'un précédent) — `createMaintenanceFromSchedule` existe comme brique réutilisable mais n'est appelée par aucun moteur de récurrence.
  - Vrai cron périodique multi-tenant pour `checkDueMaintenances`/`checkReturnsToday`/`checkOverdueInvoices` — `POST /api/tasks/check-alerts` doit aujourd'hui être déclenché manuellement (ou via un cron externe appelant la route avec une session ADMIN), un mécanisme d'authentification de service dédié restant à concevoir.
  - Page de détail dédiée `/dashboard/maintenances/[id]` — actions (modifier/terminer/annuler) exposées directement depuis la liste via des dialogues, non demandée explicitement par l'énoncé du sprint.

Le dépôt est un dépôt git (branche `main`) avec un commit initial : `e673184` — "chore: initialize XRent Manager project". Le remote `origin` est configuré vers le dépôt GitHub privé `https://github.com/hdsc-123/xrent-manager.git`, et `main` est synchronisée avec `origin/main`. Le tag `v0.1.0` a été créé et envoyé, correspondant au socle initial.

Les principes d'architecture validés lors du Sprint 1 (voir section 6) sont désormais **largement implémentés** : socle de données, authentification, autorisation serveur (tenant/agence/rôle), montants financiers en entiers + devise, et un premier module métier (véhicules, locations) en place ; l'audit et les modules paiements/cautions/incidents restent non implémentés (voir section 3).

## 2. Ce qui est terminé

- Initialisation du projet Next.js (TypeScript, ESLint, Tailwind CSS, App Router, `src/`, alias `@/*`).
- Validation de `npm run lint` (aucune erreur).
- Validation de `npm run build` (build de production réussi, 2 routes statiques : `/` et `/_not-found`).
- Documentation fondatrice (Sprint 0) : CLAUDE.md, HANDOFF.md, PROJECT_MAP.md, ARCHITECTURE.md, DOMAINRULES.md, SECURITY.md, TESTREPORT.md, INCIDENTS.md, README.md.
- Initialisation Git et commit initial (`e673184` — "chore: initialize XRent Manager project") sur la branche `main`.
- Connexion au dépôt GitHub privé `hdsc-123/xrent-manager` (remote `origin`) et synchronisation de `main` avec `origin/main`.
- Création et envoi (push) du tag `v0.1.0`, correspondant au socle initial.
- Validation par le propriétaire du projet des principes d'architecture fondamentaux (Sprint 1) : base de données/ORM cibles, modèle d'isolation multi-tenant/multi-agence, représentation des montants et des dates, séparation des environnements, audit, exports/imports, reset sécurisé, priorités de tests — voir section 6 et le détail dans [ARCHITECTURE.md](./ARCHITECTURE.md), [DOMAINRULES.md](./DOMAINRULES.md), [SECURITY.md](./SECURITY.md).
- Installation de Prisma 6.19.3 et `@prisma/client`, connexion à PostgreSQL 17 en local (`xrent_dev`).
- Schéma minimal `Tenant`/`Agency`/`User`/`UserAgency` et migration `20260811133155_init_tenant_agency_user` appliquée en développement (`xrent_dev`).
- Couche d'accès aux données minimale (`src/lib/prisma.ts` singleton, `src/lib/db.ts`), chaque fonction de lecture scopée obligatoirement par `tenantId`.
- Installation de Vitest comme framework de test (`npm run test`) et premier test d'isolation multi-tenant (`src/__tests__/db.test.ts`), validé (5/5 tests passés, aucune donnée résiduelle après nettoyage).
- Base de données de test dédiée `xrent_test` créée, distincte de `xrent_dev` ; `vitest.config.mts` configuré avec `loadEnv` (Vite, mode `test`) pour charger `DATABASE_URL` depuis `.env.test` ; migration `init_tenant_agency_user` appliquée sur `xrent_test` (`prisma migrate deploy`) ; les tests s'exécutent désormais contre cette base dédiée, plus contre `xrent_dev`.
- Validation de `npm run lint`, `npm run test` et `npm run build` après ces ajouts.
- **Sprint 3** : authentification NextAuth.js v5 (sessions JWT), champs `passwordHash`/`role` sur `User`, migration `add_nextauth_models_and_user_auth_fields` appliquée sur `xrent_dev` et `xrent_test`, routes `/api/auth/*`, CRUD `/api/tenants*` et `/api/agencies*` scopés serveur, `src/proxy.ts`, tests d'intégration HTTP (37/37 passés) — voir la section Sprint 3 ci-dessus et [TESTREPORT.md](./TESTREPORT.md).
- **Sprint 4** : shadcn/ui + TanStack Table v9 + lucide-react, pages `/login`/`/register`/`/dashboard` (+ `tenants`, `agencies`, `users` en lecture seule, `settings`), coquille dashboard (Sidebar/Header/DashboardLayout), `GET /api/users`, `src/lib/api.ts`, `src/hooks/{useUser,useTenant}.ts`, tests d'intégration HTTP sur le rendu des pages (46/46 passés au total) — voir la section Sprint 4 ci-dessus et [TESTREPORT.md](./TESTREPORT.md).
- **Sprint 5** : modèles `Client`/`Vehicle`/`Location`, CRUD API + dashboard complets (véhicules, locations), disponibilité/conflits de réservation, machine à états, calcul de prix (`totalPrice`), `src/lib/{vehicles,locations,clients,format}.ts`, extension de `src/lib/authz.ts` (`canAccessAgency`/`getAccessibleAgencyIds`, avec correction d'une faille de vérification tenant), 76/76 tests passés au total — voir la section Sprint 5 ci-dessus et [TESTREPORT.md](./TESTREPORT.md).
- **Sprint 6** : modèles `Invoice`/`Payment`, CRUD API + dashboard complets (factures, paiements), numérotation de facture par tenant, calcul TVA/remise/total, machine à états, export PDF, paiements manuels (pas d'intégration Stripe/PayPal), rapports (revenu/utilisation véhicule/top véhicules, export CSV, réservés ADMIN), `src/lib/{invoices,payments,reports}.ts`, `src/components/invoices/InvoicePdf.tsx`, 106/106 tests passés au total — voir la section Sprint 6 ci-dessus et [TESTREPORT.md](./TESTREPORT.md).
- **Sprint 7** : modèles `Maintenance`/`Alert`, CRUD API + dashboard complets (maintenances), liste + acknowledge/resolve (alertes), génération automatique et idempotente d'alertes (`src/lib/scheduled-tasks.ts`, `POST /api/tasks/check-alerts` réservé ADMIN), badge d'alertes dans le header, widgets « À faire aujourd'hui »/« Alertes récentes » sur le dashboard, alertes in-app uniquement (pas d'email), `src/lib/{maintenances,alerts,scheduled-tasks}.ts`, 133/133 tests passés au total — voir la section Sprint 7 ci-dessus et [TESTREPORT.md](./TESTREPORT.md).

## 3. Ce qui n'est pas commencé

- Cautions, incidents de location, contenu détaillé de contrat/facture (conditions générales, franchise, kilométrage inclus, mentions légales, TVA intracommunautaire, avoirs/factures rectificatives).
- Intégration d'un prestataire de paiement (Stripe/PayPal ou autre) — paiements enregistrés manuellement uniquement (décision explicite Sprint 6, voir DOMAINRULES.md section 10) ; pas de remboursement/paiement négatif modélisé.
- Modèle `Category` dédié pour les véhicules (reste un champ texte libre sur `Vehicle`) ; page `/dashboard/clients` dédiée (recherche, historique, fusion de doublons).
- Notifications par email (alertes in-app uniquement pour ce sprint, décision explicite — voir section 6, Sprint 7) ; assignation manuelle d'une alerte à un utilisateur précis ; récurrence automatique de maintenance ; vrai cron périodique multi-tenant (voir section 8, points 30-32).
- Kilométrage et état technique détaillé des véhicules au-delà du suivi d'entretien (`Maintenance`, Sprint 7).
- Modification de rôle et suppression d'utilisateurs, invitation effective dans un tenant existant (voir section 8, points 2 et 17) — `/dashboard/users` est volontairement en lecture seule (Sprint 4).
- Édition du profil utilisateur (nom, email, mot de passe) — aucune route de mutation du profil n'existe encore.
- Limitation du nombre de tentatives de connexion, réinitialisation de mot de passe, MFA (voir [SECURITY.md](./SECURITY.md) section 3).
- Tout rôle transverse à plusieurs tenants ("superadmin" plateforme) — seul `ADMIN`, scopé à un tenant, existe.
- Toute table ou mécanisme d'audit (décidé en principe, non implémenté — voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 12).
- Fuseau horaire par agence (aucun champ `timezone` sur `Agency`).
- Tout environnement de staging ou de production réel.
- Tout script de seed de développement.

## 4. Prochaine action recommandée

Maintenance et alertes étant en place (Sprint 7), en plus de la facturation/paiements/rapports (Sprint 6), l'authentification, l'autorisation serveur (tenant/agence/rôle) et le CRUD `Tenant`/`Agency`/`Vehicle`/`Location`/`Invoice`/`Payment`/`Maintenance` (Sprints 3–7), la prochaine étape reste conditionnée par les décisions encore ouvertes (section 8) — en particulier : confirmer les décisions prises en cours d'implémentation sans validation préalable distincte (granularité de rôle véhicules/locations, point 21 ; accès aux rapports réservé ADMIN, point 24 ; accès à `check-alerts` réservé ADMIN et scopé au tenant déclencheur, point 29), le choix d'un prestataire d'email transactionnel si les notifications par email sont confirmées comme nécessaires (point 30), le prochain module métier à construire (cautions ? incidents ? module clients à part entière ?), et le flux d'invitation/gestion d'utilisateurs dans un tenant existant. Conformément à [CLAUDE.md](./CLAUDE.md), aucun code métier ou dépendance supplémentaire ne doit être ajouté sans validation explicite distincte de celle de ce sprint.

## 5. Commandes déjà validées

| Commande | Statut | Résultat observé |
|---|---|---|
| `npm run lint` | ✅ Validé | Aucune erreur ESLint |
| `npm run test` | ✅ Validé | 133/133 tests passés (Vitest) — isolation multi-tenant/multi-agence, authentification, CRUD (tenants/agencies/vehicles/locations/invoices/payments/maintenances), disponibilité/conflits, pricing, machine à états (locations + invoices + maintenances + alerts), numérotation de facture, recalcul automatique du statut de facture, rapports, génération idempotente d'alertes, acknowledge/resolve, rendu des pages UI, aucune donnée résiduelle après nettoyage |
| `npm run build` | ✅ Validé | Build de production réussi (Turbopack, Next.js 16.3.0), TypeScript strict sans erreur, 29 routes API + 23 pages `/dashboard/*` + `/login`/`/register` + Proxy |

Migrations de développement appliquées via `npx prisma migrate dev` (sur `xrent_dev`) puis répercutées sur `xrent_test` via `npx prisma migrate deploy` — jamais l'inverse, et jamais de commande interactive/destructive en production (aucun environnement de production n'existe à ce jour). Aucune commande de seed n'a été exécutée à ce jour.

## 6. Décisions prises

Décisions produit initiales (Sprint 0) :

- Le projet sera un SaaS multi-tenant et multi-agence, mobile-first, avec dashboard-admin dès le MVP (décision produit initiale, confirmée par le brief de démarrage).
- Aucun montant financier ne sera représenté en `float`.
- Aucune carte bancaire ne sera stockée en clair.
- Toute action sensible sera validée côté serveur.

Principes d'architecture validés (Sprint 1, 2026-08-11) — détail complet dans [ARCHITECTURE.md](./ARCHITECTURE.md), [DOMAINRULES.md](./DOMAINRULES.md) et [SECURITY.md](./SECURITY.md) :

- PostgreSQL comme base de données cible, Prisma comme ORM cible — **implémenté (Sprint 2)** : PostgreSQL 17 local (`xrent_dev`), Prisma 6.19.3.
- Isolation multi-tenant par `tenant_id` dans des tables partagées ; rattachement aux agences par `agency_id` — **implémenté au niveau schéma et couche d'accès aux données (Sprint 2)**, pas encore au niveau d'actions/routes serveur (aucune n'existe).
- Couche d'accès aux données centralisée, avec garde tenant/agence obligatoire — **implémentée (Sprint 2–3)** : `src/lib/db.ts` (`getTenantById`, `getAgencyById`, `getUserById`) réutilisée par les routes `/api/agencies*` ; les routes `/api/tenants*` interrogent Prisma directement avec un filtrage `tenantId`/`id` explicite (pas encore consolidé dans `src/lib/db.ts` — écarts mineurs à corriger si `db.ts` devient le point d'entrée unique imposé pour l'écriture aussi).
- Validation côté serveur systématique de l'identité, du rôle, du tenant, de l'agence et de l'appartenance de la ressource — **implémenté (Sprint 3)** : `src/lib/authz.ts` (`getSessionUser`) + vérifications explicites dans chaque route (`src/app/api/tenants/**`, `src/app/api/agencies/**`), testées par `tenants.test.ts`/`agencies.test.ts`.
- Montants financiers en entiers, exprimés dans la plus petite unité monétaire, avec devise stockée explicitement à côté de chaque montant — **implémenté (Sprint 5)** : `Vehicle.pricePerDay`/`Location.pricePerDay`/`Location.totalPrice` (entiers, centimes) + `currency` (défaut `"MAD"`, provisoire — voir section 8 point 3).
- Dates stockées en UTC, affichées selon le fuseau horaire de l'agence — **partiellement implémenté (Sprint 5)** : `Location.startDate`/`endDate` stockées en UTC (type `DateTime` Prisma/Postgres) ; toujours pas de conversion à l'affichage selon un fuseau d'agence (`Agency.timezone` n'existe toujours pas, voir section 8).
- Environnements développement, test, staging et production strictement séparés — partiellement respecté : développement (`xrent_dev`) et test (`xrent_test`) sont désormais deux bases distinctes ; staging et production restent non définis (voir section 8).
- Table d'audit dédiée comme mécanisme technique de traçabilité — non implémentée, toujours hors périmètre.
- Exports et imports validés côté serveur et scopés par tenant — non implémenté (aucun export/import n'existe).
- Reset de données techniquement impossible en environnement de production — non implémenté (aucun mécanisme de reset n'existe).
- Tests introduits dès le premier module métier, avec priorité aux tests d'isolation multi-tenant — **appliqué dès la couche d'accès aux données (Sprint 2) puis étendu aux routes API (Sprint 3)** : `src/__tests__/db.test.ts`, `tenants.test.ts`, `agencies.test.ts` couvrent l'isolation `Tenant`/`Agency`/`User` par `tenantId` et l'isolation multi-agence par `UserAgency`.

Décisions techniques Sprint 3 (2026-08-11), validées par le propriétaire du projet :

- Authentification : **NextAuth.js (Auth.js) v5**, fournisseur `CredentialsProvider` uniquement (pas d'OAuth à ce stade).
- Sessions : **JWT**, pas "database" — décision ajustée en cours de sprint après avoir vérifié dans le code de NextAuth v5 (`node_modules/@auth/core/lib/utils/assert.js`) que `CredentialsProvider` et `session.strategy: "database"` sont techniquement incompatibles (la librairie lève `UnsupportedStrategy`). Le propriétaire du projet a tranché en faveur de JWT, la stratégie standard pour ce type d'authentification (voir [SECURITY.md](./SECURITY.md) section 5).
- Rôles : `ADMIN` (par défaut pour le premier user d'un tenant, créé via `/api/auth/register`) et `MEMBER` — stockés en clair sur `User.role` (`String`), pas encore un type énuméré ni une table de permissions.
- `GET /api/tenants` retourne uniquement le tenant de l'ADMIN connecté (jamais tous les tenants de la plateforme) : aucun rôle "superadmin" transverse n'existe dans ce schéma, et l'énoncé initial du sprint ("lister les tenants, admin only") était ambigu sur ce point — interprété au sens le plus restrictif pour ne pas violer SECURITY.md section 1 (voir aussi section 8, point 16).

Décisions techniques Sprint 4 (2026-08-11), validées par le propriétaire du projet :

- UI : **shadcn/ui**, icônes **lucide-react**, table **TanStack Table**, pas de gestion d'état global (Zustand/Redux) — RSC + état local suffisent pour ce périmètre.
- **`/dashboard/users` en lecture seule pour ce sprint** : demandé lors du cadrage initial avec actions modifier/supprimer/changer le rôle, mais aucune route API `PATCH`/`DELETE /api/users/[id]` n'existait et la granularité des permissions reste explicitement À DÉCIDER (section 8, point 2) ; le propriétaire du projet a tranché en faveur d'une liste en lecture seule (nouvelle route `GET /api/users`, ADMIN uniquement) plutôt que de construire une logique de gestion des rôles/suppression sans validation dédiée — voir aussi point 17 ci-dessous.
- Édition du profil utilisateur (nom/email/mot de passe) dans `/dashboard/settings` : non construite, pour la même raison (aucune route de mutation existante, changement de mot de passe = sujet de sécurité nécessitant sa propre validation) — affichage en lecture seule avec message explicite plutôt qu'un formulaire non fonctionnel.

Décisions techniques Sprint 5 (2026-08-11), validées par le propriétaire du projet **avant** implémentation (via questions explicites, conformément à CLAUDE.md section 8) :

- `Location` fusionne réservation et contrat en un seul modèle avec cycle de statuts, plutôt que deux entités séparées.
- Locataire modélisé par un nouveau modèle `Client` (nom/email/téléphone, sans login), distinct de `User` (comptes staff).
- `Vehicle.agencyId` obligatoire (un véhicule appartient à exactement une agence).
- Colonne `currency` ajoutée à côté de chaque montant (`Vehicle.pricePerDay`, `Location.pricePerDay`/`totalPrice`), valeur par défaut `"EUR"` initialement pour ce sprint, **puis changée en `"MAD"` (Dirham marocain)** peu après sur demande explicite du propriétaire du projet — migration `20260811203931_change_default_currency_to_mad` (`ALTER COLUMN ... SET DEFAULT`, sans effet rétroactif sur les enregistrements déjà créés), appliquée sur `xrent_dev` et `xrent_test` ; labels UI « Prix / jour (€) » corrigés en « Prix / jour (MAD) » (`/dashboard/vehicles/new`, `EditVehicleForm.tsx`) et assertions de test mises à jour (`vehicles.test.ts`, `locations.test.ts`). Devise réellement supportée en production (multi-devises) toujours À DÉCIDER (section 8, point 3/22).
- **Décision non soumise à validation préalable, prise en cours d'implémentation et documentée a posteriori** : granularité de rôle pour véhicules/locations — un `MEMBER` rattaché à une agence peut créer/modifier/supprimer (pas seulement lire) les véhicules et locations de cette agence, contrairement au modèle `Tenant`/`Agency` où l'écriture reste ADMIN uniquement. Choix pragmatique cohérent avec le modèle `UserAgency` déjà validé, mais **à confirmer explicitement** — voir section 8, point 21.
- **Correction de sécurité, pas une décision produit** : `canAccessAgency` vérifie désormais que l'agence appartient au tenant de l'utilisateur avant toute logique de rôle (voir section « Sprint 5 » ci-dessus pour le détail de la faille corrigée).

Décisions techniques Sprint 6 (2026-08-11), validées par le propriétaire du projet **avant** implémentation (brief de sprint explicite, conformément à CLAUDE.md section 8) :

- Bibliothèques : **`@react-pdf/renderer`** (PDF), **`papaparse`** (CSV), **`recharts`** (graphiques) — seules nouvelles dépendances ajoutées à `package.json` pour ce sprint.
- **Aucune intégration Stripe/PayPal** : les paiements sont enregistrés manuellement par le personnel d'agence (voir DOMAINRULES.md section 10).
- `taxRate` en points de base (entier, ex. `2000` = 20 %) et `discountAmount` en montant fixe (entier, plus petite unité monétaire) — cohérent avec la règle « jamais de `float` pour un montant financier » (voir DOMAINRULES.md section 14 et 17).
- Numérotation de facture `INV-{année}-{5 chiffres}`, unique par tenant, générée par comptage (pas de table de séquence dédiée) avec réessai en cas de collision — voir DOMAINRULES.md section 17.
- `Invoice.amountPaid`/`status` ne sont jamais modifiés directement : toujours recalculés depuis la somme réelle des `Payment` (`recomputeInvoiceStatus`) — voir DOMAINRULES.md section 10.
- **Décision non soumise à validation préalable, prise en cours d'implémentation et documentée a posteriori** : les rapports financiers (`/api/reports/*`, `/dashboard/reports`) sont réservés au rôle `ADMIN` — choix pragmatique (données agrégées sur tout le tenant), **à confirmer explicitement**, voir section 8 point 24.
- **Décision non soumise à validation préalable, prise en cours d'implémentation et documentée a posteriori** : `Invoice` peut être créée en plusieurs exemplaires pour une même `Location` (aucune contrainte d'unicité `locationId`) — le schéma ne l'empêche pas, mais aucun cas d'usage (facture partielle, avoir) n'a été explicitement demandé, **à confirmer**, voir section 8 point 25.

Décisions techniques Sprint 7 (2026-08-12), validées par le propriétaire du projet **avant** implémentation (brief de sprint explicite, conformément à CLAUDE.md section 8) :

- Alertes **in-app uniquement** (badge + liste `/dashboard/alerts`) — pas d'envoi par email pour ce sprint, aucun prestataire SMTP configuré (décision explicite, voir section 8 point 30).
- Une alerte n'est **jamais supprimable**, seulement `acknowledge`/`resolve` — aucune route `POST`/`DELETE /api/alerts*`, aucune fonction `deleteAlert`.
- Coûts de maintenance (`Maintenance.cost`) en entier (centimes), `currency` par défaut `"MAD"` — cohérent avec la règle déjà validée (section 14, DOMAINRULES.md).
- Historique de maintenance conservé même après complétion : aucune modification ni suppression possible une fois `COMPLETED`/`CANCELLED` (contrainte explicite de l'énoncé du sprint).
- **Décision non soumise à validation préalable, prise en cours d'implémentation et documentée a posteriori** : `POST /api/tasks/check-alerts` réservé au rôle `ADMIN` et scopé au tenant du déclencheur (pas de cron multi-tenant global, aucun rôle « superadmin » transverse n'existant) — même justification pragmatique que l'accès aux rapports financiers (Sprint 6), **à confirmer explicitement**, voir section 8 point 29.
- **Décision non soumise à validation préalable, prise en cours d'implémentation et documentée a posteriori** : machine à états `Maintenance` autorisant `SCHEDULED → COMPLETED` directement (sans passer par `IN_PROGRESS`) — choix pragmatique pour ne pas imposer une étape « en cours » distincte à une petite agence, **à confirmer**, voir section 8 point 31.

Décisions techniques encore ouvertes : voir section 8.

## 7. Risques identifiés

- **Résolution du tenant à la connexion ambiguë** : `User.email` n'est unique que par tenant (`@@unique([tenantId, email])`). `/api/auth/login` résout l'utilisateur par email seul (`findFirst`) ; si deux tenants différents utilisent un jour le même email, ce lookup devient ambigu. Aucun mécanisme de désambiguïsation (sous-domaine, sélection de tenant explicite) n'existe — voir [SECURITY.md](./SECURITY.md) section 3 et section 8 point 16 ci-dessous.
- **Sessions JWT non révocables côté serveur** : la déconnexion efface le cookie mais un jeton déjà émis reste valide jusqu'à expiration (pas de table de sessions consultée à chaque requête). Acceptable pour ce sprint, mais à réévaluer si un besoin de révocation immédiate apparaît (ex. compromission de compte) — voir [SECURITY.md](./SECURITY.md) section 5.
- **Aucune limitation des tentatives de connexion** : `/api/auth/login` n'implémente aucun rate-limiting — risque de brute force, à traiter avant mise en production (voir [SECURITY.md](./SECURITY.md) section 3).
- **Aucune stratégie de gestion des cautions définie** : à trancher avant tout développement du module cautions (voir DOMAINRULES.md section 11). Le module paiements existe désormais mais reste manuel uniquement (aucun prestataire de paiement intégré, décision explicite Sprint 6).
- **Devise `"MAD"` codée en dur par défaut (Sprint 5, changée depuis `"EUR"`)** : `Vehicle`/`Location` ont un champ `currency` mais toute création actuelle utilise `"MAD"` par défaut faute de décision multi-devises tranchée (voir section 8, point 3) — à revoir avant d'onboarder un tenant hors zone MAD (le champ existe justement pour permettre EUR, USD, etc. sans nouvelle migration). `Invoice`/`Payment` héritent de la même devise par dérivation (jamais fournie par le client) ; `getRevenueReport` (Sprint 6) suppose une devise unique par tenant pour son agrégation.
- **Granularité de rôle véhicules/locations non validée formellement** : un `MEMBER` rattaché à une agence peut aujourd'hui créer/modifier/supprimer les véhicules et locations de cette agence (voir section 6, décisions Sprint 5) — décision pragmatique prise en cours d'implémentation, pas explicitement validée au préalable comme l'exige CLAUDE.md section 8 pour la logique métier ; à confirmer ou ajuster avec le propriétaire du projet (section 8, point 21).
- **Numérotation de facture non garantie sous forte concurrence** (Sprint 6) : `generateInvoiceNumber` compte les factures existantes plutôt que d'utiliser une séquence PostgreSQL dédiée ; en cas de collision, `createInvoice` réessaie (jusqu'à 5 fois) mais ne garantit pas une absence totale d'échec sous charge concurrente élevée sur un même tenant — acceptable pour ce sprint (volume de facturation manuel, un utilisateur à la fois en pratique), à réévaluer si le volume augmente (voir DOMAINRULES.md section 17).
- **Accès aux rapports financiers restreint à ADMIN sans validation préalable** (Sprint 6) : décision pragmatique prise en cours d'implémentation, pas explicitement validée au préalable comme l'exige CLAUDE.md section 8 ; à confirmer avec le propriétaire du projet (section 8, point 24).
- **Génération d'alertes non automatisée** (Sprint 7) : `POST /api/tasks/check-alerts` doit être déclenché manuellement par un ADMIN (ou par un cron externe appelant la route avec une session ADMIN valide) — aucun scheduler interne (ex. `node-cron`) n'a été ajouté (pas de dépendance supplémentaire non validée, CLAUDE.md section 7), donc les alertes ne sont générées qu'au moment où la route est appelée, pas en continu. À traiter avant mise en production si des alertes en quasi temps réel sont attendues.
- **Accès à `check-alerts` réservé ADMIN et scopé au tenant déclencheur sans validation préalable** (Sprint 7) : même limite que pour les rapports financiers (voir ci-dessus) ; de plus, sans rôle « superadmin » transverse, un futur cron multi-tenant réel nécessiterait un mécanisme d'authentification de service dédié, non conçu à ce stade — voir section 8, point 29.

## 8. Points à valider avec le propriétaire du projet

Les points suivants restent explicitement **À DÉCIDER**. Détail dans [DOMAINRULES.md](./DOMAINRULES.md), [ARCHITECTURE.md](./ARCHITECTURE.md) et [SECURITY.md](./SECURITY.md) :

1. ~~Fournisseur d'authentification et stratégie MFA.~~ Fournisseur tranché (NextAuth.js v5, Sprint 3) ; **MFA reste À DÉCIDER**.
2. Rôles et permissions détaillés au-delà de `ADMIN`/`MEMBER` (granularité par module/action).
3. Devise initiale et support multi-devises.
4. Règles d'arrondi financier.
5. ~~Prestataire de paiement.~~ Tranché (Sprint 6) : aucun, paiements enregistrés manuellement. Modalités des cautions restent **À DÉCIDER**.
6. Hébergeur précis et gestionnaire de secrets en production.
7. Stratégie détaillée de sauvegarde.
8. Outil de test de charge.
9. Périmètre exact du MVP (quels modules métier sont inclus dans la première version livrable).
10. Juridiction cible et périmètre RGPD applicable.
11. Nom et emplacement exacts des dossiers serveur (structure de code métier, distincte de `src/lib` utilisé pour la couche d'accès aux données technique).
12. Formats et périmètre détaillés des exports/imports.
13. Durée de conservation et droits d'accès aux journaux d'audit.
14. Modélisation précise du fuseau horaire par agence (champ `timezone` non ajouté à `Agency` à ce stade).
15. Granularité des rôles (tenant vs par agence), à trancher avant d'enrichir `UserAgency`.
16. **Nouveau (Sprint 3)** : résolution du tenant à la connexion en cas d'email dupliqué entre tenants (sous-domaine par tenant ? sélection explicite ?) et existence éventuelle d'un rôle "superadmin" plateforme distinct de `ADMIN` (nécessaire si `GET /api/tenants` doit un jour lister plusieurs tenants).
17. **Nouveau (Sprint 3)** : flux d'invitation d'un utilisateur supplémentaire dans un tenant existant (aujourd'hui, seul `/api/auth/register` crée un `User`, toujours accompagné d'un nouveau tenant).
18. **Nouveau (Sprint 3)** : durée d'expiration de session souhaitée (actuellement la valeur par défaut de NextAuth, 30 jours) et politique de complexité de mot de passe au-delà de la longueur minimale (8 caractères).
19. **Nouveau (Sprint 4)** : conception des routes `PATCH`/`DELETE /api/users/[id]` (changement de rôle, suppression) nécessaires pour sortir `/dashboard/users` de son mode lecture seule — dépend du point 2 (granularité des rôles) et doit inclure la prévention d'auto-rétrogradation/auto-suppression du dernier ADMIN d'un tenant.
20. **Nouveau (Sprint 4)** : route(s) de mutation du profil utilisateur courant (nom, email, changement de mot de passe) — actuellement absentes ; le changement de mot de passe en particulier nécessite une décision explicite sur la vérification du mot de passe actuel et l'éventuelle invalidation des sessions JWT existantes (voir section 7, sessions non révocables).
21. **Nouveau (Sprint 5)** : confirmer (ou ajuster) la décision provisoire selon laquelle un `MEMBER` rattaché à une agence peut créer/modifier/supprimer les véhicules et locations de cette agence (pas seulement les consulter) — voir section 6 et section 7. À trancher avant d'étendre ce pattern à d'autres modules métier.
22. **Nouveau (Sprint 5, mis à jour)** : devise(s) réellement supportée(s) en production (le champ `currency` existe, mais `"MAD"` est actuellement codé en dur comme valeur par défaut à la création, changé depuis `"EUR"`) — précise le point 3 ci-dessus.
23. **Nouveau (Sprint 5)** : un module `Client` à part entière (page dédiée, recherche, historique de locations, fusion de doublons, documents d'identité/permis) est-il nécessaire, ou le modèle minimal actuel (sélection/création inline) suffit-il pour la suite du MVP ?
24. **Nouveau (Sprint 6)** : confirmer (ou ajuster) la décision provisoire selon laquelle les rapports financiers (`/api/reports/*`, `/dashboard/reports`) sont réservés au rôle `ADMIN`, y compris pour un `MEMBER` rattaché à toutes les agences pertinentes — voir section 6 et section 7.
25. **Nouveau (Sprint 6)** : une `Location` peut-elle avoir plusieurs `Invoice` (facture partielle, avoir, facture rectificative), ou une seule facture par location est-elle la règle ? Le schéma ne l'empêche pas techniquement — voir DOMAINRULES.md section 17.
26. **Nouveau (Sprint 6)** : règles de remise en pourcentage (aujourd'hui `discountAmount` est un montant fixe, pas un pourcentage) et règles d'arrondi financier au-delà du calcul de jours de location — précise le point 4 ci-dessus.
27. **Nouveau (Sprint 6)** : contenu détaillé de facture (mentions légales, conditions générales, TVA intracommunautaire) — dépend en partie de la juridiction cible (point 10) ; gestion des remboursements/paiements négatifs, non modélisée à ce stade.
28. **Nouveau (Sprint 7)** : les alertes resteront-elles in-app uniquement, ou une intégration email (avec choix d'un prestataire SMTP) est-elle nécessaire pour un futur sprint ? Décision explicite de démarrage de sprint : in-app uniquement pour l'instant, **à reconfirmer** si le besoin d'email devient prioritaire.
29. **Nouveau (Sprint 7)** : confirmer (ou ajuster) la décision provisoire selon laquelle `POST /api/tasks/check-alerts` est réservé `ADMIN` et scopé au tenant déclencheur (pas de scan multi-tenant global) — voir section 6 et section 7 ; si un vrai cron périodique multi-tenant est nécessaire, un mécanisme d'authentification de service dédié devra être conçu (aucun rôle « superadmin » transverse n'existe, point 16).
30. **Nouveau (Sprint 7)** : si les notifications par email sont un jour nécessaires, quel prestataire SMTP (et quelle politique de contenu/fréquence) ? Aucune dépendance ni configuration n'existe à ce stade (précise le point 28).
31. **Nouveau (Sprint 7)** : confirmer (ou ajuster) la décision provisoire selon laquelle `SCHEDULED → COMPLETED` est autorisé directement pour une `Maintenance` (sans passer par `IN_PROGRESS`) — voir section 6. À trancher si un workflow de maintenance plus fin (ex. suivi du temps passé « en cours ») s'avère nécessaire.
32. **Nouveau (Sprint 7)** : récurrence automatique de maintenance (planification du prochain entretien après complétion d'un précédent, ex. tous les X km ou tous les Y mois) — `createMaintenanceFromSchedule` existe comme brique réutilisable mais aucun moteur de récurrence ne l'appelle ; périmètre et règles de récurrence à définir.

Framework de test : **tranché** (Vitest, voir section 2) — les outils e2e et de test de charge restent À DÉCIDER.
