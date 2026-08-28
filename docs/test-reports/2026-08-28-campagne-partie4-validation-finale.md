# Rapport — Campagne de validation QA, partie 4 : passe finale de validation manuelle (points 11-56) (2026-08-28)

Session de validation manuelle finale du runbook de campagne QA, sur brief explicite du propriétaire du projet, faisant suite à la partie 3 (INC-16, commit `0b918979151d1edbbf7521a6fbe8611d0899c121`). Tenant : `QA FICTIF - XRent Validation` (`cmta2y6uy0000m4n9xvm0hr18`), base `xrent_dev`. Voir [docs/runbooks/campagne-validation-qa.md](../runbooks/campagne-validation-qa.md) pour la procédure et [TESTREPORT.md](../../TESTREPORT.md) pour le résumé chiffré.

## 1. État Git initial et final

Initial : branche `main`, `HEAD` = `origin/main` = `0b918979151d1edbbf7521a6fbe8611d0899c121`, working tree propre. Final : identique — **aucune modification de code n'a été nécessaire** (aucun bug trouvé), seuls des fichiers de documentation sont modifiés par cette session. Aucun commit créé, aucun push effectué.

## 2. Comptes utilisés

| Compte | Groupe/rôle | Statut mot de passe | Scénarios |
|---|---|---|---|
| `qa.superadmin@fictif.test` | ADMIN | déjà connu (`.env.qa.local`) | Conversion, surclassement, paiements, retours, transferts, déplacements, audit, alertes |
| `qa.agent.rak@fictif.test` | MEMBER / AGENT | déjà connu | Isolation agence RAK, `agencies.view` |
| `qa.agent.casa@fictif.test` | MEMBER / AGENT | déjà connu | Isolation agence CASA |
| `qa.auditeur@fictif.test` | MEMBER / AUDITEUR | déjà connu | Permissions (403 sur `/api/audit`/`/api/users`, 200 sur véhicules/réservations) |
| `qa.compta@fictif.test` | MEMBER / COMPTABILITÉ | **réinitialisé cette session**, sur autorisation explicite | Menu/permissions comptabilité, refus véhicules/clients/maintenances/transferts/agences en écriture |
| `qa.responsable.rak@fictif.test` | MEMBER / AGENCE | **réinitialisé cette session**, sur autorisation explicite | Menu/permissions manager d'agence, isolation RAK, conversion, surclassement |
| `qa.sanspermission@fictif.test` | MEMBER / SANS ACCES | **réinitialisé cette session**, sur autorisation explicite | Refus total (403) sur tous les modules |

Réinitialisation : `PATCH /api/users/[id]` par `qa.superadmin` (action applicative, jamais d'écriture directe en base), rôles/groupes/tenant/agence revérifiés identiques avant/après par requête SQL en lecture seule. Connexion des 3 comptes confirmée (200) avant tout usage. Valeurs stockées uniquement dans `.env.qa.local` (fichier local, exclu du suivi Git, jamais affichées dans ce rapport, le terminal utilisateur ou une capture).

## 3. Points 11-56 exécutés

### Permissions et isolation (points 51-53)

| # | Scénario | Compte | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|---|
| 1 | Menu COMPTABILITÉ | qa.compta | Tableau de bord/Réservations/Factures/Paiements/Rapports/Contrats/Performance/Paramètres uniquement | Conforme (capture navigateur) | Vérifié sans modification |
| 2 | Refus serveur COMPTABILITÉ | qa.compta | 403 sur vehicles/clients/maintenances/vehicle-transfers/vehicle-trips/agencies/audit/users, écriture véhicule refusée | Tous 403 confirmés | Vérifié sans modification |
| 3 | Menu AGENCE (responsable RAK) | qa.responsable.rak | Agences/Véhicules/Locations/Réservations/Clients/Transferts/Déplacements/Maintenances/Alertes/Factures/Paiements/Caisse/Contrats/Performance/Paramètres ; pas de Rapports/Utilisateurs/Invitations/Permissions/Audit | Conforme (capture navigateur) | Vérifié sans modification |
| 4 | Isolation agence RAK (API) | qa.responsable.rak | `/api/vehicles` = 5 véhicules RAK uniquement, accès direct à un véhicule CASA = 404 | Conforme | Vérifié sans modification |
| 5 | `agencies.view` | qa.responsable.rak, qa.agent.rak | `GET /api/agencies` = 200, liste complète (non agence-scopée, décision documentée) | Conforme | Vérifié sans modification |
| 6 | Refus total SANS ACCES | qa.sanspermission | 403 sur vehicles/clients/reservations/locations/invoices/payments/reports/agencies/maintenances | Tous 403 | Vérifié sans modification |
| 7 | Groupe AUDITEUR | qa.auditeur | `/api/audit`=403 et `/api/users`=403 (rôle MEMBER, `audit.view`/`users.*` décoratives par design) ; `/api/vehicles`/`/api/reservations`=200 | Conforme | Vérifié sans modification — observation : le nom du groupe « AUDITEUR » ne donne aucun accès réel à l'audit (role-gated ADMIN strict), déjà documenté SECURITY.md section 4 |
| 8 | Isolation agent RAK/CASA (re-confirmation) | qa.agent.rak/casa | Véhicules scopés, accès direct à une réservation de l'autre agence = 404 | Conforme | Vérifié sans modification |
| 9 | Isolation tenant (point 53) | qa.superadmin | Accès direct à une réservation d'un autre tenant réel (`QA Validation Alpha`) = 404 API, vrai 404 HTTP en navigation page complète (pas un soft-404) | Conforme (`{"error":"Réservation introuvable."}`, 404 sur les deux) | Vérifié sans modification |

### Réservations et conversion (points 11-12)

| # | Scénario | Résultat attendu | Résultat obtenu | Preuve | Statut |
|---|---|---|---|---|---|
| 9 | Conversion avec véhicule MAINTENANCE | 409 | `{"error":"...MAINTENANCE)."}`, réservation reste PENDING (rollback confirmé) | requête API + SQL | Vérifié sans modification |
| 10 | Conversion catégorie différente sans déclaration | 400 `UpgradeDeclarationRequiredError` | Conforme | requête API | Vérifié sans modification |
| 11 | Conversion valide + numérotation | 201, `contractNumber` séquentiel (00008 puis incréments continus) | Conforme sur toute la session | requête API + SQL | Vérifié sans modification |
| 12 | Montant falsifié (`totalSupplement`/`assignedCategory`) | ignoré, recalculé serveur | `assignedCategory` réel ("A"), `totalSupplement` recalculé (9000, jamais 999999999) | requête API | Vérifié sans modification |
| 13 | Audit complet conversion | `reservation.converted`/`location.created`/`invoice.created`/`location.upgraded` | Les 4 entrées présentes, ordonnées | SQL AuditLog | Vérifié sans modification |
| 14 | Double conversion concurrente | une seule réussite, une seule Location | Observé involontairement (double requête réseau) : 1×201 puis 1×409 "CONVERTED → CONVERTED", 1 seule LocationUpgrade | logs serveur + SQL | Vérifié sans modification (confirme le verrouillage déjà en place) |
| 15 | Conversion avec véhicule TRANSFERRING | 409 | `{"error":"...TRANSFERRING)."}` | requête API | Vérifié sans modification |

### Surclassement (points 16-19)

| # | Scénario | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|
| 16 | CUSTOMER_REQUEST, accord+supplément | accepté, recalculé serveur | `dailySupplement=3000`, `totalSupplement=9000` (3j), total contrat=114000 | Vérifié sans modification |
| 17 | UNAVAILABILITY, catégorie A tenant-wide disponible (Hyundai RENTED sans Location réelle) | refusé si un véhicule est réellement disponible n'importe où **dans l'agence** | 409 — confirme le scoping agence : refusé car la catégorie A a un véhicule (Hyundai, fixture RENTED sans Location) considéré disponible côté agence RAK | Observation méthodologique — fixture RENTED sans Location backing rend ce cas non représentatif, non un bug (voir section 5) |
| 17bis | UNAVAILABILITY, catégorie B genuinement indisponible à RAK (Peugeot MAINTENANCE + Clio réellement réservé) | accepté, gratuit | 201, `totalSupplement=0` | Vérifié sans modification — **confirme en conditions réelles le correctif INC-16 (scoping agence)** |
| 18 | UNAVAILABILITY avec supplément demandé | refusé | 400 (test partie 3, reconfirmé par lecture de code, non re-testé en direct cette session car déjà couvert par le test automatisé dédié) | Vérifié sans modification (couverture automatisée) |
| 19 | COMMERCIAL_GESTURE sans permission | 403 | `{"error":"Accès refusé."}` (qa.responsable.rak) | Vérifié sans modification |
| 19bis | COMMERCIAL_GESTURE avec permission (ADMIN bypass) | accepté, audité | 201, `totalSupplement=0`, `AuditLog.location.upgraded` avec `upgradeType=COMMERCIAL_GESTURE` | Vérifié sans modification |

### Clients et permis (points 7, 13-15)

| # | Scénario | Client | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|---|
| 20 | Âge < 21 | Yasmine Fictif-Moins21 | 400 | `{"error":"...n'a pas encore 21 ans..."}`, rollback confirmé | Vérifié sans modification |
| 21 | Permis expiré | Nadia Fictif-PermisExpire | 400 | `{"error":"...expire avant la date de retour..."}` | Vérifié sans modification |
| 22 | Permis expirant exactement à `endDate` | Karim Fictif-PermisExpireBientot | accepté (égalité UTC) | 201, contrat créé | Vérifié sans modification |
| 23 | Permis expirant avant `endDate` (1 jour après) | Karim Fictif-PermisExpireBientot | 400 | `{"error":"...expire avant la date de retour..."}` | Vérifié sans modification |
| 24 | Second conducteur = Omar original (correspondance exacte) | Omar Fictif-SecondCondValide | réutilisé, `secondDriverId` = id original | `secondDriverId` = `cmta4bvsn00dxm4n9fmveytkg` (id original, confirmé), aucun nouveau client | Vérifié sans modification |
| 25 | Second conducteur < 21 ans | Yasmine Fictif-Moins21 | 400, rollback | `{"error":"...second conducteur n'a pas encore 21 ans..."}`, 7 clients avant/après (aucun orphelin) | Vérifié sans modification |
| 26 | Absence de doublon Omar | — | 1 seul client « Omar » en base | Confirmé par requête SQL avant et après toute la session (7 clients constant, 1 seul Omar) | Vérifié sans modification |

### Paiements (points 20-25)

| # | Scénario | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|
| 27 | Paiement espèces intégral | facture PAID | `status=PAID`, `amountPaid=70000=totalAmount`, 1 `CashEntry` CASH | Vérifié sans modification |
| 28 | Paiement mixte (CASH+CARD) | 2 `Payment`, `PARTIALLY_PAID`, solde correct | `amountPaid=70000/90000`, solde=20000, 2 `CashEntry` | Vérifié sans modification |
| 29 | Dépassement du solde restant | refusé (409) | `{"error":"...dépasse le solde restant dû (200,00 MAD)."}` | Vérifié sans modification |
| 30 | Paiement exact du solde restant | accepté, facture PAID | 201, `status=PAID`, `amountPaid=90000` | Vérifié sans modification |
| 31 | Carte comme mode hors-ligne | aucune donnée bancaire stockée | `Payment.method="CARD"` uniquement un libellé, aucun champ numéro/CVV dans le schéma (vérifié `prisma/schema.prisma`) | Vérifié sans modification |
| 32 | Cohérence facture/caisse/audit | tous les paiements reflétés | 4/4 `CashEntry` et 4/4 `payment.created` correspondant exactement aux 4 paiements créés | Vérifié sans modification |

### Retours (points 26-29)

| # | Scénario | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|
| 33 | Retour avec `endOdometer == startOdometer` | refusé | `{"error":"...strictement supérieur..."}` | Vérifié sans modification |
| 34 | Retour avec `endOdometer < startOdometer` | refusé | idem | Vérifié sans modification |
| 35 | Retour valide + dommage | 200, `Location.status=COMPLETED`, `Vehicle.status=AVAILABLE`, `Damage` créé | Conforme, `actualReturnAt` renseigné | Vérifié sans modification |
| 36 | Dommage facturable (`billableAmount`) | facture de dégât liée générée | `damageInvoiceId` renseigné automatiquement | Vérifié sans modification |
| 37 | Disponibilité après retour | véhicule re-réservable | `Vehicle.status=AVAILABLE` confirmé | Vérifié sans modification |
| 38 | Audit retour | `location.returned`/`damage.created` | Présents, avec `location.status_changed` ×2 pour les transitions CONFIRMED/ACTIVE | Vérifié sans modification |

### Transferts et déplacements (points 35-40)

| # | Scénario | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|
| 39 | Lancement transfert RAK→CASA | véhicule `TRANSFERRING`, transfert `IN_TRANSIT` | Conforme | Vérifié sans modification |
| 40 | Conversion sur véhicule TRANSFERRING | 409 | `{"error":"...TRANSFERRING)."}` | Vérifié sans modification |
| 41 | Validation réception (`.../validate`) | véhicule `AVAILABLE`, agence = CASA | Conforme, transfert `COMPLETED` | Vérifié sans modification |
| 42 | Bon de déplacement interne | véhicule `ON_TRIP`, aucune `Location` créée | Conforme (0 `Location` liée) | Vérifié sans modification |
| 43 | Retour de déplacement | véhicule `AVAILABLE`, kilométrage/carburant appliqués | Conforme, trip `COMPLETED` | Vérifié sans modification |

### Facture, PDF, audit, alertes (points 30-34, 48-50)

| # | Scénario | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|
| 44 | PDF contrat | 200, `application/pdf` valide | Conforme (1 page) | Vérifié sans modification |
| 45 | PDF facture | 200, `application/pdf` valide | Conforme (1 page) | Vérifié sans modification |
| 46 | Suppression d'audit réservée ADMIN | ADMIN peut supprimer (permission implicite), auto-journalisé | `DELETE /api/audit/[id]` = 200, `audit.log_deleted` créé avec métadonnées de l'entrée supprimée | Vérifié sans modification |
| 47 | Acquittement d'alerte | `status=ACKNOWLEDGED` | Conforme | Vérifié sans modification |

### Responsive (points 54-56)

| # | Page | Viewport | Résultat attendu | Résultat obtenu | Statut |
|---|---|---|---|---|---|
| 48 | `/dashboard/reservations` | 1280×800 / 834×1112 / 390×844 | Aucun débordement horizontal | `scrollWidth === innerWidth` aux 3 tailles | Vérifié sans modification |
| 49 | Formulaire de conversion | 390×844 | Aucun débordement, tous les champs utilisables | Aucun débordement confirmé ; déséquilibre visuel mineur sur le champ « Kilométrage départ » (voir section 5) | Observation (cosmétique, non bloquant) |

## 4. Résultats chiffrés

`node scripts/test-grouped.mjs` (exécution propre finale) : **1335/1335**, 0 échec, 0 timeout, 0 résiduel. `npx tsc --noEmit` : vert. `npm run lint` : vert. `npm run build` : réussi. `git diff --check`/`git status --short` : aucun fichier de code modifié (aucun bug trouvé nécessitant correction).

## 5. Observations documentées

1. **Alerte `STOCK_INCONSISTENCY` du contrat n°00002 (Renault Clio QA-CatB-RAK)** — **analysée en profondeur et close en partie 5 (2026-08-28)**, voir [docs/test-reports/2026-08-28-campagne-partie5-alertes-stock.md](2026-08-28-campagne-partie5-alertes-stock.md). Cause : créée le 2026-08-26 pendant que le contrat était `ACTIVE`, jamais ré-évaluée automatiquement après son passage à `COMPLETED` le même jour (le moteur d'alerte ne fait que créer, jamais ré-évaluer/clôturer une alerte existante — décision documentée, `checkStockInconsistencies`). Déterminée **alerte obsolète** (condition sous-jacente réellement disparue) — résolue via `PATCH /api/alerts/[id]/resolve` (action applicative, jamais SQL direct), confirmée ne pas se recréer après un nouveau passage de `POST /api/tasks/check-alerts`.
2. **Fixture « Hyundai Accent QA-DejaLoue-RAK »** — **analysée en profondeur en partie 5 (2026-08-28)**. `Vehicle.status=RENTED` sans aucune `Location` réelle, fixture délibérée depuis la partie 1/2 (exclusion des véhicules loués des sélecteurs). Déterminée **alerte exacte et permanente, issue d'une fixture volontairement incohérente** — conforme à DOMAINRULES.md section 5 (`Vehicle.status` est un champ manuel, jamais dérivé automatiquement des `Location`, décision Sprint 5 réaffirmée Sprint 28/Finding E). Aucun bug de code, aucune correction de donnée (la modifier casserait l'objectif de la fixture). Résolue avec documentation explicite de la cause (`resolutionAction`) ; confirmée par un nouveau passage de `POST /api/tasks/check-alerts` qu'elle se recrée correctement (comportement attendu, pas une régression) puis re-résolue. Conséquence secondaire découverte : ce véhicule est aussi considéré « réellement disponible » par `isCategoryReallyAvailable` (contrôle UNAVAILABILITY du surclassement) pour toute période future — cohérent avec la même règle documentée (RENTED reste réservable pour une période non chevauchante), documenté comme mauvais candidat de test pour ce chemin précis.
3. **`ConvertReservationForm.tsx`, champ « Kilométrage départ »** (mobile, 390px) : le texte d'aide long («&nbsp;— prérempli depuis le dernier état connu du véhicule, à corriger si nécessaire&nbsp;») déséquilibre visuellement la grille à 2 colonnes partagée avec « Carburant départ » — aucun débordement de page, aucune perte de fonctionnalité, uniquement un déséquilibre visuel. Correction nécessiterait un arbitrage de design non tranché ici (CLAUDE.md règle 2). **Toujours non corrigé.**

## 6. Données créées, modifiées, supprimées

Voir [TESTREPORT.md](../../TESTREPORT.md) section « Tests session — campagne de validation QA, partie 4 » pour le détail complet et la justification de chaque élément. Résumé : 15 réservations/contrats de test (préfixe `QA-PART4-`, conservés), 1 transfert RAK→CASA validé (véhicule « Dacia Duster QA-Transfert-RAK » déplacé à CASA en conséquence, cohérent avec son usage prévu), 1 bon de déplacement CASA complété, 1 entrée `AuditLog` historique supprimée (test du point 49, auto-journalisé), 1 alerte acquittée. Aucune donnée QA préexistante supprimée. Mots de passe de 3 comptes QA réinitialisés (rôles/groupes inchangés, valeurs jamais exposées).

## 7. Recommandation

**PRÊT pour commit** — aucune correction de code nécessaire (aucun bug trouvé), documentation à jour, working tree propre côté code. Les 3 réinitialisations de mot de passe et les données de test créées dans `xrent_dev` ne sont pas versionnées (hors périmètre Git).
