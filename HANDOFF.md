# HANDOFF.md — Transmission du projet

Document destiné à toute personne (ou assistant IA) reprenant le projet, pour comprendre rapidement où en est XRent Manager sans avoir à relire tout l'historique. Version courte — l'historique complet est archivé dans [docs/history/](./docs/history/), les décisions techniques/produit dans [docs/decisions/](./docs/decisions/), les rapports de test détaillés dans [docs/test-reports/](./docs/test-reports/) et les procédures dans [docs/runbooks/](./docs/runbooks/). Restructuré le 2026-08-26 (voir [docs/decisions/2026-08-26-documentation-restructuring-plan.md](./docs/decisions/2026-08-26-documentation-restructuring-plan.md)) — aucune information supprimée, tout le contenu antérieur est archivé verbatim.

## 1. État global du projet

XRent Manager est un SaaS de gestion de location de véhicules (multi-tenant, multi-agence), au stade **post-MVP fonctionnel** : authentification, multi-tenant/multi-agence, véhicules, réservations, contrats/locations, facturation, paiements, caisse, maintenance, alertes, transferts entre agences, bons de déplacement, permissions granulaires, audit, prolongations de contrat, dégâts/factures de dégâts, sont implémentés et testés. Aucun environnement de production n'existe à ce jour (développement + test uniquement). Détail exhaustif module par module : [PROJECT_MAP.md](./PROJECT_MAP.md). Règles métier : [DOMAINRULES.md](./DOMAINRULES.md). Architecture et décisions techniques : [ARCHITECTURE.md](./ARCHITECTURE.md). Sécurité : [SECURITY.md](./SECURITY.md).

**Périmètre non commencé** (voir [docs/decisions/open-items-tracker.md](./docs/decisions/open-items-tracker.md) pour le détail complet et à jour des points ouverts) : cautions, incidents de location détaillés, prestataire de paiement en ligne (Stripe/PayPal), notifications par email, MFA, rate limiting d'authentification (spécifié, non implémenté — voir SECURITY.md section 33), environnement de production réel. **Cette liste est datée (Sprint 14E, 2026-08-13) et n'a pas été revérifiée depuis** — à rafraîchir avant de s'y fier pour une décision de sprint ; texte complet archivé dans [docs/history/handoff-sprint-log-archive.md](./docs/history/handoff-sprint-log-archive.md).

**Point de documentation encore ouvert (Finding F, Sprint 27)** : `DOMAINRULES.md` décrirait encore un gate de facturation (`DRAFT → SENT` conditionné au solde) retiré depuis le Sprint 27 — à corriger avant tout nouveau sprint touchant au workflow de facturation, pour ne pas induire en erreur une future lecture. Détail : [docs/history/handoff-changelog-archive.md](./docs/history/handoff-changelog-archive.md) (section « Finding F »).

## 2. Branche et dernier commit

- Branche : `main`
- Dernier commit : `e578d93` — "chore: ignore temporary Playwright verification artifacts". Les sessions BUG-001/004/005 et la restructuration documentaire du 2026-08-26 ont depuis été commitées par le propriétaire du projet (`543686d`, `122cf44`, `df97bbe`, `e578d93`).
- Aucun commit créé depuis par la session documentée ci-dessous (campagne de validation QA, partie 1 — clients/conducteurs/permis/âge, BUG-006/BUG-007) — travail présent uniquement dans la copie de travail locale.

## 3. État Git

Working tree avec modifications non commitées (voir `git status --short`) : code applicatif et tests (correction BUG-006/BUG-007, voir section 5) et fichiers de documentation (`HANDOFF.md`, `INCIDENTS.md`, `TESTREPORT.md`, `DOMAINRULES.md`, `docs/runbooks/campagne-validation-qa.md`, nouveau fichier `docs/test-reports/2026-08-26-campagne-partie1-clients.md`). **Aucun commit créé, aucun push effectué** — le propriétaire du projet effectue lui-même le diff/commit/push après revue.

## 4. Environnement de développement

- Base de données de développement : PostgreSQL local, `xrent_dev`.
- Base de données de test : PostgreSQL local, `xrent_test` (dédiée, jamais la même que `xrent_dev`).
- Serveur de développement : `npm run dev` (port 3000). Serveur de test dédié : port 3811, géré automatiquement par `vitest.global-setup.ts`.
- Commandes validées (revérifiées le 2026-08-26) :

| Commande | Résultat |
|---|---|
| `npm run lint` | ✅ Aucune erreur |
| `npx tsc --noEmit` | ✅ Aucune erreur |
| `node scripts/test-grouped.mjs` (suite complète recommandée) | ✅ **1308/1308** tests, 0 échec, 0 timeout, 0 résiduel |
| `npm run build` | ✅ Build de production réussi |

Aucune commande de seed n'existe (CLAUDE.md règle 7). Historique complet des commandes validées sprint par sprint : [docs/history/handoff-sprint-log-archive.md](./docs/history/handoff-sprint-log-archive.md) (ancienne section 5) et [TESTREPORT.md](./TESTREPORT.md) section 1.

## 5. Statut de la campagne de validation QA

Une campagne de validation manuelle du tenant QA fictif (`QA FICTIF - XRent Validation`) est **en cours et reste ouverte**. Procédure complète, données fictives et liste des scénarios : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md).

### Bugs corrigés et vérifiés
- **BUG-001** (modale de création d'un groupe de permissions dépassant le viewport) — corrigé et vérifié.
- **BUG-004** (une location n'était visible que par son agence de départ, jamais par son agence de retour) — corrigé et vérifié.
- **BUG-005** (kilométrage de retour non validé sur le flux générique de mise à jour d'une location) — corrigé et vérifié.
- **BUG-006** (champs obligatoires du formulaire client — téléphone/adresse/ville/permis — affichés avec astérisque mais jamais réellement exigés avant soumission) — corrigé et vérifié.
- **BUG-007** (aucune validation n'empêchait une date d'expiration de permis antérieure ou égale à sa date d'obtention) — corrigé et vérifié.

Détail complet de chacun : [INCIDENTS.md](./INCIDENTS.md) INC-6/INC-7/INC-8/INC-9/INC-10. Rapports de session complets : [docs/test-reports/2026-08-26-bug-001-004-005.md](./docs/test-reports/2026-08-26-bug-001-004-005.md) et [docs/test-reports/2026-08-26-campagne-partie1-clients.md](./docs/test-reports/2026-08-26-campagne-partie1-clients.md).

### Bugs ouverts
Aucun bug applicatif connu ouvert à ce jour (au-delà des cinq ci-dessus, tous corrigés). Point de documentation ouvert : voir « Finding F » section 1 ci-dessus. Point non élucidé et non corrigé (hors périmètre exclusif des parties exécutées à ce jour) : doublon apparent du client fictif « Omar Fictif-SecondCondValide » (deux enregistrements distincts dans le sélecteur) — voir [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 6.

### Scénarios validés (4/56 dans la liste numérotée du runbook, via la partie 1 complète du brief)
Isolation agence RAK/CASA (visibilité croisée, sélecteurs véhicule scopés) ; retour de véhicule RAK→CASA (kilométrage, carburant, transition de statut) sur le contrat n°00002 (points 26-28 du runbook, restent à revalider sur un nouveau contrat, voir section 6 du runbook). **Partie 1 complète (2026-08-26)** — les 31 points de vérification du brief « Clients, conducteurs et validations permis/âge » couvrent intégralement les points 1, 13, 14, 15 de la liste des 56 scénarios (CRUD client, champs obligatoires, coordonnées, pièce d'identité, âge minimum du conducteur avec borne exacte de 21 ans vérifiée au jour calendaire près, dates de permis, permis expiré/expirant avant retour), plus des vérifications transverses (persistance, audit, permissions, isolation tenant, usage en réservation/conversion avec détection de doublon client, refus systématiquement vérifiés côté serveur, responsive) qui ne correspondent à aucun point numéroté séparé du runbook. Détail complet : [docs/test-reports/2026-08-26-campagne-partie1-clients.md](./docs/test-reports/2026-08-26-campagne-partie1-clients.md).

### Scénarios non exécutés et non validés (52/56)
**Toujours dans le périmètre du projet** — non écartés, non classés hors périmètre. Reportés aux prochaines sessions en raison de la limite de temps/session disponible, pas d'un choix de les exclure. Liste complète et ordre d'exécution recommandé : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 6. **La campagne de validation globale reste ouverte — elle ne peut pas être déclarée complète.**

### Données fictives importantes
Tenant `QA FICTIF - XRent Validation`, agences RAK/CASA, 7 véhicules, 7 clients d'origine + 1 nouveau (« Sofia Fictif-Part1 », conservé). **Le contrat fictif n°00002 est passé de `ACTIVE` à `COMPLETED` pendant la vérification en direct de BUG-004/BUG-005** (kilométrage retour 28450, carburant Plein) — conséquence d'une donnée de test résultant du parcours de retour normal (déjà corrigé), pas une correction de code indépendante. **Nouveau contrat n°00005 (2026-08-26)** conservé (réservation → contrat de bout en bout sur Ahmed Fictif-Majeur, RAK) ; contrats n°00003/00004 créés transitoirement pour vérifier les bornes d'âge/permis puis supprimés — la numérotation RAK reprend à 00006. Un client résiduel `firstName: "Ahmed", lastName: "   "` (id `cmtafh9rq001fm4t2rymdf33p`), créé involontairement en confirmant empiriquement le gap « espaces uniquement » lors de la revue stricte, a été signalé puis **supprimé** (via `DELETE /api/clients/[id]`, après vérification qu'il n'était lié à aucune donnée nécessaire aux scénarios suivants). Détail complet : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 3.

### Identifiants QA
Stockés uniquement dans `.env.qa.local` à la racine du dépôt (fichier local, exclu du suivi Git — vérifié par `git check-ignore -v .env.qa.local`). **Aucun mot de passe n'est écrit dans ce document ni dans aucun fichier suivi par Git.** Comptes concernés : `qa.superadmin@fictif.test`, `qa.agent.rak@fictif.test`, `qa.agent.casa@fictif.test`, `qa.auditeur@fictif.test` (mots de passe réinitialisés le 2026-08-26 sur autorisation explicite du propriétaire du projet, rôles/permissions inchangés). Procédure complète : [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 2.

## 6. Dernière étape terminée

Partie 1 de la campagne de validation QA — « Clients, conducteurs et validations permis/âge » (2026-08-26) : 31 points de vérification exécutés, 2 bugs trouvés et corrigés (BUG-006, BUG-007, voir section 5 et [INCIDENTS.md](./INCIDENTS.md) INC-9/INC-10), suivis d'une revue stricte du diff avant tout commit ayant trouvé et corrigé un complément à chacun des deux bugs (dates de permis non parseables → erreur 500 non contrôlée ; chaînes composées uniquement d'espaces non détectées par les contrôles de champ obligatoire), tests de non-régression ajoutés (15 au total), suite complète 1308/1308. Détail complet : [docs/test-reports/2026-08-26-campagne-partie1-clients.md](./docs/test-reports/2026-08-26-campagne-partie1-clients.md).

## 7. Prochaine action exacte

Reprendre la campagne de validation QA à partir du point 2 du runbook (« Réservation RAK → RAK »), en suivant [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 6 (liste à jour des 52 scénarios restants), en utilisant les identifiants déjà en place dans `.env.qa.local`. Documenter chaque lot de scénarios dans un nouveau fichier `docs/test-reports/<date>-campagne-suite.md` (ou `<date>-campagne-partieN-<sujet>.md`, cohérent avec le nommage adopté pour la partie 1) et mettre à jour le runbook au fur et à mesure.

## 8. Règles de sécurité pour la reprise

- Ne jamais écrire de mot de passe/jeton/secret réel dans un fichier suivi par Git (voir [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) section 4 pour le détail).
- Toute réinitialisation de mot de passe de test reste scopée à `xrent_dev`, jamais une base de production.
- Respecter l'isolation tenant/agence à chaque scénario testé.
- Ne jamais contourner l'application par une modification directe en base pour simuler un parcours utilisateur métier.
- Ne jamais désactiver une permission/validation/authentification pour faire passer un test.
- CLAUDE.md règle 8 reste en vigueur : aucun code métier, schéma, migration ou route sans validation explicite préalable du propriétaire du projet.

## 9. Documents associés

[README.md](./README.md) · [PROJECT_MAP.md](./PROJECT_MAP.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [DOMAINRULES.md](./DOMAINRULES.md) · [SECURITY.md](./SECURITY.md) · [TESTREPORT.md](./TESTREPORT.md) · [INCIDENTS.md](./INCIDENTS.md) · [docs/decisions/open-items-tracker.md](./docs/decisions/open-items-tracker.md) (décisions techniques/produit encore ouvertes) · [docs/runbooks/campagne-validation-qa.md](./docs/runbooks/campagne-validation-qa.md) (procédure de reprise de campagne)
