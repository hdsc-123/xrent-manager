# Runbook — Reprise de la campagne de validation QA

Procédure de reprise de la campagne de validation manuelle du tenant QA fictif. Dernière mise à jour : 2026-08-27 (passe de correction post-partie 2 — INC-12, permission `agencies.view` du groupe AGENT). Voir [HANDOFF.md](../../HANDOFF.md) pour l'état global du projet.

## 1. Avant de commencer

- Vérifier l'état Git (`git status --short`, `git log -1 --oneline`) avant toute action.
- Vérifier qu'aucune base de production n'est configurée (`DATABASE_URL` dans `.env`/`.env.test` doit pointer sur `localhost`).
- Ne jamais lancer `data-reset` sur le tenant de campagne sans confirmation explicite du propriétaire du projet.
- Ne jamais écrire de mot de passe/secret dans un fichier suivi par Git (voir section 4).

## 2. Environnement et identifiants

- Environnement : développement, base `xrent_dev` (locale).
- Tenant de campagne : `QA FICTIF - XRent Validation` (id `cmta2y6uy0000m4n9xvm0hr18`, slug `qa-fictif-xrent-2026`).
- **Identifiants** : stockés uniquement dans `.env.qa.local` à la racine du dépôt (fichier local, exclu du suivi Git par le motif `.env*` de `.gitignore` — vérifié par `git check-ignore -v .env.qa.local`). Ce fichier contient les adresses email des comptes de campagne et un mot de passe partagé, réinitialisé le 2026-08-26 sur autorisation explicite du propriétaire du projet pour 4 comptes (`qa.superadmin`, `qa.agent.rak`, `qa.agent.casa`, `qa.auditeur`). **Ne jamais copier ces valeurs dans un document suivi par Git.**
- Si `.env.qa.local` est absent ou que les identifiants ne fonctionnent plus : réinitialiser le mot de passe des comptes nécessaires directement en base (`xrent_dev` uniquement), **uniquement sur autorisation explicite du propriétaire du projet**, et consigner la nouvelle valeur dans `.env.qa.local` (jamais ailleurs).

## 3. Données fictives de campagne (état au 2026-08-27, fin de la partie 2)

- Agences : RAK (id `cmta2z7xo006am4n9nvq8xx94`), CASA (id `cmta2zslq006em4n9hxg43g8p`).
- 7 véhicules : Dacia Logan QA-CatA-RAK (RAK, disponible), Renault Clio QA-CatB-RAK (RAK, disponible — véhicule du contrat n°00002), Toyota Corolla QA-CatC-CASA (CASA, disponible), Hyundai Accent QA-DejaLoue-RAK (RAK, loué), Peugeot 208 QA-Maintenance-RAK (RAK, en maintenance), Dacia Duster QA-Transfert-RAK (RAK, disponible — désormais réservé sur deux contrats de test, voir ci-dessous), Renault Kangoo QA-Deplacement-CASA (CASA, disponible, prévu pour déplacement).
- 7 clients d'origine : Ahmed Fictif-Majeur, Karim Fictif-PermisExpireBientot, Nadia Fictif-PermisExpire, Omar Fictif-SecondCondValide (**doublon élucidé et corrigé le 2026-08-27, voir INCIDENTS.md INC-13** — n'apparaît plus qu'une seule fois dans le sélecteur), Sara Fictif-SecondCondNonConforme, Yasmine Fictif-Moins21.
- Client « Sofia Fictif-Part1 » (partie 1, conservé, démonstration CRUD complète).
- Contrat n°00002 (id `cmta4o81l00f5m4n9dy16fif1`) : RAK départ, CASA retour, **`COMPLETED`** (kilométrage retour 28450, carburant Plein) — ne pas rejouer tel quel.
- Contrat n°00005 (réservation `QA-PART1-RES-001` convertie, Ahmed Fictif-Majeur, RAK, 28/08→31/08/2026, `PENDING`) conservé, démonstration réservation → contrat.
- **Découvert en début de partie 2 (2026-08-27), non documenté avant cette session** : réservations `QA-RES-001` (RAK→RAK) et `QA-RES-002` (RAK→CASA) déjà `CONVERTED` depuis le 2026-08-26, respectivement contrats n°00001 (`PENDING`) et n°00002 (le contrat déjà connu ci-dessus) — travail d'une session interrompue sans rapport écrit (même schéma qu'INC-1/INC-8). Signalé, non modifié.
- **Nouveau (partie 2, 2026-08-27)** : réservations `QA-PART2-RES-RAK-001` (RAK→RAK, `CANCELLED` — démonstration création→édition→annulation), `Dir-0001` (RAK→CASA, voucher DIRECT auto-généré, `PENDING`), `QA-PART2-RES-CASA-001` (CASA→CASA, `PENDING`, utile pour de futurs tests d'isolation) conservées. Contrats n°00006/00007 (Dacia Duster, RAK, tous deux `PENDING`) conservés — démonstration double réservation refusée (00006 vs tentative chevauchante) et période adjacente non chevauchante acceptée (00007 juste après 00006). **La numérotation de contrat RAK reprend à 00008** pour la prochaine location créée.
- Contrats n°00003/00004 : créés transitoirement pendant la partie 1 pour vérifier les bornes exactes d'âge/permis, **supprimés après vérification**.
- Client résiduel `firstName: "Ahmed", lastName: "   "` (partie 1) : signalé puis **supprimé**.
- Réservations `QA-PART2-WHITESPACE-TEST` et `QA-PART2-DATE-TEST-1` (partie 2) : créées pour reproduire/démontrer BUG-008 et le comportement des dates/heures, **supprimées après vérification** (aucune dépendance).
- Détail complet partie 1 : [docs/test-reports/2026-08-26-campagne-partie1-clients.md](../test-reports/2026-08-26-campagne-partie1-clients.md). Détail complet partie 2 : [docs/test-reports/2026-08-27-campagne-partie2-reservations.md](../test-reports/2026-08-27-campagne-partie2-reservations.md). Détail complet BUG-001/004/005 : [docs/test-reports/2026-08-26-bug-001-004-005.md](../test-reports/2026-08-26-bug-001-004-005.md).

## 4. Règles de sécurité pour la reprise

- Ne jamais écrire un mot de passe, jeton ou secret réel dans HANDOFF.md, TESTREPORT.md, INCIDENTS.md, DOMAINRULES.md, SECURITY.md, ARCHITECTURE.md, PROJECT_MAP.md, README.md, ou tout fichier suivi par Git.
- Avant de committer, vérifier `git status`/`git diff` — un mot de passe collé par erreur dans un fichier suivi doit être retiré avant tout commit.
- Toute réinitialisation de mot de passe de compte QA reste scopée à `xrent_dev`, jamais une base de production (qui n'existe pas à ce jour).
- Respecter l'isolation tenant/agence à chaque scénario testé (vérifier explicitement qu'un agent RAK/CASA ne voit que son périmètre, qu'un autre tenant ne voit rien).
- Ne pas contourner l'application par une modification directe en base pour simuler un parcours utilisateur métier (seules les données de configuration — comptes de test, mots de passe — peuvent être ajustées directement, jamais un état métier comme un statut de contrat).

## 5. Scénarios déjà validés (ne pas refaire)

- BUG-001, BUG-004, BUG-005, BUG-006, BUG-007, BUG-008 : corrigés et vérifiés (tests automatisés + vérification manuelle) — voir [INCIDENTS.md](../../INCIDENTS.md) INC-6/INC-7/INC-8/INC-9/INC-10/INC-11.
- INC-12 (véhicule `INACTIVE` non bloqué pour la création/conversion d'une `Location`) : corrigé et vérifié le 2026-08-27, voir [INCIDENTS.md](../../INCIDENTS.md) INC-12.
- **Doublon « Omar Fictif-SecondCondValide » — élucidé et corrigé le 2026-08-27** (INC-13) : second conducteur d'une conversion créé sans détection de doublon, doublon supprimé (aucune relation), anti-réapparition testé. **Surclassement — implémenté côté serveur le 2026-08-27** (modèle `LocationUpgrade`, DOMAINRULES.md section 70) : ne reste plus une simple convention d'interface. Deux bugs supplémentaires trouvés/corrigés dans le même périmètre : INC-14 (`deleteClient`/second conducteur), INC-15 (audit client manquant à la conversion). Détail complet : [docs/test-reports/2026-08-27-passe-correction-surclassement-omar.md](../test-reports/2026-08-27-passe-correction-surclassement-omar.md).
- Permission `agencies.view` du groupe personnalisé « AGENT » (tenant QA) : **corrigée le 2026-08-27** sur autorisation explicite du propriétaire du projet (34 permissions au lieu de 33, via `PATCH /api/permission-groups/[id]`, journalisée) — `qa.agent.rak`/`qa.agent.casa` voient désormais correctement les villes RAK/Casablanca dans `/dashboard/reservations/new`. Voir [docs/test-reports/2026-08-27-campagne-partie2-reservations.md](../test-reports/2026-08-27-campagne-partie2-reservations.md) section 12.4.
- Isolation agence RAK/CASA (sélecteurs véhicule scopés, visibilité contrat n°00002 par l'agence de retour).
- Retour de véhicule RAK→CASA (kilométrage, carburant, transition de statut) sur le contrat n°00002.
- **Partie 1 (2026-08-26, complète)** : point 1 (clients fictifs — CRUD, champs obligatoires, coordonnées, pièce d'identité), point 13 (âge minimum du conducteur, borne exacte 21 ans testée), point 14 (dates d'obtention/expiration du permis), point 15 (permis expirant avant le retour), ainsi que persistance, audit, permissions (clients non agence-scopés, conforme DOMAINRULES.md section 9), isolation tenant, usage en réservation/conversion, refus serveur (âge/permis) et responsive du module clients. Détail complet : [docs/test-reports/2026-08-26-campagne-partie1-clients.md](../test-reports/2026-08-26-campagne-partie1-clients.md).
- **Partie 2 (2026-08-27, complète)** : points 2 (réservation RAK→RAK), 3 (RAK→CASA), 4 (option GPS), 5 (siège bébé), 7 (conducteur supplémentaire), 8 (validation des dates et heures), 9 (véhicule indisponible, vérifié sur `Location`), 10 (double réservation, vérifié sur `Location`) — ainsi que modification/annulation/suppression d'une réservation, persistance, visibilité par agence RAK/CASA (y compris via l'agence de retour), refus d'accès direct, isolation tenant, contrôle des permissions et responsive **du module Réservations spécifiquement** (ces derniers points restent à revalider sur les modules non encore couverts avant de clore les points 51-56 du présent runbook). **Point 6 (« Supplément hors horaires ») classé N/A** : fonctionnalité non implémentée dans le code (constat documenté, pas une régression) — ne pas re-tester tant qu'aucune décision produit ne l'introduit. Détail complet : [docs/test-reports/2026-08-27-campagne-partie2-reservations.md](../test-reports/2026-08-27-campagne-partie2-reservations.md).
- Non re-testé mais déjà couvert par la suite automatisée (pas nécessaire de refaire manuellement) : refus 403 d'un compte sans permission `clients.*`/`reservations.*` (mot de passe non disponible pour `qa.sanspermission@fictif.test`, voir rapports parties 1/2).

## 6. Scénarios restants à exécuter (43/56, hors le point 6 classé N/A)

Non exécutés, non validés, toujours dans le périmètre du projet. **Doublon Omar — résolu (2026-08-27)**, voir section 5. **Point de configuration résolu (2026-08-27)** : le groupe de permissions personnalisé « AGENT » a désormais `agencies.view` (voir section 5) — les comptes `qa.agent.rak`/`qa.agent.casa` peuvent utiliser normalement les listes déroulantes d'agence. **Surclassement (points 16-19) — implémenté côté serveur (2026-08-27)** : le contrôle serveur existe désormais réellement (modèle `LocationUpgrade`, DOMAINRULES.md section 70) — ces points peuvent être testés comme une vraie garantie serveur, plus seulement une convention d'interface. À exécuter dans l'ordre suivant (repris du brief de campagne original), en utilisant le terminal pour les vérifications déterministes (calculs, validations, permissions serveur, isolation) et Playwright pour tout ce qui nécessite un navigateur réel (navigation, formulaires, PDF, responsive) :

11. Conversion en contrat.
12. Numéro automatique du contrat.
16. Surclassement demandé par le client.
17. Surclassement imposé par indisponibilité.
18. Supplément de surclassement.
19. Surclassement gratuit.
20. Paiement en espèces.
21. Paiement par carte fictive.
22. Paiement mixte.
23. Solde restant.
24. Paiement supérieur au solde.
25. Double paiement.
26-28. (Retour véhicule / kilométrage / carburant : déjà couverts sur le contrat n°00002 — à revalider sur un **nouveau** contrat, celui-ci étant déjà `COMPLETED`.)
29. Dommages.
30. Frais supplémentaires.
31. Facture.
32. PDF contrat.
33. PDF facture.
34. PDF groupé.
35. Transfert RAK → CASA.
36. Réception du transfert.
37. Bon de déplacement interne.
38. Absence de contrat pour déplacement interne.
39. Kilométrage automatique.
40. Niveau de carburant automatique.
41. Import Excel valide.
42. Dates Excel invalides.
43. Villes mal orthographiées.
44. Indication des lignes Excel en erreur.
45. Import partiel.
46. Export.
47. Injection CSV.
48. Audit.
49. Suppression d'audit uniquement pour le super administrateur.
50. Alertes.
51. Permissions.
52. Isolation agence.
53. Isolation tenant.
54. Responsive desktop.
55. Responsive tablette.
56. Responsive mobile.

## 7. Après chaque lot de scénarios

- Documenter les résultats dans un nouveau fichier `docs/test-reports/<date>-campagne-suite.md` (pas directement dans TESTREPORT.md — y ajouter seulement une ligne d'index).
- Consigner tout bug trouvé dans INCIDENTS.md selon le gabarit standard.
- Mettre à jour ce runbook (section 5/6) pour refléter ce qui a été validé.
- Ne pas déclarer la campagne complète tant que des scénarios restent non exécutés.
