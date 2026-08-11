# HANDOFF.md — Transmission du projet

Document destiné à toute personne (ou assistant IA) reprenant le projet, pour comprendre rapidement où en est XRent Manager sans avoir à relire tout l'historique.

Dernière mise à jour : 2026-08-11 — Sprint 4 (dashboard admin + UI de base) validé : shadcn/ui, pages `/login`/`/register`/`/dashboard/*` (tenants, agences, utilisateurs en lecture seule, paramètres), table TanStack, tests HTTP sur le rendu des pages. Toujours aucun module métier (véhicules, réservations, contrats…).

## 1. État actuel

Le projet est au stade **Sprint 4 — dashboard admin et UI de base**. Le dépôt contient désormais, en plus des sprints précédents :

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

Le dépôt est un dépôt git (branche `main`) avec un commit initial : `e673184` — "chore: initialize XRent Manager project". Le remote `origin` est configuré vers le dépôt GitHub privé `https://github.com/hdsc-123/xrent-manager.git`, et `main` est synchronisée avec `origin/main`. Le tag `v0.1.0` a été créé et envoyé, correspondant au socle initial.

Les principes d'architecture validés lors du Sprint 1 (voir section 6) sont désormais **largement implémentés** : socle de données, authentification, autorisation serveur (tenant/agence/rôle) en place ; audit et tout module métier restent non implémentés (voir section 3).

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

## 3. Ce qui n'est pas commencé

- Tout module métier (véhicules, catégories, réservations, contrats, clients, paiements, cautions, incidents de location).
- Modification de rôle et suppression d'utilisateurs, invitation effective dans un tenant existant (voir section 8, points 2 et 17) — `/dashboard/users` est volontairement en lecture seule (Sprint 4).
- Édition du profil utilisateur (nom, email, mot de passe) — aucune route de mutation du profil n'existe encore.
- Limitation du nombre de tentatives de connexion, réinitialisation de mot de passe, MFA (voir [SECURITY.md](./SECURITY.md) section 3).
- Tout rôle transverse à plusieurs tenants ("superadmin" plateforme) — seul `ADMIN`, scopé à un tenant, existe.
- Toute table ou mécanisme d'audit (décidé en principe, non implémenté — voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 12).
- Fuseau horaire par agence (aucun champ `timezone` sur `Agency`).
- Tout environnement de staging ou de production réel.
- Tout script de seed de développement.

## 4. Prochaine action recommandée

L'authentification, l'autorisation serveur (tenant/agence/rôle), le CRUD `Tenant`/`Agency` et une UI dashboard de base étant en place (Sprints 3–4), la prochaine étape reste conditionnée par les décisions encore ouvertes (section 8) — en particulier le périmètre exact du MVP et le premier module métier à construire (véhicules ? réservations ?), ainsi que le flux d'invitation/gestion d'utilisateurs dans un tenant existant (nécessaire pour sortir `/dashboard/users` de son mode lecture seule). Conformément à [CLAUDE.md](./CLAUDE.md), aucun code métier ou dépendance supplémentaire ne doit être ajouté sans validation explicite distincte de celle de ce sprint.

## 5. Commandes déjà validées

| Commande | Statut | Résultat observé |
|---|---|---|
| `npm run lint` | ✅ Validé | Aucune erreur ESLint |
| `npm run test` | ✅ Validé | 46/46 tests passés (Vitest) — isolation multi-tenant/multi-agence, authentification, CRUD, rendu des pages UI, aucune donnée résiduelle après nettoyage |
| `npm run build` | ✅ Validé | Build de production réussi (Turbopack, Next.js 16.3.0), TypeScript strict sans erreur, 11 routes API + 9 pages `/dashboard/*` + `/login`/`/register` + Proxy |

Aucune commande de migration de production, de seed ou de déploiement n'a été exécutée à ce jour.

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
- Montants financiers en entiers, exprimés dans la plus petite unité monétaire, avec devise stockée explicitement à côté de chaque montant — non implémenté (aucun modèle financier à ce jour).
- Dates stockées en UTC, affichées selon le fuseau horaire de l'agence — non implémenté (aucun champ de fuseau horaire sur `Agency` à ce jour, voir section 8).
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

Décisions techniques encore ouvertes : voir section 8.

## 7. Risques identifiés

- **Résolution du tenant à la connexion ambiguë** : `User.email` n'est unique que par tenant (`@@unique([tenantId, email])`). `/api/auth/login` résout l'utilisateur par email seul (`findFirst`) ; si deux tenants différents utilisent un jour le même email, ce lookup devient ambigu. Aucun mécanisme de désambiguïsation (sous-domaine, sélection de tenant explicite) n'existe — voir [SECURITY.md](./SECURITY.md) section 3 et section 8 point 16 ci-dessous.
- **Sessions JWT non révocables côté serveur** : la déconnexion efface le cookie mais un jeton déjà émis reste valide jusqu'à expiration (pas de table de sessions consultée à chaque requête). Acceptable pour ce sprint, mais à réévaluer si un besoin de révocation immédiate apparaît (ex. compromission de compte) — voir [SECURITY.md](./SECURITY.md) section 5.
- **Aucune limitation des tentatives de connexion** : `/api/auth/login` n'implémente aucun rate-limiting — risque de brute force, à traiter avant mise en production (voir [SECURITY.md](./SECURITY.md) section 3).
- **Aucune stratégie de gestion des paiements/cautions définie** : à trancher avant tout développement du module paiement, en particulier le choix d'un prestataire évitant le stockage de données de carte bancaire en clair.

## 8. Points à valider avec le propriétaire du projet

Les points suivants restent explicitement **À DÉCIDER**. Détail dans [DOMAINRULES.md](./DOMAINRULES.md), [ARCHITECTURE.md](./ARCHITECTURE.md) et [SECURITY.md](./SECURITY.md) :

1. ~~Fournisseur d'authentification et stratégie MFA.~~ Fournisseur tranché (NextAuth.js v5, Sprint 3) ; **MFA reste À DÉCIDER**.
2. Rôles et permissions détaillés au-delà de `ADMIN`/`MEMBER` (granularité par module/action).
3. Devise initiale et support multi-devises.
4. Règles d'arrondi financier.
5. Prestataire de paiement et modalités des cautions.
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

Framework de test : **tranché** (Vitest, voir section 2) — les outils e2e et de test de charge restent À DÉCIDER.
