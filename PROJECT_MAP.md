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
├── src/
│   └── app/                 # App Router Next.js
│       ├── favicon.ico
│       ├── globals.css      # Styles globaux Tailwind
│       ├── layout.tsx       # Layout racine par défaut
│       └── page.tsx         # Page d'accueil par défaut (démo create-next-app)
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
├── package.json                 # Dépendances et scripts npm
└── package-lock.json
```

Aucun autre dossier (`components/`, `lib/`, `server/`, `prisma/`, `tests/`, etc.) n'existe à ce jour.

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

- Tenants
- Agences
- Utilisateurs et rôles
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
- **Accès aux données** (future couche dédiée, nom exact À DÉCIDER) : **décision validée (Sprint 1)** — seule couche autorisée à dialoguer avec la base de données ; applique une garde tenant/agence obligatoire à chaque requête.
- **Sécurité** (transverse) : authentification, autorisation, audit — ne doit jamais être contournable depuis la couche interface.

Cette séparation n'existe pas encore en code ; c'est un principe directeur pour les prochains sprints.

## 6. Fichiers qui ne doivent jamais contenir de secrets

- Tout fichier suivi par git en clair : `next.config.ts`, `package.json`, tout fichier sous `src/`, tout fichier de documentation (`*.md`).
- `.env*` est déjà exclu du suivi git via `.gitignore` — les secrets doivent exclusivement y résider (ou dans un gestionnaire de secrets externe), jamais dans le code source ni dans la documentation.
- Aucun exemple de clé, token ou identifiant réel ne doit être inséré, même à titre d'illustration, dans un document de ce dépôt.
