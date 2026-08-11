# HANDOFF.md — Transmission du projet

Document destiné à toute personne (ou assistant IA) reprenant le projet, pour comprendre rapidement où en est XRent Manager sans avoir à relire tout l'historique.

Dernière mise à jour : 2026-08-11 — Sprint 1 (principes d'architecture validés, aucune implémentation démarrée).

## 1. État actuel

Le projet est au stade **Sprint 1 — cadrage architectural validé**. Le socle applicatif reste identique à celui du Sprint 0 (aucune implémentation nouvelle) ; ce qui change est la validation, par le propriétaire du projet, des principes d'architecture fondamentaux (voir section 6). Le dépôt contient :

- un socle Next.js 16.3.0 par défaut (généré via `create-next-app`, non modifié fonctionnellement) ;
- TypeScript, ESLint, Tailwind CSS v4, App Router, dossier `src/`, alias `@/*` ;
- la page d'accueil et le layout par défaut fournis par `create-next-app` (aucune page métier) ;
- la documentation fondatrice du projet (ce document et les huit autres listés dans [README.md](./README.md)).

Le dépôt est un dépôt git (branche `main`) avec un commit initial : `e673184` — "chore: initialize XRent Manager project". Le remote `origin` est configuré vers le dépôt GitHub privé `https://github.com/hdsc-123/xrent-manager.git`, et `main` est synchronisée avec `origin/main`. Le tag `v0.1.0` a été créé et envoyé, correspondant au socle initial.

Les principes d'architecture validés lors du Sprint 1 (voir section 6) ne sont **pas encore implémentés** : aucune base de données, aucun ORM, aucune authentification, aucun module métier n'existe dans le code à ce jour. Cette validation porte uniquement sur les décisions à appliquer lors des sprints d'implémentation à venir.

## 2. Ce qui est terminé

- Initialisation du projet Next.js (TypeScript, ESLint, Tailwind CSS, App Router, `src/`, alias `@/*`).
- Validation de `npm run lint` (aucune erreur).
- Validation de `npm run build` (build de production réussi, 2 routes statiques : `/` et `/_not-found`).
- Documentation fondatrice (Sprint 0) : CLAUDE.md, HANDOFF.md, PROJECT_MAP.md, ARCHITECTURE.md, DOMAINRULES.md, SECURITY.md, TESTREPORT.md, INCIDENTS.md, README.md.
- Initialisation Git et commit initial (`e673184` — "chore: initialize XRent Manager project") sur la branche `main`.
- Connexion au dépôt GitHub privé `hdsc-123/xrent-manager` (remote `origin`) et synchronisation de `main` avec `origin/main`.
- Création et envoi (push) du tag `v0.1.0`, correspondant au socle initial.
- Validation par le propriétaire du projet des principes d'architecture fondamentaux (Sprint 1) : base de données/ORM cibles, modèle d'isolation multi-tenant/multi-agence, représentation des montants et des dates, séparation des environnements, audit, exports/imports, reset sécurisé, priorités de tests — voir section 6 et le détail dans [ARCHITECTURE.md](./ARCHITECTURE.md), [DOMAINRULES.md](./DOMAINRULES.md), [SECURITY.md](./SECURITY.md). **Aucun de ces principes n'est encore implémenté en code.**

## 3. Ce qui n'est pas commencé

- Tout module métier (véhicules, catégories, réservations, contrats, clients, paiements, cautions, incidents de location).
- Toute base de données, ORM ou schéma (Prisma ou autre).
- Toute authentification ou gestion de session.
- Toute notion de tenant/agence implémentée en code (le concept est défini au niveau documentaire uniquement, voir [DOMAINRULES.md](./DOMAINRULES.md)).
- Le dashboard-admin.
- Toute stratégie de test automatisé (aucun framework de test n'est installé).
- Tout environnement de test, staging ou production réel.

## 4. Prochaine action recommandée

Les principes d'architecture fondamentaux étant validés (section 6), la prochaine étape est le Sprint 2 : mise en place technique de base (installation de Prisma, configuration de PostgreSQL en environnement de développement, premier schéma minimal Tenant/Agency/User, mise en place de la couche d'accès aux données avec garde tenant/agence). Conformément à [CLAUDE.md](./CLAUDE.md), aucune installation de dépendance, aucun schéma, ni aucun code métier ne doit être entrepris sans validation explicite préalable et distincte de celle du Sprint 1 — la validation des principes ne vaut pas validation de leur implémentation.

Le Sprint 2 devra également statuer, avant tout code métier, sur les points encore À DÉCIDER conditionnant l'authentification et les rôles (voir section 8).

## 5. Commandes déjà validées

| Commande | Statut | Résultat observé |
|---|---|---|
| `npm run lint` | ✅ Validé | Aucune erreur ESLint |
| `npm run build` | ✅ Validé | Build de production réussi (Turbopack, Next.js 16.3.0) |

Aucune autre commande (test, migration, seed, déploiement) n'a été exécutée ni n'existe dans `package.json` à ce jour.

## 6. Décisions prises

Décisions produit initiales (Sprint 0) :

- Le projet sera un SaaS multi-tenant et multi-agence, mobile-first, avec dashboard-admin dès le MVP (décision produit initiale, confirmée par le brief de démarrage).
- Aucun montant financier ne sera représenté en `float`.
- Aucune carte bancaire ne sera stockée en clair.
- Toute action sensible sera validée côté serveur.

Principes d'architecture validés (Sprint 1, 2026-08-11) — détail complet dans [ARCHITECTURE.md](./ARCHITECTURE.md), [DOMAINRULES.md](./DOMAINRULES.md) et [SECURITY.md](./SECURITY.md), **aucun non implémenté à ce jour** :

- PostgreSQL comme base de données cible, Prisma comme ORM cible (non installés).
- Isolation multi-tenant par `tenant_id` dans des tables partagées ; rattachement aux agences par `agency_id`.
- Couche d'accès aux données centralisée, avec garde tenant/agence obligatoire.
- Validation côté serveur systématique de l'identité, du rôle, du tenant, de l'agence et de l'appartenance de la ressource.
- Montants financiers en entiers, exprimés dans la plus petite unité monétaire, avec devise stockée explicitement à côté de chaque montant.
- Dates stockées en UTC, affichées selon le fuseau horaire de l'agence.
- Environnements développement, test, staging et production strictement séparés.
- Table d'audit dédiée comme mécanisme technique de traçabilité.
- Exports et imports validés côté serveur et scopés par tenant.
- Reset de données techniquement impossible en environnement de production.
- Tests introduits dès le premier module métier, avec priorité aux tests d'isolation multi-tenant.

La phase actuelle reste strictement documentaire pour tout ce qui précède : aucun code métier, schéma de données, authentification, dépendance ou base de données ne doit être ajouté sans validation explicite distincte (voir section 4).

Décisions techniques encore ouvertes : voir section 8.

## 7. Risques identifiés

- **Absence de tests** : aucun module métier ne pourra être considéré comme fiable sans stratégie de test mise en place avant ou en parallèle du développement (voir [TESTREPORT.md](./TESTREPORT.md)). Priorité aux tests d'isolation multi-tenant dès le premier module concerné (décision Sprint 1).
- **Isolation multi-tenant non implémentée** : le modèle (`tenant_id` partagé) est désormais validé mais reste non implémenté ; le risque porte sur l'application rigoureuse et systématique de la vérification tenant/agence côté serveur pour chaque requête — voir [SECURITY.md](./SECURITY.md) section 1 pour le détail du risque.
- **Aucune stratégie de gestion des paiements/cautions définie** : à trancher avant tout développement du module paiement, en particulier le choix d'un prestataire évitant le stockage de données de carte bancaire en clair.

## 8. Points à valider avec le propriétaire du projet

Les points suivants restent explicitement **À DÉCIDER** après la validation des principes d'architecture du Sprint 1 (voir section 6). Détail dans [DOMAINRULES.md](./DOMAINRULES.md), [ARCHITECTURE.md](./ARCHITECTURE.md) et [SECURITY.md](./SECURITY.md) :

1. Fournisseur d'authentification et stratégie MFA.
2. Rôles et permissions détaillés.
3. Devise initiale et support multi-devises.
4. Règles d'arrondi financier.
5. Prestataire de paiement et modalités des cautions.
6. Hébergeur précis et gestionnaire de secrets en production.
7. Stratégie détaillée de sauvegarde.
8. Outil de test de charge.
9. Périmètre exact du MVP (quels modules métier sont inclus dans la première version livrable).
10. Juridiction cible et périmètre RGPD applicable.
11. Nom et emplacement exacts des dossiers serveur (structure de code).
12. Framework précis de tests (unitaire/intégration/e2e).
13. Formats et périmètre détaillés des exports/imports.
14. Durée de conservation et droits d'accès aux journaux d'audit.
