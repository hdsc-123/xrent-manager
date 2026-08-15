# XRent Manager

## Description

XRent Manager est un **SaaS de gestion de location de véhicules**, conçu pour être multi-tenant (plusieurs organisations clientes isolées) et multi-agence (plusieurs points de location par organisation).

## Objectif

Fournir une plateforme permettant à des sociétés de location de véhicules de gérer, par organisation et par agence : leurs véhicules, réservations, contrats, clients, paiements et cautions, avec un dashboard-admin, une isolation stricte des données entre organisations, et une préparation dès la conception à la sécurité, à l'audit et à la production.

## Statut actuel

**Sprint 10 — MVP production-ready (au sens fonctionnel).** Le projet dispose désormais de l'authentification multi-tenant, de l'autorisation serveur (tenant/agence/rôle), et des modules métier véhicules, locations, clients, facturation, paiements, rapports, maintenance, alertes, gestion des utilisateurs/invitations et journal d'audit exhaustif — voir [HANDOFF.md](./HANDOFF.md) pour l'état détaillé sprint par sprint et les points encore **À DÉCIDER** avant un déploiement en production réelle (aucun environnement de staging/production, aucune stratégie de sauvegarde ou de rate-limiting définie à ce jour).

## Stack technique

- [Next.js](https://nextjs.org) 16.3.0 (App Router, Turbopack)
- React 19, TypeScript strict
- Tailwind CSS v4, shadcn/ui (style `base-nova` sur `@base-ui/react`), lucide-react
- PostgreSQL 17 + [Prisma](https://www.prisma.io) 6.19.3 (ORM)
- [NextAuth.js (Auth.js) v5](https://authjs.dev) — sessions JWT, `CredentialsProvider` (email/mot de passe)
- [Vitest](https://vitest.dev) — tests d'intégration HTTP contre un vrai serveur `next dev` de test
- `@tanstack/react-table` v9, `@react-pdf/renderer` (PDF factures), `papaparse` (export CSV), `recharts` (graphiques rapports)

## Prérequis

- Node.js (version compatible avec Next.js 16 / React 19)
- npm
- PostgreSQL 17 en local (ou accessible en réseau)

## Getting Started — installation locale

1. **Installer les dépendances**

   ```bash
   npm install
   ```

2. **Créer les bases de données PostgreSQL** (une pour le développement, une dédiée aux tests — toujours distinctes, voir [ARCHITECTURE.md](./ARCHITECTURE.md)) :

   ```bash
   createdb xrent_dev
   createdb xrent_test
   ```

3. **Configurer les variables d'environnement.** Copier `.env.example` vers `.env` (développement) et `.env.test` (tests), puis renseigner chaque fichier :

   ```bash
   cp .env.example .env
   cp .env.example .env.test
   ```

   | Variable | Rôle |
   |---|---|
   | `DATABASE_URL` | Chaîne de connexion PostgreSQL — pointer `.env` vers `xrent_dev` et `.env.test` vers `xrent_test` (bases distinctes, voir [SECURITY.md](./SECURITY.md)) |
   | `AUTH_SECRET` | Secret de signature/chiffrement des sessions JWT NextAuth — générer une valeur locale avec `openssl rand -base64 32`, ne jamais réutiliser la même valeur entre environnements, ne jamais commiter |

   `.env*` est exclu du suivi git (`.gitignore`) : ces fichiers ne doivent jamais être commités.

4. **Appliquer les migrations Prisma** sur chacune des deux bases (Prisma CLI charge `.env` automatiquement ; pour cibler `.env.test`, exporter temporairement ses variables dans la commande) :

   ```bash
   npx prisma migrate deploy                                    # applique les migrations existantes sur xrent_dev (lit .env)
   env $(grep -v '^#' .env.test | xargs) npx prisma migrate deploy   # puis sur xrent_test
   ```

   Aucun script de seed n'existe à ce jour (voir [CLAUDE.md](./CLAUDE.md) — pas de données fictives).

5. **Lancer le serveur de développement**

   ```bash
   npm run dev
   ```

   Ouvrir [http://localhost:3000](http://localhost:3000). Créer un compte via `/register` (crée un nouveau tenant + son premier utilisateur, `ADMIN`).

## Commandes disponibles

```bash
npm run dev     # Serveur de développement Next.js
npm run build   # Build de production (Turbopack) — validé ✅
npm run start   # Démarre le serveur en mode production (build requis au préalable)
npm run lint    # Lint ESLint — validé ✅
npm run test    # Suite de tests Vitest (206 tests, contre xrent_test) — validé ✅
```

`npm run test` démarre automatiquement un vrai serveur `next dev` de test (voir `vitest.global-setup.ts`) sur un port dédié, exécute la suite contre `xrent_test`, puis l'arrête — aucune donnée résiduelle n'est laissée après l'exécution (chaque suite nettoie les données qu'elle crée). Voir [TESTREPORT.md](./TESTREPORT.md) pour le détail de la couverture.

Pour une exécution complète et fiable de la suite (recyclage préventif du serveur de test entre groupes de fichiers, résout INC-3 — voir [INCIDENTS.md](./INCIDENTS.md)), utiliser plutôt :

```bash
node scripts/test-grouped.mjs                       # recommandé — 610/610, ~150s
node scripts/test-grouped.mjs --no-file-parallelism  # variante strictement séquentielle, ~195s
```

## Règles importantes

- Aucun montant financier ne doit être représenté en `float`.
- Aucune carte bancaire ne doit être stockée en clair.
- Toute action sensible doit être validée côté serveur.
- Aucun code métier ne doit être écrit sans validation explicite préalable du propriétaire du projet.
- Voir le détail complet des règles dans [CLAUDE.md](./CLAUDE.md).

## Documents de référence

| Document | Contenu |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | Règles impératives pour assistants IA et développeurs |
| [HANDOFF.md](./HANDOFF.md) | État d'avancement et transmission du projet |
| [PROJECT_MAP.md](./PROJECT_MAP.md) | Cartographie de la structure du projet |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Architecture générale prévue |
| [DOMAINRULES.md](./DOMAINRULES.md) | Règles métier |
| [SECURITY.md](./SECURITY.md) | Règles de sécurité |
| [TESTREPORT.md](./TESTREPORT.md) | Suivi des tests |
| [INCIDENTS.md](./INCIDENTS.md) | Suivi des incidents |

## Modules métier

Implémentés (voir [HANDOFF.md](./HANDOFF.md) et [PROJECT_MAP.md](./PROJECT_MAP.md) pour le détail par sprint) : tenants, agences, utilisateurs/rôles/invitations, véhicules, locations (réservation + contrat fusionnés), clients, facturation (avec export PDF), paiements manuels, rapports (revenu, utilisation véhicule, export CSV), maintenance véhicules, alertes (in-app uniquement), journal d'audit exhaustif sur le CRUD métier.

Non implémentés à ce jour : cautions, incidents de location, notifications par email, tout environnement de staging/production réel. Voir [HANDOFF.md](./HANDOFF.md) section 3 pour la liste complète et section 8 pour les points encore **À DÉCIDER**.

La page d'accueil actuelle (`src/app/page.tsx`) reste la page de démonstration par défaut générée par `create-next-app`, sans lien avec le domaine métier de XRent Manager — le point d'entrée applicatif réel est `/login`/`/register` puis `/dashboard/*`.
