# HANDOFF.md — Transmission du projet

Document destiné à toute personne (ou assistant IA) reprenant le projet, pour comprendre rapidement où en est XRent Manager sans avoir à relire tout l'historique. Version courte — l'historique complet est archivé dans [docs/history/](./docs/history/), les décisions techniques/produit dans [docs/decisions/](./docs/decisions/), les rapports de test détaillés dans [docs/test-reports/](./docs/test-reports/) et les procédures dans [docs/runbooks/](./docs/runbooks/). Restructuré le 2026-08-26 (voir [docs/decisions/2026-08-26-documentation-restructuring-plan.md](./docs/decisions/2026-08-26-documentation-restructuring-plan.md)) — aucune information supprimée, tout le contenu antérieur est archivé verbatim.

## 1. État global du projet

XRent Manager est un SaaS de gestion de location de véhicules (multi-tenant, multi-agence), au stade **post-MVP fonctionnel** : authentification, multi-tenant/multi-agence, véhicules, réservations, contrats/locations, facturation, paiements, caisse, maintenance, alertes, transferts entre agences, bons de déplacement, permissions granulaires, audit, prolongations de contrat, dégâts/factures de dégâts, sont implémentés et testés. Aucun environnement de production n'existe à ce jour (développement + test uniquement). Détail exhaustif module par module : [PROJECT_MAP.md](./PROJECT_MAP.md). Règles métier : [DOMAINRULES.md](./DOMAINRULES.md). Architecture et décisions techniques : [ARCHITECTURE.md](./ARCHITECTURE.md). Sécurité : [SECURITY.md](./SECURITY.md).

**Périmètre non commencé** (voir [docs/decisions/open-items-tracker.md](./docs/decisions/open-items-tracker.md) pour le détail complet et à jour des points ouverts) : cautions, incidents de location détaillés, prestataire de paiement en ligne (Stripe/PayPal), notifications par email, MFA, rate limiting d'authentification (spécifié, non implémenté — voir SECURITY.md section 33), environnement de production réel. **Cette liste est datée (Sprint 14E, 2026-08-13) et n'a pas été revérifiée depuis** — à rafraîchir avant de s'y fier pour une décision de sprint ; texte complet archivé dans [docs/history/handoff-sprint-log-archive.md](./docs/history/handoff-sprint-log-archive.md).

**Point de documentation encore ouvert (Finding F, Sprint 27)** : `DOMAINRULES.md` décrirait encore un gate de facturation (`DRAFT → SENT` conditionné au solde) retiré depuis le Sprint 27 — à corriger avant tout nouveau sprint touchant au workflow de facturation, pour ne pas induire en erreur une future lecture. Détail : [docs/history/handoff-changelog-archive.md](./docs/history/handoff-changelog-archive.md) (section « Finding F »).

## 2. Branche et dernier commit

- Branche : `main`
- Dernier commit : `0f9255e` — "fix: stabilize vitest shared server tests"
- Aucun commit créé depuis par les sessions documentées ci-dessous (BUG-001/004/005 + cette restructuration documentaire) — travail présent uniquement dans la copie de travail locale.

## 3. État Git

Working tree avec modifications non commitées (voir `git status --short`) : fichiers de documentation (`ARCHITECTURE.md`, `HANDOFF.md`, `INCIDENTS.md`, `SECURITY.md`, `TESTREPORT.md`, nouveau dossier `docs/`) et code applicatif (correction BUG-004/BUG-005/BUG-001, voir section 5). **Aucun commit créé, aucun push effectué** — le propriétaire du projet effectue lui-même le diff/commit/push après revue.

## 4. Environnement de développement

- Base de données de développement : PostgreSQL local, `xrent_dev`.
- Base de données de test : PostgreSQL local, `xrent_test` (dédiée, jamais la même que `xrent_dev`).
- Serveur de développement : `npm run dev` (port 3000). Serveur de test dédié : port 3811, géré automatiquement par `vitest.global-setup.ts`.
- Commandes validées (revérifiées le 2026-08-26) :

| Commande | Résultat |
|---|---|
| `npm run lint` | ✅ Aucune erreur |
| `npx tsc --noEmit` | ✅ Aucune erreur |
| `node scripts/test-grouped.mjs` (suite complète recommandée) | ✅ **1293/1293** tests, 0 échec, 0 timeout, 0 résiduel |
| `npm run build` | ✅ Build de production réussi |

Aucune commande de seed n'existe (CLAUDE.md règle 7). Historique complet des commandes validées sprint par sprint : [docs/history/handoff-sprint-log-archive.md](./docs/history/handoff-sprint-log-archive.md) (ancienne section 5) et [TESTREPORT.md](./TESTREPORT.md) section 1.

## 5. Statut de la campagne de validation QA

Une campagne de validation manuelle du tenant QA fictif (`QA FICTIF - XRent Validation`) est **en cours et reste ouverte**. Procédure complète, données fictives et liste des scénarios : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md).

### Bugs corrigés et vérifiés
- **BUG-001** (modale de création d'un groupe de permissions dépassant le viewport) — corrigé et vérifié.
- **BUG-004** (une location n'était visible que par son agence de départ, jamais par son agence de retour) — corrigé et vérifié.
- **BUG-005** (kilométrage de retour non validé sur le flux générique de mise à jour d'une location) — corrigé et vérifié.

Détail complet de chacun : [INCIDENTS.md](./INCIDENTS.md) INC-6/INC-7/INC-8. Rapport de session complet : [docs/test-reports/2026-08-26-bug-001-004-005.md](./docs/test-reports/2026-08-26-bug-001-004-005.md).

### Bugs ouverts
Aucun bug applicatif connu ouvert à ce jour (au-delà des trois ci-dessus, tous corrigés). Point de documentation ouvert : voir « Finding F » section 1 ci-dessus.

### Scénarios validés (5/56)
Isolation agence RAK/CASA (visibilité croisée, sélecteurs véhicule scopés) ; retour de véhicule RAK→CASA (kilométrage, carburant, transition de statut) sur le contrat n°00002.

### Scénarios non exécutés et non validés (53/56)
**Toujours dans le périmètre du projet** — non écartés, non classés hors périmètre. Reportés à la prochaine session en raison de la limite de temps/session disponible dans la session du 2026-08-26, pas d'un choix de les exclure. Liste complète et ordre d'exécution recommandé : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 6. **La campagne de validation globale reste ouverte — elle ne peut pas être déclarée complète.**

### Données fictives importantes
Tenant `QA FICTIF - XRent Validation`, agences RAK/CASA, 7 véhicules, 7 clients. **Le contrat fictif n°00002 est passé de `ACTIVE` à `COMPLETED` pendant la vérification en direct de BUG-004/BUG-005** (kilométrage retour 28450, carburant Plein) — conséquence d'une donnée de test résultant du parcours de retour normal (déjà corrigé), pas une correction de code indépendante. Détail complet : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 3.

### Identifiants QA
Stockés uniquement dans `.env.qa.local` à la racine du dépôt (fichier local, exclu du suivi Git — vérifié par `git check-ignore -v .env.qa.local`). **Aucun mot de passe n'est écrit dans ce document ni dans aucun fichier suivi par Git.** Comptes concernés : `qa.superadmin@fictif.test`, `qa.agent.rak@fictif.test`, `qa.agent.casa@fictif.test`, `qa.auditeur@fictif.test` (mots de passe réinitialisés le 2026-08-26 sur autorisation explicite du propriétaire du projet, rôles/permissions inchangés). Procédure complète : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 2.

## 6. Dernière étape terminée

Restructuration documentaire de HANDOFF.md/TESTREPORT.md/INCIDENTS.md (2026-08-26), à la suite de la correction et vérification de BUG-001/BUG-004/BUG-005 (2026-08-26). Aucune donnée de base, aucun code, aucun test modifiés par la restructuration elle-même.

## 7. Prochaine action exacte

Reprendre la campagne de validation QA aux scénarios 1 à 25 (clients fictifs restants → conversion en contrat), en suivant [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md), en utilisant les identifiants déjà en place dans `.env.qa.local`. Documenter chaque lot de scénarios dans un nouveau fichier `docs/test-reports/<date>-campagne-suite.md` et mettre à jour le runbook au fur et à mesure.

## 8. Règles de sécurité pour la reprise

- Ne jamais écrire de mot de passe/jeton/secret réel dans un fichier suivi par Git (voir [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 4 pour le détail).
- Toute réinitialisation de mot de passe de test reste scopée à `xrent_dev`, jamais une base de production.
- Respecter l'isolation tenant/agence à chaque scénario testé.
- Ne jamais contourner l'application par une modification directe en base pour simuler un parcours utilisateur métier.
- Ne jamais désactiver une permission/validation/authentification pour faire passer un test.
- CLAUDE.md règle 8 reste en vigueur : aucun code métier, schéma, migration ou route sans validation explicite préalable du propriétaire du projet.

## 9. Documents associés

[README.md](./README.md) · [PROJECT_MAP.md](./PROJECT_MAP.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [DOMAINRULES.md](./DOMAINRULES.md) · [SECURITY.md](./SECURITY.md) · [TESTREPORT.md](./TESTREPORT.md) · [INCIDENTS.md](./INCIDENTS.md) · [docs/decisions/open-items-tracker.md](./docs/decisions/open-items-tracker.md) (décisions techniques/produit encore ouvertes) · [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) (procédure de reprise de campagne)
