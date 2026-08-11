# PROJECT_MAP.md — Cartographie du projet

Ce document décrit la structure **réelle** actuelle du dépôt, puis une structure **cible indicative** pour les futurs domaines métier. La structure cible n'est **pas** implémentée : elle sert de repère, pas d'inventaire de fichiers existants.

## 1. Structure actuelle des dossiers (existante)

```
xrent-manager/
├── public/                  # Assets statiques par défaut (SVG de démo create-next-app)
│   ├── file.svg
│   ├── globe.svg
│   ├── next.svg
│   ├── vercel.svg
│   └── window.svg
├── prisma/
│   ├── schema.prisma        # Tenant, Agency, User (passwordHash, role), UserAgency, Client, Vehicle, Location, Account, Session, VerificationToken
│   └── migrations/
│       ├── migration_lock.toml
│       ├── 20260811133155_init_tenant_agency_user/
│       │   └── migration.sql
│       ├── 20260811141912_add_nextauth_models_and_user_auth_fields/
│       │   └── migration.sql
│       ├── 20260811201341_add_vehicle_and_location_models/
│       │   └── migration.sql
│       └── 20260811203931_change_default_currency_to_mad/
│           └── migration.sql
├── components.json          # Config shadcn/ui (style base-nova, alias @/components, @/lib, @/hooks)
├── src/
│   ├── app/                 # App Router Next.js
│   │   ├── favicon.ico
│   │   ├── globals.css      # Styles Tailwind + tokens shadcn/ui (générés par `shadcn init`)
│   │   ├── layout.tsx       # Layout racine (police, <Toaster /> global sonner) — page d'accueil / toujours celle par défaut create-next-app
│   │   ├── page.tsx         # Page d'accueil par défaut (démo create-next-app, non modifiée)
│   │   ├── (auth)/          # Groupe de routes auth (URLs /login, /register — pas de préfixe)
│   │   │   ├── layout.tsx          # Layout centré, sans sidebar
│   │   │   ├── login/
│   │   │   │   ├── page.tsx        # Server wrapper + <Suspense> (callbackUrl via useSearchParams)
│   │   │   │   └── LoginForm.tsx   # Client Component : signIn("credentials", …) de next-auth/react
│   │   │   └── register/page.tsx   # Client Component : POST /api/auth/register
│   │   ├── dashboard/
│   │   │   ├── layout.tsx          # Server Component : session+tenant, redirige /login si non authentifié
│   │   │   ├── page.tsx            # Stats (agences/users), actions rapides
│   │   │   ├── loading.tsx         # Skeleton
│   │   │   ├── tenants/
│   │   │   │   ├── page.tsx, TenantsTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, EditTenantForm.tsx
│   │   │   ├── agencies/
│   │   │   │   ├── page.tsx, AgenciesTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, EditAgencyForm.tsx
│   │   │   ├── users/              # Lecture seule (voir HANDOFF.md) : pas d'actions modifier/supprimer/rôle
│   │   │   │   ├── page.tsx, UsersTable.tsx, loading.tsx
│   │   │   ├── vehicles/           # (Sprint 5) CRUD complet, scopé agence
│   │   │   │   ├── page.tsx, VehiclesTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, EditVehicleForm.tsx
│   │   │   ├── locations/          # (Sprint 5) CRUD complet, machine à états, scopé agence
│   │   │   │   ├── page.tsx, LocationsTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, LocationActions.tsx
│   │   │   └── settings/page.tsx   # Nom du tenant (éditable) ; profil user en lecture seule
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── [...nextauth]/route.ts  # Handler NextAuth (GET/POST)
│   │       │   ├── register/route.ts       # POST — crée un tenant + son premier user (ADMIN)
│   │       │   ├── login/route.ts          # POST — connexion email/password
│   │       │   ├── logout/route.ts         # POST — déconnexion
│   │       │   └── me/route.ts             # GET — user connecté (401 sinon)
│   │       ├── tenants/
│   │       │   ├── route.ts                # GET (liste, ADMIN, son propre tenant uniquement)/POST (ADMIN)
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE — scopé au tenant de l'ADMIN connecté
│   │       ├── agencies/
│   │       │   ├── route.ts                # GET (liste du tenant connecté)/POST (ADMIN)
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE — scopé tenant + agence (UserAgency)
│   │       ├── users/route.ts              # GET — liste du tenant, ADMIN uniquement (Sprint 4, lecture seule)
│   │       ├── vehicles/                   # (Sprint 5)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — scopé tenant + agence
│   │       │   └── [id]/
│   │       │       ├── route.ts            # GET/PATCH/DELETE (bloqué si locations existantes)
│   │       │       └── availability/route.ts  # GET — disponibilité sur une période
│   │       ├── locations/                  # (Sprint 5)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — vérifie disponibilité, calcule totalPrice
│   │       │   └── [id]/route.ts           # GET/PATCH (statut/dates/notes)/DELETE (si PENDING/CANCELLED)
│   │       └── clients/route.ts            # (Sprint 5) GET (liste)/POST — tenant-scopé, pas de page dédiée
│   ├── proxy.ts              # Redirige vers /login sur /dashboard*, /settings* si non authentifié (middleware.ts est déprécié dans cette version de Next.js)
│   ├── components/
│   │   ├── ui/               # Composants shadcn/ui (générés) + index.ts (ré-export)
│   │   └── layout/            # Sidebar.tsx, Header.tsx, DashboardLayout.tsx, DataTable.tsx (TanStack Table v9)
│   ├── hooks/
│   │   ├── useUser.ts        # Lecture client de GET /api/auth/me
│   │   └── useTenant.ts      # Lecture client de GET /api/tenants
│   ├── lib/
│   │   ├── prisma.ts        # Singleton PrismaClient (gère le hot reload Next.js)
│   │   ├── db.ts            # getTenantById, getAgencyById, getUserById — scopés tenantId
│   │   ├── auth.ts          # Config NextAuth (CredentialsProvider, sessions JWT, callbacks jwt/session/signIn)
│   │   ├── authz.ts         # getSessionUser(), canAccessAgency(), getAccessibleAgencyIds() — session + autorisation agence
│   │   ├── api.ts           # Wrapper fetch pour /api/* (normalise les erreurs { error })
│   │   ├── format.ts        # (Sprint 5) formatMoney() — formatage des montants entiers + devise
│   │   ├── clients.ts       # (Sprint 5) getClients, getClientById, createClient — tenant-scopé
│   │   ├── vehicles.ts      # (Sprint 5) CRUD + checkAvailability — tenant/agence-scopé
│   │   ├── locations.ts     # (Sprint 5) CRUD + calculateTotalPrice + machine à états (canTransition)
│   │   └── utils.ts         # cn() — généré par shadcn init
│   └── __tests__/
│       ├── db.test.ts        # Tests d'isolation multi-tenant (Vitest) sur src/lib/db.ts
│       ├── auth.test.ts      # Tests d'intégration HTTP : register/login/logout/me
│       ├── tenants.test.ts   # Tests CRUD tenants + isolation multi-tenant
│       ├── agencies.test.ts  # Tests CRUD agencies + isolation multi-tenant/multi-agence
│       ├── ui.test.tsx       # Tests d'intégration HTTP sur le rendu des pages (login/register/dashboard/users)
│       ├── vehicles.test.ts   # (Sprint 5) CRUD, disponibilité/conflits, isolation multi-tenant/multi-agence
│       ├── locations.test.ts  # (Sprint 5) CRUD, pricing, conflits, machine à états, isolation multi-tenant/multi-agence
│       └── helpers/          # testServer.ts (port/URL), http.ts (fetch + cookies), fixtures.ts (register/login de test)
├── vitest.global-setup.ts    # Démarre/arrête un vrai serveur `next dev` de test (requis par NextAuth, voir TESTREPORT.md)
├── AGENTS.md                # Règles agent Next.js, régénéré automatiquement par `next dev`
├── CLAUDE.md                # Règles pour assistants IA / développeurs (importe AGENTS.md)
├── README.md                # Point d'entrée du projet
├── HANDOFF.md                # Transmission d'état du projet
├── PROJECT_MAP.md            # Ce document
├── ARCHITECTURE.md           # Architecture générale
├── DOMAINRULES.md            # Règles métier
├── SECURITY.md                # Règles de sécurité
├── TESTREPORT.md              # Suivi des tests
├── INCIDENTS.md                # Suivi des incidents
├── eslint.config.mjs          # Configuration ESLint (eslint-config-next)
├── next.config.ts             # Configuration Next.js (par défaut, non personnalisée)
├── postcss.config.mjs         # Configuration PostCSS pour Tailwind
├── tsconfig.json               # Configuration TypeScript (alias @/* -> ./src/*)
├── vitest.config.mts           # Configuration Vitest (alias @/*, setup dotenv, globalSetup)
├── vitest.setup.ts             # Charge .env avant les tests (dotenv/config)
├── package.json                 # Dépendances et scripts npm
└── package-lock.json
```

`.env` et `.env.test` (non versionnés, exclus par `.gitignore`) contiennent `DATABASE_URL` (`xrent_dev`/`xrent_test`) et `AUTH_SECRET` (secret de signature/chiffrement des sessions JWT NextAuth, généré localement).

`src/components` (Sprint 4) accueille l'UI : `ui/` (shadcn/ui) et `layout/` (coquille dashboard). Aucun dossier `server/`, `data/`, `tests/`, etc. n'existe à ce jour. `src/lib` accueille la couche d'accès aux données technique, la configuration d'authentification, le wrapper `fetch` pour l'UI (`api.ts`) et désormais la première logique **métier** (`vehicles.ts`, `locations.ts`, `clients.ts`, Sprint 5) — ce choix (rester dans `src/lib` plutôt que créer un dossier `server/`/`data/` dédié) prolonge le pattern déjà en place pour `db.ts`/`authz.ts`, mais reste révisable si le volume de logique métier croît (voir section 3). Les pages d'interface `/login`, `/register`, `/dashboard/*` (dont `/dashboard/vehicles*` et `/dashboard/locations*` depuis le Sprint 5) existent désormais ; les domaines contrats, clients (page dédiée), paiements, cautions, incidents et audit restent entièrement à construire.

## 2. Rôle des principaux fichiers existants

| Fichier | Rôle |
|---|---|
| `src/app/layout.tsx` | Layout racine de l'application (métadonnées, polices, structure HTML de base). Actuellement le layout par défaut de `create-next-app`. |
| `src/app/page.tsx` | Page d'accueil actuelle. Actuellement la page de démonstration par défaut de `create-next-app`, sans lien avec le métier XRent. |
| `src/app/globals.css` | Styles globaux et directives Tailwind CSS. |
| `next.config.ts` | Configuration Next.js. Actuellement vide (options par défaut). |
| `tsconfig.json` | Configuration TypeScript, avec alias d'import `@/*` pointant vers `src/*`. |
| `eslint.config.mjs` | Configuration ESLint basée sur `eslint-config-next` (core-web-vitals + typescript). |
| `AGENTS.md` | Fichier régénéré automatiquement par `next dev` ; contient les règles spécifiques à cette version de Next.js pour les agents IA. Ne pas éditer manuellement son contenu généré. |
| `CLAUDE.md` | Règles impératives pour les assistants IA et développeurs sur ce projet ; importe `AGENTS.md`. |
| `prisma/schema.prisma` | Schéma de données : `Tenant`, `Agency`, `User` (`passwordHash`, `role`), `UserAgency`, `Client`, `Vehicle`, `Location` (Sprint 5), isolation par `tenantId`/`agencyId` ; `Account`/`Session`/`VerificationToken` pour l'adaptateur NextAuth (OAuth futur, non utilisés pour les sessions actuelles). |
| `src/lib/prisma.ts` | Singleton `PrismaClient`, réutilisé en développement pour éviter l'épuisement de connexions au hot reload Next.js. |
| `src/lib/db.ts` | Couche d'accès aux données minimale : `getTenantById`, `getAgencyById`, `getUserById`, chacune filtrée par `tenantId` côté serveur. |
| `src/lib/auth.ts` | Configuration NextAuth v5 : `CredentialsProvider` (email/password, `bcryptjs`), sessions JWT, callbacks `jwt`/`session` (portent `id`/`tenantId`/`role`), exporte `handlers`/`auth`/`signIn`/`signOut`. |
| `src/lib/authz.ts` | `getSessionUser()` — récupère l'utilisateur de la session courante. `canAccessAgency()` (Sprint 5) — vérifie qu'une agence appartient au tenant de l'utilisateur *et* (ADMIN, ou MEMBER rattaché via `UserAgency`) ; centralise une vérification auparavant dupliquée dans les routes/pages agencies. `getAccessibleAgencyIds()` (Sprint 5) — liste des agences accessibles (`null` = toutes, pour un ADMIN). |
| `src/proxy.ts` | Redirection optimiste vers `/login` pour `/dashboard*`/`/settings*` si non authentifié (lecture du JWT côté cookie uniquement, pas de requête base de données). |
| `src/app/api/auth/register/route.ts` | Crée un `Tenant` et son premier `User` (`role: "ADMIN"`), mot de passe haché avec `bcryptjs`. |
| `src/app/api/auth/login/route.ts` | Authentifie via `signIn("credentials", …)`, retourne le même message d'erreur pour mot de passe incorrect et compte inexistant. |
| `src/app/api/tenants/route.ts`, `[id]/route.ts` | CRUD `Tenant`, réservé aux `ADMIN`, strictement scopé au tenant de l'utilisateur connecté (jamais de liste globale). |
| `src/app/api/agencies/route.ts`, `[id]/route.ts` | CRUD `Agency`, scopé tenant ; lecture ouverte aux `MEMBER` explicitement rattachés via `UserAgency`, écriture réservée aux `ADMIN`. |
| `src/app/api/users/route.ts` | (Sprint 4) `GET` — liste les users du tenant, réservé ADMIN, ne sélectionne jamais `passwordHash`. Lecture seule : pas de `PATCH`/`DELETE` (voir [HANDOFF.md](./HANDOFF.md)). |
| `src/app/api/vehicles/route.ts`, `[id]/route.ts`, `[id]/availability/route.ts` | (Sprint 5) CRUD `Vehicle` + disponibilité, scopé tenant + agence (`canAccessAgency`), immatriculation unique par tenant, suppression bloquée si des locations existent. |
| `src/app/api/locations/route.ts`, `[id]/route.ts` | (Sprint 5) CRUD `Location`, `agencyId` toujours dérivé du véhicule côté serveur (jamais du client), vérification de disponibilité et calcul de `totalPrice` à la création, machine à états sur `PATCH`, suppression restreinte aux statuts `PENDING`/`CANCELLED`. |
| `src/app/api/clients/route.ts` | (Sprint 5) `GET`/`POST` — liste/création de `Client`, tenant-scopé, pas de page dashboard dédiée (voir section 4). |
| `src/app/dashboard/layout.tsx` | (Sprint 4) Server Component : résout la session et le tenant courant, redirige vers `/login` si non authentifié, fournit `DashboardLayout`. |
| `src/components/layout/DataTable.tsx` | (Sprint 4) Table générique (TanStack Table **v9** — API `useTable`/`tableFeatures`, pas `useReactTable` — voir `node_modules/@tanstack/react-table/skills/migrate-v8-to-v9/`), tri par colonne et pagination, réutilisée par les pages tenants/agencies/users. |
| `src/lib/api.ts` | (Sprint 4) Wrapper `fetch` pour les appels `/api/*` côté client ; lève `ApiError` avec le message `{ error }` renvoyé par la route. |
| `src/__tests__/db.test.ts` | Tests Vitest vérifiant qu'`getAgencyById`/`getUserById` ne retournent jamais une ressource d'un autre tenant ; crée puis nettoie ses propres données dans `xrent_test`. |
| `src/__tests__/auth.test.ts`, `tenants.test.ts`, `agencies.test.ts` | Tests d'intégration HTTP contre un vrai serveur `next dev` de test (voir `vitest.global-setup.ts`) : authentification, CRUD, isolation multi-tenant/multi-agence. |
| `src/__tests__/vehicles.test.ts`, `locations.test.ts` | (Sprint 5) Tests d'intégration HTTP : CRUD, disponibilité/conflits de réservation, calcul de `totalPrice`, machine à états des locations, isolation multi-tenant/multi-agence. |
| `src/__tests__/ui.test.tsx` | (Sprint 4) Tests d'intégration HTTP sur le rendu des pages `/login`, `/register`, `/dashboard*` ; voir [TESTREPORT.md](./TESTREPORT.md) pour la note sur `redirect()` en contexte de streaming. |

## 3. Structure cible indicative (non existante à ce jour)

Cette section décrit une organisation **envisagée** pour accueillir les futurs domaines métier, à titre indicatif seulement. Rien ci-dessous n'est créé. Le détail exact (noms, découpage) reste **À DÉCIDER** au moment de l'implémentation, en cohérence avec [ARCHITECTURE.md](./ARCHITECTURE.md).

```
src/
├── app/                      # App Router : routes, pages, layouts (interface + orchestration)
│   ├── (dashboard)/          # Groupe de routes pour le dashboard-admin (À DÉCIDER)
│   └── ...
├── components/                # Composants d'interface réutilisables (Client/Server Components)
├── server/                     # Logique serveur : server actions, validation, autorisation
│   └── <domaine>/               # Un sous-dossier par domaine métier (voir section 4)
├── lib/                          # Utilitaires partagés (formatage, dates, montants, etc.)
├── data/ ou db/                    # Future couche d'accès aux données (requêtes, ORM) — À DÉCIDER
└── types/                           # Types partagés
```

Cette arborescence est une hypothèse de travail, pas une décision figée.

**Décision validée (Sprint 1)**, indépendante du nom exact des dossiers ci-dessus : la future couche d'accès aux données (`data/`, `db/`, ou autre nom — À DÉCIDER) devra centraliser tous les accès à la base de données et y appliquer une garde tenant/agence obligatoire, conformément à [ARCHITECTURE.md](./ARCHITECTURE.md) section 7.

## 4. Futurs domaines métier (envisagés, non implémentés)

D'après les principes produit de démarrage :

- Tenants (CRUD + UI implémentés, Sprint 3–4)
- Agences (CRUD + UI implémentés, Sprint 3–4)
- Utilisateurs et rôles (inscription + rôles `ADMIN`/`MEMBER` implémentés Sprint 3 ; liste en lecture seule Sprint 4 ; modification de rôle, suppression, invitation et granularité fine des permissions restent À DÉCIDER)
- Véhicules (CRUD + UI + disponibilité implémentés, Sprint 5 ; catégorie = champ texte libre sur `Vehicle`, pas de modèle `Category` dédié — voir DOMAINRULES.md section 6)
- Réservations et contrats (fusionnés en un seul modèle `Location` avec machine à états, Sprint 5 — décision explicite, voir HANDOFF.md et DOMAINRULES.md section 7/8)
- Clients (modèle `Client` minimal implémenté Sprint 5 — nom/email/téléphone, pas de page `/dashboard/clients` dédiée, uniquement sélection/création inline depuis le formulaire de location)
- Paiements
- Cautions
- Incidents (véhicule/location)
- Audit
- Export / Import
- Dashboard-admin (coquille + pages de base implémentées, Sprint 4 ; module métier véhicules/locations depuis Sprint 5)

Le détail des règles associées à chaque domaine est en cours de définition dans [DOMAINRULES.md](./DOMAINRULES.md) ; beaucoup de points y sont marqués **À DÉCIDER**.

## 5. Séparation entre interface, logique serveur, accès aux données et sécurité

Principe cible (non encore implémenté, détaillé dans [ARCHITECTURE.md](./ARCHITECTURE.md)) :

- **Interface** (`src/app`, `src/components`) : présentation, ne doit contenir aucune logique d'autorisation ni aucun secret.
- **Logique serveur** (server actions / routes serveur) : validation des entrées, application des règles métier, vérification systématique de l'identité, du rôle, du tenant, de l'agence et de l'appartenance de la ressource.
- **Accès aux données** (`src/lib`, nom définitif toujours **À DÉCIDER**) : `src/lib/db.ts` centralise les lectures scopées `tenantId` réutilisées par `/api/agencies*` ; les routes `/api/tenants*` interrogent Prisma directement avec filtrage explicite (pas encore consolidé dans `db.ts`).
- **Sécurité** (transverse) : authentification, autorisation, audit — ne doit jamais être contournable depuis la couche interface. **Authentification et autorisation implémentées (Sprint 3)** : `src/lib/auth.ts`, `src/lib/authz.ts`, vérifications explicites dans chaque route API. Les pages `/dashboard/*` (Sprint 4) revérifient elles-mêmes la session/le rôle côté serveur (`getSessionUser()`) plutôt que de faire confiance à `src/proxy.ts` seul. **Audit toujours non implémenté** (voir [HANDOFF.md](./HANDOFF.md) section 3).

Cette séparation existe désormais en grande partie en code (accès aux données, authentification, autorisation serveur, UI dashboard de base) ; la logique **métier** (véhicules, réservations…) reste entièrement à construire.

## 6. Fichiers qui ne doivent jamais contenir de secrets

- Tout fichier suivi par git en clair : `next.config.ts`, `package.json`, tout fichier sous `src/`, tout fichier de documentation (`*.md`).
- `.env*` est déjà exclu du suivi git via `.gitignore` — les secrets doivent exclusivement y résider (ou dans un gestionnaire de secrets externe), jamais dans le code source ni dans la documentation.
- Aucun exemple de clé, token ou identifiant réel ne doit être inséré, même à titre d'illustration, dans un document de ce dépôt.
