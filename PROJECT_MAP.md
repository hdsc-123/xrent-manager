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
│   ├── schema.prisma        # Tenant, Agency, User (passwordHash, role), UserAgency, Account, Session, VerificationToken
│   └── migrations/
│       ├── migration_lock.toml
│       ├── 20260811133155_init_tenant_agency_user/
│       │   └── migration.sql
│       └── 20260811141912_add_nextauth_models_and_user_auth_fields/
│           └── migration.sql
├── src/
│   ├── app/                 # App Router Next.js
│   │   ├── favicon.ico
│   │   ├── globals.css      # Styles globaux Tailwind
│   │   ├── layout.tsx       # Layout racine par défaut
│   │   ├── page.tsx         # Page d'accueil par défaut (démo create-next-app)
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
│   │       └── agencies/
│   │           ├── route.ts                # GET (liste du tenant connecté)/POST (ADMIN)
│   │           └── [id]/route.ts           # GET/PATCH/DELETE — scopé tenant + agence (UserAgency)
│   ├── proxy.ts              # Redirige vers /login sur /dashboard*, /settings* si non authentifié (middleware.ts est déprécié dans cette version de Next.js)
│   ├── lib/
│   │   ├── prisma.ts        # Singleton PrismaClient (gère le hot reload Next.js)
│   │   ├── db.ts            # getTenantById, getAgencyById, getUserById — scopés tenantId
│   │   ├── auth.ts          # Config NextAuth (CredentialsProvider, sessions JWT, callbacks jwt/session/signIn)
│   │   └── authz.ts         # getSessionUser() — point d'entrée session pour les route handlers
│   └── __tests__/
│       ├── db.test.ts        # Tests d'isolation multi-tenant (Vitest) sur src/lib/db.ts
│       ├── auth.test.ts      # Tests d'intégration HTTP : register/login/logout/me
│       ├── tenants.test.ts   # Tests CRUD tenants + isolation multi-tenant
│       ├── agencies.test.ts  # Tests CRUD agencies + isolation multi-tenant/multi-agence
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

Aucun autre dossier (`components/`, `server/`, `data/`, `tests/`, etc.) n'existe à ce jour. `src/lib` accueille la couche d'accès aux données technique et la configuration d'authentification — l'emplacement exact de la future logique **métier** (véhicules, réservations…) reste **À DÉCIDER** (voir section 3). Il n'existe encore aucune page d'interface (`/login`, `/dashboard`, etc.) : seules les routes API existent.

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
| `prisma/schema.prisma` | Schéma de données : `Tenant`, `Agency`, `User` (`passwordHash`, `role`), `UserAgency`, isolation par `tenantId`/`agencyId` ; `Account`/`Session`/`VerificationToken` pour l'adaptateur NextAuth (OAuth futur, non utilisés pour les sessions actuelles). |
| `src/lib/prisma.ts` | Singleton `PrismaClient`, réutilisé en développement pour éviter l'épuisement de connexions au hot reload Next.js. |
| `src/lib/db.ts` | Couche d'accès aux données minimale : `getTenantById`, `getAgencyById`, `getUserById`, chacune filtrée par `tenantId` côté serveur. |
| `src/lib/auth.ts` | Configuration NextAuth v5 : `CredentialsProvider` (email/password, `bcryptjs`), sessions JWT, callbacks `jwt`/`session` (portent `id`/`tenantId`/`role`), exporte `handlers`/`auth`/`signIn`/`signOut`. |
| `src/lib/authz.ts` | `getSessionUser()` — récupère l'utilisateur de la session courante pour les route handlers ; ne fait aucune vérification de rôle/tenant (à la charge de chaque route). |
| `src/proxy.ts` | Redirection optimiste vers `/login` pour `/dashboard*`/`/settings*` si non authentifié (lecture du JWT côté cookie uniquement, pas de requête base de données). |
| `src/app/api/auth/register/route.ts` | Crée un `Tenant` et son premier `User` (`role: "ADMIN"`), mot de passe haché avec `bcryptjs`. |
| `src/app/api/auth/login/route.ts` | Authentifie via `signIn("credentials", …)`, retourne le même message d'erreur pour mot de passe incorrect et compte inexistant. |
| `src/app/api/tenants/route.ts`, `[id]/route.ts` | CRUD `Tenant`, réservé aux `ADMIN`, strictement scopé au tenant de l'utilisateur connecté (jamais de liste globale). |
| `src/app/api/agencies/route.ts`, `[id]/route.ts` | CRUD `Agency`, scopé tenant ; lecture ouverte aux `MEMBER` explicitement rattachés via `UserAgency`, écriture réservée aux `ADMIN`. |
| `src/__tests__/db.test.ts` | Tests Vitest vérifiant qu'`getAgencyById`/`getUserById` ne retournent jamais une ressource d'un autre tenant ; crée puis nettoie ses propres données dans `xrent_test`. |
| `src/__tests__/auth.test.ts`, `tenants.test.ts`, `agencies.test.ts` | Tests d'intégration HTTP contre un vrai serveur `next dev` de test (voir `vitest.global-setup.ts`) : authentification, CRUD, isolation multi-tenant/multi-agence. |

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

- Tenants (CRUD implémenté, Sprint 3)
- Agences (CRUD implémenté, Sprint 3)
- Utilisateurs et rôles (inscription + rôles `ADMIN`/`MEMBER` implémentés, Sprint 3 ; invitation d'utilisateurs et granularité fine des permissions restent À DÉCIDER)
- Véhicules et catégories de véhicules
- Réservations
- Contrats
- Clients
- Paiements
- Cautions
- Incidents (véhicule/location)
- Audit
- Export / Import
- Dashboard-admin

Le détail des règles associées à chaque domaine est en cours de définition dans [DOMAINRULES.md](./DOMAINRULES.md) ; beaucoup de points y sont marqués **À DÉCIDER**.

## 5. Séparation entre interface, logique serveur, accès aux données et sécurité

Principe cible (non encore implémenté, détaillé dans [ARCHITECTURE.md](./ARCHITECTURE.md)) :

- **Interface** (`src/app`, `src/components`) : présentation, ne doit contenir aucune logique d'autorisation ni aucun secret.
- **Logique serveur** (server actions / routes serveur) : validation des entrées, application des règles métier, vérification systématique de l'identité, du rôle, du tenant, de l'agence et de l'appartenance de la ressource.
- **Accès aux données** (`src/lib`, nom définitif toujours **À DÉCIDER**) : `src/lib/db.ts` centralise les lectures scopées `tenantId` réutilisées par `/api/agencies*` ; les routes `/api/tenants*` interrogent Prisma directement avec filtrage explicite (pas encore consolidé dans `db.ts`).
- **Sécurité** (transverse) : authentification, autorisation, audit — ne doit jamais être contournable depuis la couche interface. **Authentification et autorisation implémentées (Sprint 3)** : `src/lib/auth.ts`, `src/lib/authz.ts`, vérifications explicites dans chaque route API. **Audit toujours non implémenté** (voir [HANDOFF.md](./HANDOFF.md) section 3).

Cette séparation existe désormais en grande partie en code (accès aux données, authentification, autorisation serveur) ; l'interface et la logique **métier** restent à construire — aucune page (`login`, `dashboard`, etc.) n'existe encore, seules les routes API.

## 6. Fichiers qui ne doivent jamais contenir de secrets

- Tout fichier suivi par git en clair : `next.config.ts`, `package.json`, tout fichier sous `src/`, tout fichier de documentation (`*.md`).
- `.env*` est déjà exclu du suivi git via `.gitignore` — les secrets doivent exclusivement y résider (ou dans un gestionnaire de secrets externe), jamais dans le code source ni dans la documentation.
- Aucun exemple de clé, token ou identifiant réel ne doit être inséré, même à titre d'illustration, dans un document de ce dépôt.
