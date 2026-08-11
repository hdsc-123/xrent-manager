@AGENTS.md

# CLAUDE.md — Instructions pour les assistants IA et les développeurs

Ce document est la référence impérative pour tout assistant IA (Claude Code ou autre) et tout développeur travaillant sur **XRent Manager**. Il prévaut sur toute habitude ou convention par défaut.

Documents associés : [README.md](./README.md) · [HANDOFF.md](./HANDOFF.md) · [PROJECT_MAP.md](./PROJECT_MAP.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [DOMAINRULES.md](./DOMAINRULES.md) · [SECURITY.md](./SECURITY.md) · [TESTREPORT.md](./TESTREPORT.md) · [INCIDENTS.md](./INCIDENTS.md)

## 1. Rôle du projet

XRent Manager est un **SaaS de gestion de location de véhicules**, conçu dès le départ pour être :

- **multi-tenant** (plusieurs organisations clientes isolées les unes des autres) ;
- **multi-agence** (chaque tenant peut opérer plusieurs agences/points de location) ;
- **mobile-first** dans son approche d'interface ;
- doté d'un **dashboard-admin** dès le MVP.

À la date de ce document, le projet est au stade **Sprint 0 (fondation)** : uniquement le socle Next.js par défaut et la documentation. Aucun module métier (véhicules, réservations, contrats, paiements, etc.) n'existe encore. Voir [PROJECT_MAP.md](./PROJECT_MAP.md) pour l'état réel des dossiers et [HANDOFF.md](./HANDOFF.md) pour l'état d'avancement.

## 2. Règles impératives

1. Ne jamais présenter une fonctionnalité comme existante si elle ne l'est pas dans le code.
2. Toujours distinguer : **existant**, **décidé**, **prévu**, **À DÉCIDER**.
3. Ne jamais inventer d'information technique non vérifiée (dépendance, API, comportement).
4. Ne pas modifier `package.json` sauf nécessité absolue et explicitement validée.
5. Ne pas supprimer de fichier existant sans instruction explicite.
6. Ne pas créer de fonctionnalité métier, de schéma de base de données, de migration ou d'authentification sans validation préalable du propriétaire du projet.
7. Ne pas créer de données fictives (fake data / seed) dans l'application.
8. Respecter le bloc `AGENTS.md` généré par `next dev` (voir [AGENTS.md](./AGENTS.md)) : ce bloc peut différer des connaissances par défaut sur Next.js — lire la documentation locale dans `node_modules/next/dist/docs/` avant d'écrire du code lié à Next.js.

## 3. Règles de sécurité

- Aucune donnée sensible ne doit être codée en dur (secrets, clés, identifiants).
- Aucune carte bancaire ne doit jamais être stockée en clair, ni même envisagée comme telle dans un schéma futur — la tokenisation via un prestataire de paiement conforme PCI-DSS est la seule option prévue (voir [SECURITY.md](./SECURITY.md)).
- Toute action sensible (création, modification, suppression, changement d'état, accès à des données d'un autre tenant/agence) doit être validée **côté serveur**, jamais uniquement côté client.
- La séparation entre tenants et entre agences est une contrainte de sécurité, pas une simple règle d'affichage. Voir [SECURITY.md](./SECURITY.md) et [ARCHITECTURE.md](./ARCHITECTURE.md).
- Détail complet des règles de sécurité : [SECURITY.md](./SECURITY.md).

## 4. Règles financières

- Aucun montant financier ne doit être représenté ou calculé en `float`/`double`. Les montants doivent utiliser une représentation exacte (entiers en plus petite unité monétaire, ou type décimal exact) — le choix précis du type est **À DÉCIDER** (voir [DOMAINRULES.md](./DOMAINRULES.md)).
- Toute règle de calcul financier (prix, caution, remboursement, pénalité) doit être documentée dans [DOMAINRULES.md](./DOMAINRULES.md) avant implémentation.

## 5. Règles multi-tenant et multi-agence

- Chaque enregistrement métier futur devra être rattaché sans ambiguïté à un tenant, et selon le cas à une agence.
- Aucune requête ne doit pouvoir retourner des données d'un tenant à un autre, y compris par erreur de filtrage côté client.
- Le modèle précis d'isolation (colonne `tenant_id` partagée, schémas séparés, bases séparées) est **À DÉCIDER** — voir [ARCHITECTURE.md](./ARCHITECTURE.md).

## 6. Commandes actuellement disponibles

Définies dans `package.json` :

| Commande | Effet |
|---|---|
| `npm run dev` | Démarre le serveur de développement Next.js |
| `npm run build` | Build de production Next.js (validé ✅) |
| `npm run start` | Démarre le serveur en mode production (build requis au préalable) |
| `npm run lint` | Lint ESLint (validé ✅) |

Aucune commande de test, de migration de base de données ou de seed n'existe à ce jour.

## 7. Règles de modification du code

- Ne modifier que ce qui est strictement nécessaire à la tâche demandée.
- Ne pas installer de dépendance non nécessaire à la tâche en cours.
- Ne pas modifier la configuration Next.js (`next.config.ts`, `tsconfig.json`, `eslint.config.mjs`) sans besoin explicite.
- Toute introduction de nouvelle abstraction, module, ou dossier doit correspondre à un besoin réel exprimé, pas à une anticipation.
- Documenter chaque module métier lors de sa création (voir principe produit de documentation systématique).
- Tester chaque module métier lors de sa création (voir [TESTREPORT.md](./TESTREPORT.md)).

## 8. Interdiction de coder sans validation

**Aucun code métier ne doit être écrit sans validation explicite préalable du propriétaire du projet.** Cela inclut : schéma de base de données, authentification, pages ou routes métier, logique de réservation/contrat/paiement, migrations. La phase actuelle (Sprint 0) est strictement documentaire.

## 9. Règles d'utilisation de /clear, /compact, /usage et /cost

- `/clear` : à utiliser entre deux tâches indépendantes pour repartir sur un contexte propre, une fois la tâche en cours validée et documentée (HANDOFF.md à jour).
- `/compact` : à utiliser si une session longue doit se poursuivre mais que le contexte devient volumineux ; vérifier après compactage que les décisions clés (règles métier, sécurité, points À DÉCIDER) sont toujours correctement reflétées dans les documents, pas seulement dans le contexte de conversation.
- `/usage` et `/cost` : à consulter pour suivre la consommation ; aucune règle métier associée, usage libre pour le suivi.
- Ne jamais compter sur la mémoire de conversation pour conserver une décision importante : toute décision structurante doit être écrite dans les documents (`HANDOFF.md`, `DOMAINRULES.md`, `ARCHITECTURE.md`).

## 10. Procédure à suivre avant toute nouvelle tâche

1. Lire [HANDOFF.md](./HANDOFF.md) pour connaître l'état actuel et les points en attente de validation.
2. Lire [PROJECT_MAP.md](./PROJECT_MAP.md) pour connaître la structure réelle du dépôt.
3. Vérifier que la tâche demandée est cohérente avec les règles impératives ci-dessus.
4. En cas de doute sur une règle métier, consulter [DOMAINRULES.md](./DOMAINRULES.md) ; si la règle y est marquée **À DÉCIDER**, ne pas trancher seul — demander confirmation.
5. En cas d'implication sécurité ou financière, consulter [SECURITY.md](./SECURITY.md) avant d'écrire du code.
6. Après la tâche, mettre à jour [HANDOFF.md](./HANDOFF.md) (et [TESTREPORT.md](./TESTREPORT.md) / [INCIDENTS.md](./INCIDENTS.md) si applicable).
