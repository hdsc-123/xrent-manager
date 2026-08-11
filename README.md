# XRent Manager

## Description

XRent Manager est un **SaaS de gestion de location de véhicules**, conçu pour être multi-tenant (plusieurs organisations clientes isolées) et multi-agence (plusieurs points de location par organisation).

## Objectif

Fournir une plateforme permettant à des sociétés de location de véhicules de gérer, par organisation et par agence : leurs véhicules, réservations, contrats, clients, paiements et cautions, avec un dashboard-admin, une isolation stricte des données entre organisations, et une préparation dès la conception à la sécurité, à l'audit et à la production.

## Statut actuel

**Sprint 0 — fondation documentaire.** Le projet contient uniquement le socle Next.js par défaut et sa documentation fondatrice. **Aucun module métier n'est encore développé** : pas de gestion de véhicules, réservations, contrats, clients, paiements, cautions, ni d'authentification, ni de base de données. Voir [HANDOFF.md](./HANDOFF.md) pour l'état détaillé.

## Stack technique

- [Next.js](https://nextjs.org) 16.3.0 (App Router)
- React 19
- TypeScript
- Tailwind CSS v4
- ESLint (`eslint-config-next`)

Aucune base de données, ORM, système d'authentification ou framework de test n'est installé à ce jour.

## Prérequis

- Node.js (version compatible avec Next.js 16 / React 19)
- npm

## Commandes de démarrage

```bash
npm install
npm run dev
```

Ouvrir [http://localhost:3000](http://localhost:3000).

## Commandes lint et build

```bash
npm run lint   # Validé ✅ — aucune erreur
npm run build  # Validé ✅ — build de production réussi
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

**Aucun module métier n'est développé à ce stade du projet.** La page d'accueil actuelle (`src/app/page.tsx`) est la page de démonstration par défaut générée par `create-next-app`, sans lien avec le domaine métier de XRent Manager.
