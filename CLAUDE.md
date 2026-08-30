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

À la date de ce document, le projet est très au-delà du Sprint 13E : authentification (dont MFA opt-in, Phases 3A à 3C), multi-tenant/multi-agence, véhicules, réservations, contrats/locations (dont chaînes de prolongation et surclassements), facturation (dont factures de dégâts), paiements, caisse, maintenance, alertes, transferts entre agences, bons de déplacement, permissions granulaires, audit, rate limiting d'authentification, super admin plateforme (création de tenant uniquement) sont livrés et testés. Dernier commit connu : `426bfaa` (« fix: stabilize concurrency and test infrastructure »), branche `main` propre et synchronisée avec `origin/main`. **Aucun environnement de production n'existe à ce jour.** Voir [PROJECT_MAP.md](./PROJECT_MAP.md) pour l'état réel des dossiers et [HANDOFF.md](./HANDOFF.md) section 0 pour l'état de reprise détaillé et à jour.

## 2. Règles impératives

1. Ne jamais présenter une fonctionnalité comme existante si elle ne l'est pas dans le code.
2. Toujours distinguer : **existant**, **décidé**, **prévu**, **À DÉCIDER**.
3. Ne jamais inventer d'information technique non vérifiée (dépendance, API, comportement).
4. Ne pas modifier `package.json` sauf nécessité absolue et explicitement validée.
5. Ne pas supprimer de fichier existant sans instruction explicite.
6. Ne pas créer de fonctionnalité métier, de schéma de base de données, de migration ou d'authentification sans validation préalable du propriétaire du projet.
7. Ne pas créer de données fictives (fake data / seed) dans l'application.
8. Respecter le bloc `AGENTS.md` généré par `next dev` (voir [AGENTS.md](./AGENTS.md)) : ce bloc peut différer des connaissances par défaut sur Next.js — lire la documentation locale dans `node_modules/next/dist/docs/` avant d'écrire du code lié à Next.js.
9. Ne jamais désactiver, affaiblir ou contourner un test existant pour faire passer une implémentation — corriger la cause réelle.
10. Toute anomalie découverte pendant une tâche doit être corrigée (avec test de non-régression), pas seulement documentée, sauf instruction explicite contraire du propriétaire du projet limitant la portée à une inspection.
11. Ne jamais utiliser le compte réel `saadscott123@gmail.com` (Super Admin plateforme, tenant `XRent Platform`) pour un test ou une donnée de démonstration — toute validation manuelle doit passer par un tenant et des comptes de test dédiés et isolés, créés via le parcours applicatif officiel, avec identifiants stockés uniquement dans un fichier `.env*.local` local (jamais suivi par Git, jamais dans un commit/log/rapport).
12. Aucun commit ni push ne peut être effectué sans autorisation explicite du propriétaire du projet pour cette action précise — une autorisation donnée pour une action ne vaut pas pour les suivantes. Avant tout push, vérifier les commits locaux, l'absence de divergence avec `origin/main`, et le contenu exact envoyé.
13. `role === "ADMIN"` + permission `audit.delete` (gestion de l'audit à l'intérieur d'un tenant) et le Super Admin plateforme (`SUPER_ADMIN_EMAILS`, capacité strictement limitée à la création d'un tenant via `POST /api/tenants`) sont deux mécanismes distincts et non interchangeables — voir [SECURITY.md](./SECURITY.md) sections 13 et 33-45 et [DOMAINRULES.md](./DOMAINRULES.md) sections 62 et 72 pour le détail exact avant toute décision ou implémentation les concernant. Définition métier confirmée (2026-08-30) : le « Super Admin » au sens suppression d'audit désigne l'administrateur principal **de son propre tenant** (`role === "ADMIN"`) — `can()` court-circuite sur ce rôle avant toute consultation de `PermissionGroup`/`UserPermission` (`src/lib/permissions.ts`), si bien que **tout** `ADMIN` d'un tenant passe de fait les deux conditions du garde-fou sans affectation explicite (vérifié par `src/__tests__/audit-deletion.test.ts`). `isSuperAdminEmail()` (Super Admin plateforme) n'est référencée dans aucune route d'audit — un Super Admin plateforme qui ne serait pas lui-même `ADMIN` du tenant concerné n'obtient donc aucun accès à la suppression de son audit.

## 3. Règles de sécurité

- Aucune donnée sensible ne doit être codée en dur (secrets, clés, identifiants).
- Aucune carte bancaire ne doit jamais être stockée en clair, ni même envisagée comme telle dans un schéma futur — la tokenisation via un prestataire de paiement conforme PCI-DSS est la seule option prévue (voir [SECURITY.md](./SECURITY.md)).
- Toute action sensible (création, modification, suppression, changement d'état, accès à des données d'un autre tenant/agence) doit être validée **côté serveur**, jamais uniquement côté client.
- La séparation entre tenants et entre agences est une contrainte de sécurité, pas une simple règle d'affichage. Voir [SECURITY.md](./SECURITY.md) et [ARCHITECTURE.md](./ARCHITECTURE.md).
- Détail complet des règles de sécurité : [SECURITY.md](./SECURITY.md).

## 4. Règles financières

- Aucun montant financier ne doit être représenté ou calculé en `float`/`double`. Décidé (Sprint 1) : tout montant financier est un entier exprimé dans la plus petite unité monétaire (centimes), toujours accompagné d'un champ `currency` explicite — voir [DOMAINRULES.md](./DOMAINRULES.md) section 14.
- Toute règle de calcul financier (prix, caution, remboursement, pénalité) doit être documentée dans [DOMAINRULES.md](./DOMAINRULES.md) avant implémentation.

## 5. Règles multi-tenant et multi-agence

- Chaque enregistrement métier est rattaché sans ambiguïté à un tenant, et selon le cas à une agence (`tenantId`/`agencyId`, voir `prisma/schema.prisma`).
- Aucune requête ne doit pouvoir retourner des données d'un tenant à un autre, y compris par erreur de filtrage côté client.
- Décidé (Sprint 1) : l'isolation repose sur une colonne `tenant_id` partagée entre tenants dans les mêmes tables (pas de schémas ni de bases séparées) — isolation **logique**, appliquée côté serveur à chaque requête (`src/lib/authz.ts`, `getAccessibleAgencyIds()`). Voir [ARCHITECTURE.md](./ARCHITECTURE.md) section « Multi-tenant/multi-agence » et [SECURITY.md](./SECURITY.md) section 1.

## 6. Commandes actuellement disponibles

Définies dans `package.json` :

| Commande | Effet |
|---|---|
| `npm run dev` | Démarre le serveur de développement Next.js |
| `npm run build` | Build de production Next.js (validé ✅) |
| `npm run start` | Démarre le serveur en mode production (build requis au préalable) |
| `npm run lint` | Lint ESLint (validé ✅) |
| `npm run test` | Suite de tests Vitest (validé ✅ — voir [TESTREPORT.md](./TESTREPORT.md)) |
| `npx prisma migrate dev` / `npx prisma migrate deploy` | Applique les migrations de base de données (voir `prisma/migrations/`) |

Aucune commande de seed n'existe à ce jour — voir règle 7 du présent document (pas de données fictives dans l'application).

## 7. Règles de modification du code

- Ne modifier que ce qui est strictement nécessaire à la tâche demandée.
- Ne pas installer de dépendance non nécessaire à la tâche en cours.
- Ne pas modifier la configuration Next.js (`next.config.ts`, `tsconfig.json`, `eslint.config.mjs`) sans besoin explicite.
- Toute introduction de nouvelle abstraction, module, ou dossier doit correspondre à un besoin réel exprimé, pas à une anticipation.
- Documenter chaque module métier lors de sa création (voir principe produit de documentation systématique).
- Tester chaque module métier lors de sa création (voir [TESTREPORT.md](./TESTREPORT.md)).

## 8. Interdiction de coder sans validation

**Aucun code métier ne doit être écrit sans validation explicite préalable du propriétaire du projet.** Cela inclut : schéma de base de données, authentification, pages ou routes métier, logique de réservation/contrat/paiement, migrations. Cette règle reste pleinement en vigueur malgré l'avancement du projet (voir section 1) : chaque sprint listé dans [HANDOFF.md](./HANDOFF.md) a fait l'objet d'un brief explicite du propriétaire du projet avant implémentation (ou, pour les rares décisions prises en cours d'implémentation, d'une documentation a posteriori marquée « à confirmer » — voir [docs/decisions/open-items-tracker.md](docs/decisions/open-items-tracker.md)).

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

## 11. Méthode de livraison efficace

Cette méthode est permanente pour ce projet et prévaut sur toute habitude par défaut, jusqu'à instruction contraire explicite du propriétaire du projet :

- Analyser rapidement, mais anticiper plusieurs coups à l'avance avant d'agir.
- Traiter tout le périmètre documentaire ou fonctionnel lié à une tâche donnée en une seule phase cohérente, plutôt que par petits bouts.
- Implémenter directement une fois l'analyse suffisante — ne pas se limiter à un rapport quand une correction est demandée.
- Corriger les problèmes découverts en cours de tâche, ne pas se contenter de les documenter (sauf instruction contraire ou portée explicitement limitée par le propriétaire du projet — voir règle 10).
- Ne jamais désactiver, affaiblir ou contourner un test (règle 9).
- Préserver les fonctionnalités déjà validées.
- Privilégier une solution robuste, déterministe et maintenable à un correctif rapide fragile.
- Exécuter les contrôles adaptés après toute modification (lint/typecheck/tests pertinents), sans nécessairement relancer toute la suite si la modification ne le justifie pas.
- Fournir un seul rapport final clair par tâche, plutôt que des mises à jour fragmentées.
- Ne demander une validation au propriétaire du projet que pour une décision réellement bloquante : migration sensible, nouvelle dépendance, changement d'architecture, commit, push — pas pour chaque étape intermédiaire.
- Ne créer aucun commit ni push sans autorisation explicite (règle 12).
