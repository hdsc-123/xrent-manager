# HANDOFF.md — Transmission du projet

Document destiné à toute personne (ou assistant IA) reprenant le projet, pour comprendre rapidement où en est XRent Manager sans avoir à relire tout l'historique.

Dernière mise à jour : 2026-08-11 — Sprint 0.

## 1. État actuel

Le projet est au stade **Sprint 0 — fondation documentaire**. Le dépôt contient :

- un socle Next.js 16.3.0 par défaut (généré via `create-next-app`, non modifié fonctionnellement) ;
- TypeScript, ESLint, Tailwind CSS v4, App Router, dossier `src/`, alias `@/*` ;
- la page d'accueil et le layout par défaut fournis par `create-next-app` (aucune page métier) ;
- la documentation fondatrice du projet (ce document et les huit autres listés dans [README.md](./README.md)).

Le dépôt est un dépôt git local (branche `main`) **sans aucun commit** au moment de la rédaction de ce document, et sans dépôt distant configuré.

## 2. Ce qui est terminé

- Initialisation du projet Next.js (TypeScript, ESLint, Tailwind CSS, App Router, `src/`, alias `@/*`).
- Validation de `npm run lint` (aucune erreur).
- Validation de `npm run build` (build de production réussi, 2 routes statiques : `/` et `/_not-found`).
- Documentation fondatrice (Sprint 0) : CLAUDE.md, HANDOFF.md, PROJECT_MAP.md, ARCHITECTURE.md, DOMAINRULES.md, SECURITY.md, TESTREPORT.md, INCIDENTS.md, README.md.

## 3. Ce qui n'est pas commencé

- Tout module métier (véhicules, catégories, réservations, contrats, clients, paiements, cautions, incidents de location).
- Toute base de données, ORM ou schéma (Prisma ou autre).
- Toute authentification ou gestion de session.
- Toute notion de tenant/agence implémentée en code (le concept est défini au niveau documentaire uniquement, voir [DOMAINRULES.md](./DOMAINRULES.md)).
- Le dashboard-admin.
- Toute stratégie de test automatisé (aucun framework de test n'est installé).
- Le premier commit git.
- Tout environnement de test, staging ou production réel.

## 4. Prochaine action recommandée

Attendre la validation du propriétaire du projet sur les points listés en section 7 avant d'engager le Sprint 1. Aucune action de code métier ne doit être entreprise avant cette validation, conformément à [CLAUDE.md](./CLAUDE.md).

Une fois validé, le Sprint 1 devra a minima statuer sur : le choix de la base de données/ORM, le modèle d'isolation multi-tenant, et la stratégie d'authentification — ces trois points conditionnent la quasi-totalité de l'architecture (voir [ARCHITECTURE.md](./ARCHITECTURE.md)).

## 5. Commandes déjà validées

| Commande | Statut | Résultat observé |
|---|---|---|
| `npm run lint` | ✅ Validé | Aucune erreur ESLint |
| `npm run build` | ✅ Validé | Build de production réussi (Turbopack, Next.js 16.3.0) |

Aucune autre commande (test, migration, seed, déploiement) n'a été exécutée ni n'existe dans `package.json` à ce jour.

## 6. Décisions prises

- Le projet sera un SaaS multi-tenant et multi-agence, mobile-first, avec dashboard-admin dès le MVP (décision produit initiale, confirmée par le brief de démarrage).
- Aucun montant financier ne sera représenté en `float`.
- Aucune carte bancaire ne sera stockée en clair.
- Toute action sensible sera validée côté serveur.
- La phase actuelle est strictement documentaire : aucun code métier, schéma de données, authentification ou dépendance non nécessaire ne doit être ajouté sans validation explicite.

Aucune décision technique définitive (base de données, ORM, fournisseur d'authentification, fournisseur de paiement, hébergement) n'a encore été prise — voir section 7.

## 7. Risques identifiés

- **Absence de tests** : aucun module métier ne pourra être considéré comme fiable sans stratégie de test mise en place avant ou en parallèle du développement (voir [TESTREPORT.md](./TESTREPORT.md)).
- **Isolation multi-tenant non implémentée** : c'est une exigence de sécurité, pas seulement fonctionnelle ; un mauvais choix initial d'architecture serait coûteux à corriger a posteriori.
- **Absence de commit git** : tout travail actuel n'est pas encore historisé ; un premier commit devra être fait dès validation de cette documentation.
- **Aucune stratégie de gestion des paiements/cautions définie** : à trancher avant tout développement du module paiement, en particulier le choix d'un prestataire évitant le stockage de données de carte bancaire en clair.

## 8. Points à valider avec le propriétaire du projet

Voir la liste consolidée des points **À DÉCIDER** dans [DOMAINRULES.md](./DOMAINRULES.md), [ARCHITECTURE.md](./ARCHITECTURE.md) et [SECURITY.md](./SECURITY.md). En particulier :

1. Choix de la base de données et de l'ORM (Prisma pressenti mais non installé, non confirmé).
2. Modèle précis d'isolation multi-tenant (colonne partagée vs schémas séparés vs bases séparées).
3. Fournisseur/stratégie d'authentification (solution maison vs service tiers).
4. Fournisseur de paiement et de tokenisation des cartes bancaires.
5. Représentation exacte des montants financiers (entier en plus petite unité vs type décimal).
6. Fuseau horaire de référence pour les réservations/contrats (stockage UTC supposé, à confirmer) et gestion des fuseaux locaux par agence.
7. Périmètre exact du MVP (quels modules métier sont inclus dans la première version livrable).
8. Stratégie d'hébergement et d'environnements (dev/test/staging/production).
