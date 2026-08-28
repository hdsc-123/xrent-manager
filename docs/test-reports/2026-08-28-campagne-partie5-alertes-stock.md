# Rapport — Campagne de validation QA, partie 5 : analyse des alertes STOCK_INCONSISTENCY (2026-08-28)

Session dédiée, sur brief explicite du propriétaire du projet, à l'analyse des deux alertes `STOCK_INCONSISTENCY` déjà observées et acquittées en partie 4 (`Hyundai Accent QA-DejaLoue-RAK`, `Renault Clio QA-CatB-RAK`). Objectif : déterminer précisément leur nature (incohérence réelle, alerte obsolète, erreur du moteur de détection, erreur de transition de statut, fixture volontairement incohérente, conséquence d'un test manuel conservé) et corriger si nécessaire, uniquement par l'application, dans `xrent_dev`.

## 1. État Git

`main`, `HEAD` = `origin/main` = `0b918979151d1edbbf7521a6fbe8611d0899c121`. Working tree : seuls des fichiers de documentation modifiés (aucun bug de code trouvé, aucune correction de code). Aucun commit créé, aucun push effectué.

## 2. Véhicules analysés

| Véhicule | Immatriculation | `tenantId`/`agencyId` | Statut | Catégorie | Locations liées |
|---|---|---|---|---|---|
| Hyundai Accent QA-DejaLoue-RAK | 44444-A-44 | QA FICTIF / RAK | `RENTED` (inchangé depuis création, `updatedAt == createdAt`) | A | **0** |
| Renault Clio QA-CatB-RAK | 22222-B-22 | QA FICTIF / RAK | `AVAILABLE` (inchangé depuis création, `updatedAt == createdAt`) | B | Contrat `00002` (`COMPLETED`, dates 2026-09-10→14), contrat `00010` (`PENDING`, créé en partie 4) |

Lecture contrôlée effectuée (Prisma via requêtes en lecture seule) : historique complet des statuts (via `updatedAt`), locations liées et leur statut, contrat/réservation source, transferts/déplacements/maintenances associés (aucun pour ces deux véhicules), alertes et audit associés.

## 3. État réel des locations et contrats

- **Clio** : contrat `00002` a été `ACTIVE` entre sa confirmation (2026-08-26, avant 15:09) et son retour (2026-08-26 15:57:11, `POST /api/locations/[id]/return`, déjà documenté BUG-004/BUG-005). Depuis, `status=COMPLETED`, aucune location `ACTIVE` ne subsiste pour ce véhicule (confirmé par requête directe). Contrat `00010` (créé en partie 4) est `PENDING`, ne compte pas comme `ACTIVE`.
- **Hyundai** : aucune `Location` n'a jamais existé pour ce véhicule, à aucun moment depuis sa création (2026-08-26 13:03:16.705) — le véhicule a été créé directement avec `status: "RENTED"` via `POST /api/vehicles` (voir section 4).

## 4. Analyse du code — source de vérité et cycle de vie

### `Vehicle.status` — champ manuel, jamais dérivé automatiquement des locations

**Décision documentée et ratifiée deux fois** (DOMAINRULES.md section 5, Sprint 5 puis réaffirmée Sprint 28/Finding E) : *« disponibilité calculée à la demande à partir des `Location` existantes... `status` reste un champ manuel distinct... pas dérivé automatiquement des locations »*. Confirmé par le code :

- `src/app/api/vehicles/route.ts` et `[id]/route.ts` : `MANUALLY_ASSIGNABLE_STATUSES = ["AVAILABLE", "RENTED", "MAINTENANCE", "INACTIVE"]` — ces quatre statuts sont assignables librement via `POST`/`PATCH /api/vehicles*`, sans aucune contrainte de cohérence avec les `Location` existantes au moment de l'écriture.
- **Recherche exhaustive** de tout `tx.vehicle.update(...)`/`prisma.vehicle.update(...)` touchant `status` dans `src/lib/*.ts` : seuls `location-return.ts` (retour → `AVAILABLE`), `vehicle-trips.ts` (`ON_TRIP`/`AVAILABLE`), `vehicle-transfers.ts` (`TRANSFERRING`/`AVAILABLE`) écrivent ce champ. **Aucune fonction ne le fait jamais passer à `RENTED`** — ni à la création d'une `Location`, ni à son activation (`PENDING → CONFIRMED → ACTIVE`). Confirmé par lecture complète de `createLocationLocked`/`updateLocation` (`src/lib/locations.ts`) : aucune écriture sur `Vehicle.status`.
- **Ce que le champ `status` ne fait PAS** : bloquer une nouvelle réservation. Le blocage réel repose sur `checkAvailability` (conflit de dates entre `Location`) et `assertVehicleStatusAllowsLocation` (bloque `MAINTENANCE`/`TRANSFERRING`/`ON_TRIP`/`INACTIVE`, **`RENTED` explicitement absent** de cette liste, DOMAINRULES.md section 43 : *« RENTED reste délibérément absent : un véhicule loué reste réservable pour une période future non chevauchante »*).

**Conclusion** : `Vehicle.status = RENTED`/`AVAILABLE` est un champ **informatif/manuel**, jamais une garantie fonctionnelle de disponibilité — la garantie réelle (empêcher un double-booking) est assurée indépendamment par `checkAvailability`, déjà vérifiée à de multiples reprises (parties 3 et 4) et non remise en cause ici.

### Moteur de détection — `checkStockInconsistencies` (`src/lib/scheduled-tasks.ts`)

```
/** Incohérence entre Vehicle.status (champ manuel, DOMAINRULES.md section 5) et la réalité des
 * locations : AVAILABLE avec une location ACTIVE en cours, ou RENTED sans aucune location
 * ACTIVE — signale une désynchronisation à corriger manuellement (aucune correction
 * automatique...) */
```

- Sélectionne tout véhicule `status ∈ {AVAILABLE, RENTED}` du tenant, avec sa location `ACTIVE` éventuelle (une seule requise, `take: 1`).
- `inconsistent = (status===AVAILABLE && hasActiveLocation) || (status===RENTED && !hasActiveLocation)` — exactement la définition attendue, scopée au tenant par la requête Prisma (`where: { tenantId, ... }`), donc **aucune fuite tenant possible** par construction (vérifié aussi par lecture, aucun filtre `agencyId` nécessaire ici car l'alerte reprend `vehicle.agencyId` directement).
- `hasUnresolvedAlert(tenantId, entityType, entityId)` : ne recrée jamais une alerte tant qu'une alerte `PENDING` **ou** `ACKNOWLEDGED` existe déjà pour cette entité — **confirme qu'« acquittée » n'est jamais traité comme « résolu »** dans la logique de déduplication (une alerte acquittée bloque toujours la recréation, exactement comme une alerte encore `PENDING`, jamais comme si le problème était clos).
- Aucune fonction ne ré-évalue/ferme automatiquement une alerte existante quand la condition change (ni ici, ni ailleurs dans `scheduled-tasks.ts`) — seule la **création** est automatisée, la **résolution** reste toujours un acte humain explicite (`resolveAlert`).

### Cycle de vie d'une `Alert` (`src/lib/alerts.ts`)

Machine à états stricte : `PENDING → {ACKNOWLEDGED, RESOLVED}`, `ACKNOWLEDGED → {RESOLVED}`, `RESOLVED` **terminal** (jamais rouvrable, aucune fonction `deleteAlert`). `resolveAlert` accepte un `resolutionAction` (texte libre) — c'est le seul mécanisme du modèle pour documenter la cause **dans l'application elle-même** (`acknowledgeAlert` n'a pas de champ de commentaire).

## 5. Détermination

| Alerte | Classification | Cause |
|---|---|---|
| Clio (Renault QA-CatB-RAK) | **Alerte obsolète** | Exacte au moment de sa création (contrat n°00002 réellement `ACTIVE` alors que `Vehicle.status` était resté `AVAILABLE`, jamais mis à jour manuellement par l'agent) ; devenue fausse après le retour normal du contrat (`COMPLETED`, plus aucune location `ACTIVE`) — jamais ré-évaluée automatiquement (comportement documenté du moteur, pas un bug). |
| Hyundai (Accent QA-DejaLoue-RAK) | **Fixture de test volontairement incohérente, alerte exacte et permanente** | Véhicule créé directement avec `status: "RENTED"` sans jamais avoir de `Location` réelle (fixture destinée à tester l'exclusion des véhicules loués des sélecteurs, campagne partie 2 point 5). Conforme à la décision documentée (`Vehicle.status` manuel) — pas une erreur de transition, pas une erreur du moteur : le moteur détecte correctement une divergence réelle et permanente entre un champ déclaratif et l'absence de location. |

**Aucune des deux n'est une erreur du moteur de détection ni une erreur de transition de statut.** Aucun bug de code trouvé dans le moteur d'alertes, les transitions `Vehicle.status`, ou la machine à états `Alert`.

## 6. Corrections appliquées

**Aucune correction de données** (aucune n'était justifiée : le Clio est déjà cohérent, modifier le Hyundai casserait sa fixture). **Aucune correction de code** (comportement conforme à la décision documentée). Actions effectuées, toutes via l'application (`PATCH /api/alerts/[id]/resolve`, jamais de SQL direct) :

1. Alerte Clio (`cmta8cwtn00fjm4n9vdw8ehte`, `ACKNOWLEDGED`) → **`RESOLVED`**, avec `resolutionAction` documentant la cause exacte (contrat retourné, condition disparue).
2. Alerte Hyundai (`cmta8cwtr00flm4n90e9xqrd8`, `PENDING`) → **`RESOLVED`**, avec `resolutionAction` documentant qu'il s'agit d'une fixture intentionnelle, sans correction de donnée.
3. **Vérification empirique** : déclenchement manuel de `POST /api/tasks/check-alerts` (route ADMIN, session réelle, non liée au `CRON_SECRET`) — a recréé une **nouvelle** alerte `STOCK_INCONSISTENCY` PENDING pour le Hyundai uniquement (`cmtd2n4v60005m4kv54p6e939`, même message, même entité), confirmant que la condition persiste réellement et que le cycle de vie fonctionne comme attendu (`RESOLVED` n'empêche pas une recréation si la cause persiste, contrairement à `PENDING`/`ACKNOWLEDGED`). **Aucune** nouvelle alerte recréée pour le Clio, confirmant que sa condition est bien réellement résolue. Cette nouvelle alerte Hyundai a été re-résolue avec la même documentation (point 2 ci-dessus).

Toutes les résolutions ont conservé `tenantId`/`agencyId` corrects (RAK, QA FICTIF), horodatage et utilisateur validateur (`qa.superadmin`) enregistrés, historique intégralement préservé (aucune alerte supprimée, `RESOLVED` terminal mais visible).

## 7. Audits créés

4 entrées `alert.resolved` (`AuditLog`), une par résolution (Clio ×1, Hyundai ×2 — alerte initiale + alerte recréée), toutes scopées au tenant/agence RAK, `resolvedByUserId` = `qa.superadmin`.

## 8. Recherche d'autres incohérences dans le tenant QA

Requêtes en lecture seule couvrant l'intégralité des catégories demandées :

| # | Vérification | Résultat |
|---|---|---|
| 1 | Statut `RENTED` sans location `ACTIVE` | Hyundai uniquement (déjà traité) |
| 2 | Statut `AVAILABLE` avec location `ACTIVE` | Aucun (0 résultat) |
| 3 | Véhicule dans une agence différente de sa location `ACTIVE` | Aucun (0 résultat) |
| 4 | Location `ACTIVE` sans véhicule (orpheline) | Aucun (0 résultat) |
| 5 | Contrat `COMPLETED` avec véhicule encore `RENTED` | Aucun (0 résultat) |
| 6 | Véhicule `MAINTENANCE` sans `Maintenance` `SCHEDULED`/`IN_PROGRESS` correspondante | **Peugeot 208 QA-Maintenance-RAK** — même schéma que le Hyundai (fixture délibérée, statut manuel assignable, documentée depuis la partie 1/2 pour tester l'exclusion des véhicules en maintenance). Hors du périmètre de `checkStockInconsistencies` (qui ne scanne que `AVAILABLE`/`RENTED`) — ne génère et ne peut générer aucune alerte `STOCK_INCONSISTENCY`. Aucune action nécessaire. |
| 7 | Véhicule `TRANSFERRING`/`ON_TRIP` sans transfert/déplacement actif correspondant | Aucun (0 résultat) |
| 8 | Véhicule non marqué `TRANSFERRING`/`ON_TRIP` alors qu'un transfert/déplacement actif existe | Aucun (0 résultat) |

**Aucune autre incohérence trouvée** au-delà des deux alertes déjà analysées et du cas Peugeot (même famille, hors périmètre du moteur d'alerte, non modifié).

## 9. Tests

Aucun bug de code trouvé → aucune correction de logique → aucun test de non-régression ajouté. Les comportements du brief (section 6, points 1 à 12) ont été vérifiés **par lecture de code déterministe** (jamais de float/ambiguïté possible dans ces conditions booléennes simples) et/ou par la couverture automatisée déjà existante et verte :

1. Location `ACTIVE` ⇒ véhicule non disponible pour un nouveau chevauchement : `checkAvailability`, déjà testé extensivement (parties 3-4).
2. Location terminée ⇒ véhicule disponible si aucun autre blocage : confirmé en direct (Clio re-réservable après retour, contrat `00010` créé en partie 4).
3. Réservation future (modèle `Reservation`) ⇒ ne réserve aucun véhicule, jamais de blocage : DOMAINRULES.md section 21/69, déjà confirmé.
4. Location annulée (`CANCELLED`) ⇒ jamais comptée par `checkAvailability`/`checkStockInconsistencies` (filtre `status: "ACTIVE"` strict) : vérifié par lecture de code.
5. Retour validé ⇒ véhicule disponible : `location-return.ts:455`, déjà testé en direct (partie 4).
6. Maintenance ⇒ véhicule bloqué : `assertVehicleStatusAllowsLocation`, déjà testé en direct (partie 3/4, Peugeot).
7. Transfert ⇒ véhicule bloqué : déjà testé en direct (partie 4).
8. Déplacement interne ⇒ véhicule bloqué : `ON_TRIP` dans `VEHICLE_STATUSES_BLOCKING_LOCATION`, couvert par la suite automatisée (Sprint 34).
9. Alerte exacte : Hyundai, confirmé.
10. Alerte résolue : Clio, confirmé (ne se recrée pas).
11. Alerte acquittée/résolue mais problème persistant ⇒ recréée : Hyundai, **confirmé empiriquement** (section 6, point 3).
12. Absence de fuite tenant/agence : requête `checkStockInconsistencies` scopée `tenantId`, déjà vérifiée à de multiples reprises (parties 3-4) — reconfirmée par lecture de code cette session.

## 10. Résultats chiffrés et validation

`node scripts/test-grouped.mjs` : **1335/1335**, 0 échec, 0 timeout. `npx tsc --noEmit` : vert. `npm run lint` : vert. `npm run build` : réussi. `git diff --check` : vert. Aucun fichier de code modifié.

## 11. Données créées, modifiées, supprimées

- **Modifiées** (via l'application uniquement, jamais de SQL direct) : 2 alertes existantes `RESOLVED` (Clio, Hyundai initiale), 1 nouvelle alerte créée par le moteur puis `RESOLVED` (Hyundai, recréation de vérification).
- **Aucune location, contrat ou historique supprimé ou modifié.**
- **Aucune donnée de véhicule modifiée** (statuts Hyundai/Clio/Peugeot inchangés, intentionnellement).
- **Aucune donnée de production concernée** (aucun environnement de production n'existe).

## 12. Points encore ouverts

- L'alerte Hyundai **se recréera à chaque nouveau passage** de `POST /api/tasks/check-alerts`/`scheduled-alerts` tant que la fixture existe sous cette forme — comportement attendu (pas un bug), mais potentiellement source de bruit répété pour de futures sessions QA. Aucun mécanisme de suppression permanente (« won't fix », fixture connue) n'existe aujourd'hui dans le modèle `Alert` — à soumettre au propriétaire du projet s'il souhaite un tel mécanisme (décision produit, non tranchée ici, CLAUDE.md règle 8).
- Le cas Peugeot (`MAINTENANCE` sans `Maintenance` active) suit exactement le même schéma que le Hyundai mais n'est pas couvert par `checkStockInconsistencies` — signalé pour traçabilité, aucune action nécessaire (le moteur d'alerte ne le scanne pas, donc aucune alerte trompeuse n'est générée).
- Observation 3 de la partie 4 (déséquilibre visuel mineur, formulaire de conversion mobile) reste non corrigée, hors périmètre de cette session.

## 13. Recommandation

**PRÊT pour commit** (de la documentation uniquement — aucun code, aucune donnée métier modifiée, seules deux alertes existantes correctement résolues via l'application).
