# Plan de restructuration documentaire — 2026-08-26

Proposition de classement écrite, rédigée **avant** toute suppression, conformément à la demande explicite du propriétaire du projet. Aucune information n'est supprimée par ce plan — chaque bloc de contenu est soit déplacé verbatim, soit résumé avec renvoi vers le texte complet déplacé.

## Constat (mesure avant modification)

| Fichier | Taille | Lignes |
|---|---|---|
| HANDOFF.md | 518 421 octets (~506 Ko) | 1158 |
| TESTREPORT.md | 562 283 octets (~549 Ko) | 2179 |
| INCIDENTS.md | 133 872 octets (~131 Ko) | 291 |
| DOMAINRULES.md | 441 601 octets (~431 Ko) | 1251 |
| SECURITY.md | 99 869 octets (~98 Ko) | 461 |
| ARCHITECTURE.md | 22 047 octets (~22 Ko) | 171 |
| PROJECT_MAP.md | 105 864 octets (~103 Ko) | 486 |

**Cause racine de la taille de HANDOFF.md** : le document contient, en plus de son état courant (sections 2 à 10), une **chronologie complète dupliquée** de tous les sprints depuis le Sprint 0 (2026-08-11) jusqu'à aujourd'hui, sous deux formes redondantes :
1. Une chaîne de 43 entrées « Dernière mise à jour (précédente) » (lignes 5-215), la plus récente en tête.
2. La section « 1. État actuel » (lignes 231-782), qui reconstruit la même chronologie sprint par sprint (« Le projet est passé par le stade X, puis Y, puis Z... ») jusqu'au commit initial.

Chaque entrée de ces deux blocs renvoie déjà systématiquement vers DOMAINRULES.md, SECURITY.md, ARCHITECTURE.md ou TESTREPORT.md pour le détail faisant autorité (« voir DOMAINRULES.md section X ») — ces deux blocs sont donc du **narratif historique redondant avec les documents déjà en place**, jamais la seule source d'une information. C'est la cause de plus de 85 % du volume du fichier.

TESTREPORT.md suit exactement le même schéma : une table synthétique compacte (section 1, lignes 5-271) suivie d'environ 60 sous-sections « ### Tests Sprint N » (lignes 279-2157) au format narratif très dense, une par sprint.

INCIDENTS.md est déjà proche du format « registre synthétique » cible (gabarit court par incident), à l'exception d'INC-3 dont l'historique d'investigation (lignes 119-263, ~144 lignes sur 291) domine le fichier.

## Doublons identifiés

- HANDOFF.md lignes 5-215 (chronologie) et lignes 231-782 (« État actuel ») racontent la même histoire deux fois, sous deux formes différentes.
- HANDOFF.md section 6 (« Décisions prises », Sprint 0-14D) duplique des décisions déjà documentées section par section dans DOMAINRULES.md (le texte du document le confirme lui-même, ligne 942 : « les décisions techniques des Sprints 12A à 14C n'ont pas été dupliquées dans cette section [...] elles restent entièrement documentées [...] dans DOMAINRULES.md »).
- HANDOFF.md section 9 (points 38-48, cadrage du 2026-08-24) est déjà intégralement cross-référencée par numéro de section dans DOMAINRULES.md/SECURITY.md/ARCHITECTURE.md.
- TESTREPORT.md section 1 (table) et les sous-sections narratives « ### Tests Sprint N » couvrent souvent les mêmes résultats de test, la table donnant la version compacte et la sous-section la version détaillée.

## Sorties Playwright / logs détaillés identifiés

- HANDOFF.md et TESTREPORT.md : nombreuses mentions de vérifications manuelles Playwright/Chromium (Sprint 18, Sprint 20, Sprint 21, Sprint 34 étape 1, sprint de stabilisation technique responsive 768px) avec un niveau de détail opérationnel (viewports, étapes de clic, résultats console) qui relève d'un rapport de session détaillé, pas d'un état courant.
- INCIDENTS.md INC-3 : historique d'investigation technique complet (profilage CPU, `pg_stat_activity`, tests d'architecture Vitest écartés) — détail précieux mais clairement un rapport d'investigation, pas un résumé d'incident.

## Règles métier / décisions techniques importantes identifiées (à préserver intégralement)

- HANDOFF.md section 8 : tableau de suivi des 47 points de décision (statut FAIT/REPORTÉ/EN COURS/TRANCHÉ) — **document vivant, toujours utile**, à conserver intégralement (pas seulement archiver).
- HANDOFF.md « Finding F » (lignes 216-230) : contient un avertissement **encore valable et non résolu** — DOMAINRULES.md décrirait encore un gate de facturation retiré depuis le Sprint 27, à corriger avant tout futur sprint touchant à la facturation. Ce point ne doit pas être enterré dans une archive silencieuse : il doit rester visible comme point ouvert.
- Toutes les règles métier déjà dans DOMAINRULES.md/SECURITY.md/ARCHITECTURE.md : **non touchées par ce plan**, elles restent la source faisant autorité.

## Bugs et incidents identifiés

- INC-1 à INC-8 (INCIDENTS.md), dont INC-6/INC-7/INC-8 = BUG-004/BUG-005/BUG-001 (session du 2026-08-26, corrigés et vérifiés) — statuts déjà exacts, à préserver.
- « Finding F » (HANDOFF.md) : point de documentation non résolu, voir ci-dessus.

## Informations sensibles identifiées

- Un mot de passe de test avait été trouvé et corrigé (redacté) dans une session précédente. Un nouveau scan de cette session confirme : **aucun mot de passe, jeton ou secret dans HANDOFF.md, TESTREPORT.md, INCIDENTS.md, DOMAINRULES.md, SECURITY.md, ARCHITECTURE.md, PROJECT_MAP.md, README.md** à ce jour (recherche par motif de valeur, pas seulement par mot-clé). `.env.qa.local` reste exclu du suivi Git (`git check-ignore` confirmé) et n'est jamais cité que par son nom de fichier.

## Plan de classement détaillé

### HANDOFF.md (506 Ko → cible < 20 Ko)

| Contenu source | Destination |
|---|---|
| Lignes 5-215 (chaîne « Dernière mise à jour », 43 entrées, 2026-08-14 → 2026-08-26) | Déplacé **verbatim** vers `docs/history/handoff-changelog-archive.md` |
| Lignes 216-230 (« Finding F ») | Déplacé **verbatim** vers le même fichier d'archive ; **résumé conservé** dans le nouveau HANDOFF.md comme point ouvert (documentation DOMAINRULES.md à corriger) |
| Lignes 231-782 (section 1, « État actuel », narratif Sprint 0 → Sprint technique 6) | Déplacé **verbatim** vers `docs/history/handoff-sprint-log-archive.md` |
| Lignes 783-813 (section 2, « Ce qui est terminé ») | Déplacé **verbatim** vers `docs/history/handoff-sprint-log-archive.md` ; remplacé par un renvoi à PROJECT_MAP.md |
| Lignes 814-826 (section 3, « Ce qui n'est pas commencé ») | **Résumé conservé** dans le nouveau HANDOFF.md (daté, signalé comme à rafraîchir) ; texte complet archivé |
| Lignes 827-830 (section 4, « Prochaine action recommandée », obsolète) | **Remplacé** par l'action réelle actuelle (reprise des 53 scénarios) ; ancien texte archivé |
| Lignes 831-841 (section 5, « Commandes déjà validées », chiffres Sprint 14E) | **Remplacé** par les chiffres actuels (1293/1293) ; ancien tableau archivé |
| Lignes 842-953 (section 6, « Décisions prises », Sprint 0-14D) | Déplacé **verbatim** vers `docs/decisions/technical-decisions-log-archive.md` (déjà dupliqué dans DOMAINRULES.md sections 21-30) |
| Lignes 955-972 (section 7, « Risques identifiés », daté Sprint 11) | Déplacé **verbatim** vers `docs/decisions/technical-decisions-log-archive.md` |
| Lignes 973-1071 (section 8, tableau de suivi 47 points) | Déplacé **verbatim** vers `docs/decisions/open-items-tracker.md` — **conservé comme document vivant**, référencé depuis le nouveau HANDOFF.md |
| Lignes 1073-1134 (section 9, cadrage production 2026-08-24, points 38-48) | Déplacé **verbatim** vers `docs/decisions/2026-08-24-production-cadrage.md` |
| Lignes 1136-fin (section 10, session BUG-001/004/005, 2026-08-26) | **Condensé** dans le nouveau HANDOFF.md (déjà le contenu le plus pertinent) ; texte complet déjà dans TESTREPORT.md, copie de référence dans `docs/test-reports/2026-08-26-bug-001-004-005.md` |

### TESTREPORT.md (549 Ko → index synthétique)

| Contenu source | Destination |
|---|---|
| Section 1 (table chronologique compacte, lignes 5-271) | **Conservée telle quelle** dans TESTREPORT.md (déjà un index) |
| Section 2 (tests disponibles/non disponibles) | Conservée |
| Section 3 + ~60 sous-sections « ### Tests Sprint N » (lignes 279-2157) | Déplacées **verbatim** vers `docs/test-reports/sprint-test-history-archive.md` ; remplacées par une table d'index (sprint / date / résultat / lien) |
| « Tests session de reprise de campagne » + « Vérification en direct » (2026-08-26) | Déplacées vers `docs/test-reports/2026-08-26-bug-001-004-005.md` ; résumé d'une ligne + lien conservé dans TESTREPORT.md |
| Section 4 (format attendu des futurs rapports) | Conservée (gabarit toujours utile) |

### INCIDENTS.md (131 Ko → registre synthétique)

| Contenu source | Destination |
|---|---|
| Gabarit + INC-1, INC-2, INC-4, INC-5, INC-6, INC-7, INC-8 | Conservés dans INCIDENTS.md (déjà conformes au format court, sauf compléments verbeux) |
| INC-3 (lignes 119-263, investigation complète) | Narratif complet déplacé **verbatim** vers `docs/history/INC-3-full-investigation.md` ; INC-3 réduit dans INCIDENTS.md à un résumé (cause, correction, statut, chiffres finaux, lien vers le détail) |

### Nouveaux fichiers/dossiers

- `docs/history/` : archives verbatim (aucune perte d'information)
- `docs/decisions/` : décisions techniques/produit, dont `open-items-tracker.md` (vivant)
- `docs/test-reports/` : rapports de test détaillés par sprint/session
- `docs/runbooks/campagne-validation-qa.md` : nouvelle procédure de reprise de la campagne QA (identifiants, données fictives, prochaine étape) — contenu opérationnel actuellement dispersé dans HANDOFF.md, consolidé ici

## Ordre d'exécution

1. Archiver `HANDOFF.md` intégral et daté (copie brute, avant toute modification).
2. Créer les fichiers d'archive dans `docs/history/`, `docs/decisions/`, `docs/test-reports/` (déplacement verbatim des blocs listés ci-dessus).
3. Créer `docs/runbooks/campagne-validation-qa.md`.
4. Réécrire HANDOFF.md en version courte, avec liens vers les archives.
5. Réduire TESTREPORT.md et INCIDENTS.md en index/registre, avec liens vers les archives.
6. Vérifications finales (liens, secrets, `git diff --check`, tailles avant/après).

Aucun fichier de code, aucun test, aucune donnée de base ne sont concernés par ce plan.
