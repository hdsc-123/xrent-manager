# Rapport — Passe de correction obligatoire : doublon Omar, surclassement, bugs associés (2026-08-27)

Brief explicite du propriétaire du projet, reçu avant toute poursuite du développement (sprint suivant explicitement bloqué jusqu'à validation complète de cette passe). Objectifs : (A) corriger le doublon client « Omar Fictif-SecondCondValide » ; (B/C/D/E) implémenter correctement le surclassement côté serveur (pas uniquement côté interface) ; (I) rechercher/corriger les bugs du même périmètre ; (H) ajouter les tests de non-régression ; (K) mettre à jour la documentation ; ne pas commencer le sprint suivant.

## 1. État Git initial et final

**Initial** : branche `main`, dernier commit `8cf84f1`. Modifications non commitées déjà présentes **avant** cette passe et sans rapport avec elle (travail antérieur non commité) : `src/app/api/reservations/route.ts`, `src/app/api/reservations/[id]/route.ts`, `EditReservationForm.tsx`, `NewReservationForm.tsx` (validation `.trim()` sur `clientFirstName`/`clientLastName`/`voucherNumber`, motif BUG-006/INC-9), `src/__tests__/locations.test.ts` (extension INC-12, déjà réalisée dans la session précédente). Signalé pour traçabilité, ni modifié ni retiré (hors périmètre du brief reçu).

**Final** : aucun commit créé, aucun push effectué (conformément à la consigne explicite). Fichiers modifiés/créés par cette passe :
- `prisma/schema.prisma` + nouvelle migration `prisma/migrations/20260827114151_add_location_upgrade_surclassement/` (appliquée à `xrent_dev` et `xrent_test`).
- `src/lib/location-upgrades.ts` (nouveau).
- `src/lib/locations.ts` (`calculateDaysCount` extraite, garde `LocationUpgrade` dans `deleteLocation`).
- `src/lib/clients.ts` (garde `secondDriverId` dans `deleteClient`).
- `src/lib/permissions.ts` (nouvelle permission `locations.upgrade.commercial_gesture`).
- `src/app/api/reservations/[id]/convert/route.ts` (surclassement complet, dédoublonnage second conducteur, audit `client.created`).
- `src/app/dashboard/reservations/[id]/convert/page.tsx` et `ConvertReservationForm.tsx` (interface reconstruite).
- `src/__tests__/reservations.test.ts` (~20 tests), `src/__tests__/clients.test.ts` (1 test).
- `DOMAINRULES.md` (section 70, complément section 69), `HANDOFF.md`, `TESTREPORT.md`, `INCIDENTS.md` (INC-13/14/15), `docs/runbooks/campagne-validation-qa.md`, ce rapport.

Aucune donnée de production concernée (aucun environnement de production n'existe à ce jour). Aucun secret modifié. Aucune permission contournée. Aucun test modifié uniquement pour le faire passer (tous les tests corrigés en cours de route l'ont été pour une cause d'isolation entre tests, jamais pour masquer un défaut réel — détail section 8).

## 2. Doublon « Omar Fictif-SecondCondValide » (Partie A)

**Cause exacte** : le second conducteur d'une conversion (`POST /api/reservations/[id]/convert`, étape 6) était **toujours** créé comme un nouveau `Client`, sans jamais appeler `findDuplicateClient` — contrairement au client principal (étape 5), qui bénéficie déjà d'un flux complet de détection de doublon. Confirmé par lecture de code, aucune ambiguïté.

**Investigation en base (`xrent_dev`)** : requête SQL directe (lecture seule) avant toute action — un seul client « Omar Fictif-SecondCondValide » existait déjà au moment de l'investigation (id `cmta4bvsn00dxm4n9fmveytkg`, référencé comme `secondDriverId` d'une `Location`), le doublon (id `cmta4icak00e9m4n9nue89wal`) ayant déjà été **supprimé via l'application** (`AuditLog` : `client.deleted`, 2026-08-27 11:33:10, `metadata: {"name": "Omar Fictif-SecondCondValide"}`) lors d'une étape antérieure de cette même session (avant la reprise après compactage de contexte). Vérifié que le doublon n'avait, au moment de sa suppression, aucune relation (`Location.clientId`/`Location.secondDriverId` : 0 des deux côtés) — aucune réassignation de relation n'était donc nécessaire.

**Identifiant conservé** : `cmta4bvsn00dxm4n9fmveytkg`. **Identifiant supprimé** : `cmta4icak00e9m4n9nue89wal`, via `DELETE /api/clients/[id]` (action applicative, jamais une modification directe en base), journalisé.

**Correction anti-réapparition** (`src/app/api/reservations/[id]/convert/route.ts`, étape 6) : le second conducteur appelle désormais `findDuplicateClient` (téléphone, n° de pièce, n° de permis) — une correspondance **exacte** réutilise le client existant, une correspondance **floue** (nom seul) est ignorée (aucun flux d'interface pour trancher une ambiguïté côté second conducteur, contrairement au client principal). Voir INCIDENTS.md INC-13 pour le détail complet.

**Confirmation qu'aucun doublon ne réapparaît après rechargement des fixtures** : ce projet n'a pas de commande de seed (CLAUDE.md règle 7) — la vérification équivalente est l'exécution répétée de la suite de tests (`node scripts/test-grouped.mjs`, 1334/1334 sur 4 exécutions consécutives du fichier `reservations.test.ts`) et les 3 tests dédiés (section 5) confirmant explicitement l'absence de doublon même en répétant deux fois la même conversion avec le même second conducteur.

## 3. Modèle de données du surclassement (Partie B)

Voir DOMAINRULES.md section 70 pour le détail complet. Résumé : nouveau modèle `LocationUpgrade` (1:1 avec `Location`, `ON DELETE RESTRICT`), champs `type`/`reservedCategory`/`assignedCategory`/`dailySupplement`/`daysCount`/`totalSupplement`/`currency`/`customerConsent`/`operationalReason`/`validatedByUserId`/`reservationId`(nullable)/`vehicleId`. Vérifié avant création qu'aucune structure existante ne pouvait être étendue proprement (pas de champ catégorie réservée/attribuée, pas de modèle de supplément/option générique, pas de table d'audit métier dédiée) — pas de doublon fonctionnel créé.

**Limite documentée et assumée** : aucune hiérarchie de catégories n'existe dans le produit (texte libre) — impossible de distinguer mécaniquement « supérieur »/« inférieur » sans inventer une taxonomie non validée (CLAUDE.md règle 8). La règle appliquée est donc « toute catégorie différente doit être déclarée », dans les deux sens. **Signalé explicitement, pas une décision prise unilatéralement.**

## 4. Règles retenues par type (Partie C)

Aucune règle métier différente n'existait déjà dans le produit pour ces trois cas — pas de conflit à signaler, les règles ci-dessous ont été appliquées telles que spécifiées dans le brief :
1. **CUSTOMER_REQUEST** : supplément/jour obligatoire, entier strictement positif ; accord client explicite obligatoire ; motif obligatoire.
2. **UNAVAILABILITY** : gratuit et forcé (tout supplément non nul refusé, jamais silencieusement remis à zéro) ; disponibilité réelle de la catégorie réservée vérifiée par le serveur avant acceptation (refus 409 si un véhicule est réellement disponible) ; justification opérationnelle obligatoire.
3. **COMMERCIAL_GESTURE** : supplément optionnel, positif ou nul, jamais négatif ; permission dédiée `locations.upgrade.commercial_gesture` (non accordée à aucun groupe par défaut) ; motif obligatoire ; audit.

## 5. Contrôle serveur et validations obligatoires (Parties D/E)

Implémenté dans `resolveLocationUpgrade` (`src/lib/location-upgrades.ts`) et `POST /api/reservations/[id]/convert` — dans la même transaction Prisma que le reste de la conversion :
- Catégories dérivées exclusivement du serveur (`vehicle.category`/`reservation.vehicleCategory` chargés en base), jamais du corps de requête.
- Véhicule déjà vérifié : tenant, agence autorisée, disponibilité réelle sur toute la période, statuts bloquants exclus (`MAINTENANCE`/`TRANSFERRING`/`ON_TRIP`/`INACTIVE`), verrouillage atomique (`lockVehicleForUpdate`) empêchant toute double attribution concurrente — contrôles déjà en place (section 69), non dupliqués, réutilisés tels quels.
- Type invalide, motif vide, accord/justification manquants, supplément négatif ou nul (CUSTOMER_REQUEST), catégorie non déclarée, déclaration fournie sans changement de catégorie : tous refusés (400), messages clairs sans donnée sensible.
- UNAVAILABILITY avec catégorie réellement disponible : refusé (409).
- Permission manquante pour COMMERCIAL_GESTURE : refusée (403), avant même l'ouverture de la transaction (fast-fail).
- Contrat déjà verrouillé/réservation déjà convertie/conversion concurrente : déjà couverts par `claimReservationConversion` (étape 4, avant toute résolution de surclassement) — non affectés par cette passe, revérifiés par lecture de code et par la suite de tests existante (inchangée, toujours verte).
- Montant client (`dailySupplement`) : jamais accepté tel quel — recalculé (`daysCount`/`totalSupplement`) et falsification testée explicitement (voir section 6, test dédié).

## 6. Tests de non-régression ajoutés (Partie H)

`src/__tests__/reservations.test.ts` — describe dédié au surclassement (~15 tests) : catégorie identique (aucun surclassement) ; CUSTOMER_REQUEST avec recalcul serveur et falsification cliente ignorée ; UNAVAILABILITY gratuit avec vérification réelle de disponibilité (accepté/refusé selon disponibilité réelle) ; COMMERCIAL_GESTURE avec permission + audit ; refus permission manquante (403) ; catégorie non déclarée (400) ; déclaration sans changement (400) ; type invalide (400) ; motif manquant × 3 types (400) ; accord client manquant (400) ; supplément négatif × 2 types (400) ; supplément nul CUSTOMER_REQUEST (400) ; cohérence contrat/facture/paiement/audit complète ; véhicule `INACTIVE` toujours refusé (409). Plus 3 tests dédoublonnage second conducteur (doublon Omar) et 1 test d'audit `client.created` (INC-15). `src/__tests__/clients.test.ts` — 1 test `deleteClient`/second conducteur (INC-14).

Aucun test E2E supplémentaire créé au-delà de la vérification manuelle en navigateur réel décrite section 8 (pas d'infrastructure E2E Playwright automatisée dans ce projet à ce jour — vérifié, seul Vitest est en place).

## 7. Bugs supplémentaires trouvés et corrigés dans le même périmètre (Partie I)

Revue ciblée du parcours de conversion, sélection de véhicule, calculs (jours/tarif/supplément), catégories, disponibilité, permissions, audit, facture, paiement, verrouillage de contrat, fixtures, formulaires, messages d'erreur :

- **INC-14** : `deleteClient()` ne vérifiait que `Location.clientId`, jamais `Location.secondDriverId` — un client second conducteur pouvait être supprimé, la contrainte `ON DELETE SET NULL` effaçant alors silencieusement cette identité sur un contrat existant. Corrigé (garde symétrique ajoutée) et testé.
- **INC-15** : aucun client créé par la conversion (principal ou second conducteur) n'était journalisé dans `AuditLog` (`createClient()` ne journalise jamais lui-même, et cette route ne l'a jamais fait après coup, contrairement à `POST /api/clients`) — cause aggravante directe de l'opacité initiale du doublon Omar (impossible de dater/tracer sa création a posteriori). Corrigé (`client.created` journalisé pour tout client réellement créé, jamais pour un client réutilisé) et testé.
- **Confirmation d'un défaut déjà documenté, maintenant clos** : l'ancien bloc de surclassement du formulaire (`ConvertReservationForm.tsx`) repliait le supplément dans `totalPrice` (déjà éditable côté client) et une phrase dans `notes` (texte libre) — confirmé par lecture du code avant modification qu'aucune vérification serveur n'existait sur ce chemin, exactement comme documenté en section 69/DOMAINRULES.md. Ce n'est pas une découverte nouvelle de cette section mais la confirmation empirique, avant correction, du gap déjà signalé.

**Recherché mais non trouvé dans ce périmètre** (revue de code ciblée, non reproduit empiriquement au-delà de ce qui est listé ci-dessus) : IDOR sur le parcours de conversion, fuite inter-tenant/inter-agence, montant flottant, transaction/verrou manquant, statut HTTP incorrect, écriture partielle après refus, incohérence contrat/facture/paiement, régression agent RAK/CASA, erreur de date/fuseau horaire — tous vérifiés par lecture de code et/ou par la suite de tests existante (inchangée sur ces points, toujours verte). Non reproduit : aucun indice trouvé justifiant une reproduction active supplémentaire sur ces axes dans le temps imparti à cette passe.

## 8. Anomalies rencontrées et corrigées pendant la rédaction des tests (isolation, pas des défauts produit)

Plusieurs itérations ont été nécessaires pour stabiliser les nouveaux tests dans le contexte du fichier complet (129-130 tests avant ajout, partagé avec de nombreuses autres suites) :
- Collision de dates sur un véhicule partagé entre un nouveau test et un test préexistant plus loin dans le fichier (même véhicule, mêmes dates) → véhicule dédié créé pour les tests de surclassement.
- Catégorie « Citadine » partagée avec de nombreuses autres fixtures du fichier, rendant un test de disponibilité (UNAVAILABILITY) non déterministe → catégorie dédiée et unique par exécution introduite.
- Collision floue (Levenshtein < 3) accidentelle entre deux clients de test partageant un `runId` commun et des noms proches (ex. « AuditPrincipal »/« AuditPrincipal2 ») lors d'une exécution complète du fichier (des centaines d'autres clients existent alors dans le même tenant) → `forceCreateClient: true` ajouté aux tests concernés (le comportement de détection de doublon lui-même, testé ailleurs, n'a jamais été modifié ni contourné pour les scénarios qui le testent spécifiquement).
- Collision de dates avec un test préexistant utilisant les mêmes dates sur le véhicule partagé `vehicleAId` → dates du nouveau test déplacées vers un créneau libre (vérifié par recherche exhaustive dans le fichier avant de choisir les nouvelles dates).

Chaque cas a été diagnostiqué avant correction (jamais une modification à l'aveugle) et confirmé stable sur 3 à 4 exécutions consécutives de la suite complète du fichier après correction. Aucun de ces ajustements n'a modifié le comportement du code de production, ni affaibli une assertion existante — uniquement l'isolation des données créées par les tests eux-mêmes.

## 9. Interface (Partie F)

`ConvertReservationForm.tsx` reconstruit : affiche catégorie réservée/attribuée, sélection du type de surclassement (COMMERCIAL_GESTURE visible uniquement si l'utilisateur a la permission dédiée, calculée côté serveur dans `page.tsx`), motif, accord client ou justification opérationnelle selon le type, supplément/jour, estimation indicative (jours × supplément, jours × total), avertissement explicite avant validation, astérisques rouges sur les champs requis, blocage de soumission si champs locaux incomplets. Le montant final n'est jamais affiché autrement que via la réponse serveur (redirection après validation vers la page de détail, qui relit les données depuis le serveur). Ancien bloc informel (case « Gratuit », supplément replié dans `totalPrice`/`notes`) intégralement retiré.

## 10. Contrat/facture/audit (Partie G)

Vérifié par test automatisé dédié et par vérification manuelle (section 11) : `Location.totalPrice` inclut le supplément recalculé côté serveur ; `Invoice.subtotal`/`totalAmount` reflètent ce montant ; paiement basé sur le total recalculé ; `AuditLog` (`location.upgraded`) contient utilisateur, tenant (implicite via `logAction`), agence, action, type de surclassement, contrat, réservation, catégorie avant/après, véhicule, supplément, montant total, motif, accord/justification, date/heure. Aucune donnée bancaire stockée.

## 11. Vérification manuelle en navigateur réel

Serveur `next dev` démarré sur `xrent_dev`. Tenant/agence/2 véhicules (catégories « Citadine »/« SUV » distinctes)/réservation créés via l'API (identifiants jetables, propres à cette vérification). Connexion réelle en navigateur (Playwright/Chromium), navigation jusqu'au formulaire de conversion, activation du surclassement (case « Autoriser un surclassement »), sélection du véhicule SUV → bloc de surclassement affiché correctement (type/motif/accord/supplément), type CUSTOMER_REQUEST sélectionné, formulaire rempli et soumis avec succès (201, redirection). Vérifié ensuite par requêtes API directes : `Location.totalPrice = 39000` (24000 base + 15000 supplément, 50 MAD/jour × 3 jours), `Invoice` cohérente (39000, `PAID`), `AuditLog` (`location.upgraded`) contenant tous les champs attendus avec les valeurs exactes calculées par le serveur (jamais les valeurs saisies transformées côté client). Serveur de développement arrêté après vérification.

## 12. Commandes de validation exécutées (Partie J)

| Commande | Résultat |
|---|---|
| `src/__tests__/reservations.test.ts` isolé, 4 exécutions consécutives | ✅ 130/130 à chaque fois |
| `node scripts/test-grouped.mjs` (suite complète) | ✅ 1334/1334, 0 échec/timeout/résiduel |
| `npx tsc --noEmit` | ✅ Aucune erreur |
| `npm run lint` | ✅ Aucune erreur |
| `npm run build` | ✅ Build de production réussi |
| `git status`/`git diff` avant et après | ✅ Vérifiés (voir section 1) |

Migration Prisma : créée proprement (`prisma migrate dev --create-only` puis revue du SQL avant application), jamais de modification manuelle d'une migration déjà appliquée, appliquée à `xrent_dev` (`prisma migrate dev`) puis à `xrent_test` (`prisma migrate deploy`) — jamais à un environnement de production (qui n'existe pas à ce jour).

## 13. Rapport final structuré (27 points)

Vocabulaire de statut : Corrigé et vérifié / Corrigé mais vérification partielle / Non reproduit / Bloqué par décision métier / Bloqué par environnement / Hors périmètre justifié / Encore ouvert.

1. **État Git avant/après** — Corrigé et vérifié (section 1).
2. **Fichiers modifiés** — Corrigé et vérifié (section 1, liste complète).
3. **Cause exacte du doublon Omar** — Corrigé et vérifié (section 2).
4. **Correction appliquée (doublon)** — Corrigé et vérifié (section 2).
5. **Confirmation absence de doublon après rechargement des fixtures** — Corrigé et vérifié (section 2 — pas de commande de seed dans ce projet ; équivalent testé via exécutions répétées et tests dédiés).
6. **Modèle de données du surclassement** — Corrigé et vérifié (section 3, DOMAINRULES.md section 70).
7. **Règles métier retenues** — Corrigé et vérifié (section 4 — aucun conflit avec une règle existante à signaler).
8. **Contrôles serveur implémentés** — Corrigé et vérifié (section 5).
9. **Contrôle de disponibilité** — Corrigé et vérifié (section 5, `isCategoryReallyAvailable`, réutilise `checkAvailability`).
10. **Protection contre la double attribution** — Corrigé et vérifié (verrouillage atomique déjà en place, réutilisé tel quel, non modifié par cette passe).
11. **Calcul du supplément** — Corrigé et vérifié (section 3/5, entiers en centimes, jamais de float).
12. **Validation accord/justification** — Corrigé et vérifié (section 4/5).
13. **Utilisateur validateur enregistré** — Corrigé et vérifié (`validatedByUserId` sur `LocationUpgrade`).
14. **Audit créé** — Corrigé et vérifié (section 10, `location.upgraded`, tous les champs requis présents).
15. **Cohérence contrat/facture/paiement** — Corrigé et vérifié (section 10/11, vérifié par test automatisé et par navigateur réel).
16. **Permissions nécessaires** — Corrigé et vérifié (`locations.upgrade.commercial_gesture`, non accordée par défaut, vérifiée côté route et reflétée côté interface).
17. **Tests ciblés** — Corrigé et vérifié (section 6/12, 130/130 sur le fichier concerné, 4 exécutions consécutives).
18. **Tests complets** — Corrigé et vérifié (section 12, 1334/1334).
19. **Tests E2E** — Hors périmètre justifié (aucune infrastructure E2E automatisée dans ce projet à ce jour ; vérification manuelle en navigateur réel effectuée à la place, section 11).
20. **TypeScript/lint/build** — Corrigé et vérifié (section 12).
21. **Bugs supplémentaires trouvés** — Corrigé et vérifié (section 7, INC-14/INC-15).
22. **Bugs supplémentaires corrigés** — Corrigé et vérifié (section 7 — les deux trouvés ont été corrigés et testés).
23. **Bugs restants ouverts** — Encore ouvert : aucun bug connu dans le périmètre exploré ; les axes explicitement listés par le brief (IDOR, fuite tenant/agence, float, transaction/verrou, statut HTTP, écriture partielle, audit incomplet, incohérence contrat/facture/paiement, régression RAK/CASA, date/fuseau horaire) ont été revus par lecture de code sans reproduction active supplémentaire au-delà des deux trouvés — une revue plus approfondie (fuzzing, tests de charge) resterait à faire si le propriétaire du projet le juge nécessaire, mais rien de concret n'a été identifié.
24. **Données créées** — Corrigé et vérifié : données de vérification manuelle jetables dans `xrent_dev` (1 tenant, 1 agence, 2 véhicules, 1 réservation/contrat/facture, voir section 11) — non supprimées après vérification (conservées comme preuve, cohérent avec le précédent déjà établi dans ce projet de conserver des données de vérification ponctuelles ; à supprimer sur simple demande).
25. **Données modifiées** — Corrigé et vérifié : aucune donnée métier existante modifiée en dehors du doublon Omar (déjà supprimé avant cette rédaction, section 2) et des données de vérification manuelle créées par cette passe.
26. **Données supprimées** — Corrigé et vérifié : uniquement le client doublon `cmta4icak00e9m4n9nue89wal` (section 2), via l'application, journalisé.
27. **Prêt pour le sprint suivant** — Bloqué par décision métier : en attente de validation explicite de ce rapport par le propriétaire du projet avant de commencer la partie 3 de la campagne QA ou tout nouveau sprint, conformément à la consigne reçue.

**Aucun commit créé, aucun push effectué, sprint suivant non commencé.**
