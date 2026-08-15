# INCIDENTS.md — Suivi des incidents projet

Ce document trace les incidents **techniques/projet** (bugs, pannes, régressions) rencontrés au cours du développement de XRent Manager. Il ne concerne pas les incidents métier liés à une location (dommage véhicule, accident, litige client) — ceux-ci relèveront d'un module métier dédié, dont les règles sont à définir dans [DOMAINRULES.md](./DOMAINRULES.md).

Trois incidents sont enregistrés ci-dessous : INC-1 (technique/process, environnement de développement, Sprint 15), INC-2 (bug applicatif de stabilité, hydration mismatch, Sprint 21) et INC-3 (infrastructure de test, blocage intermittent du serveur `next dev` partagé, Sprint 24-2).

## Structure d'un incident

Chaque incident futur devra être consigné ci-dessous en suivant ce gabarit :

```
## INC-<numéro> — <titre court>

- **Date** : <AAAA-MM-JJ>
- **Environnement** : <développement | test | staging | production>
- **Gravité** : <critique | majeure | mineure | cosmétique>
- **Description** : <description factuelle de l'incident>
- **Impact** : <utilisateurs/tenants/données concernés, durée>
- **Cause** : <cause identifiée, ou "en cours d'investigation">
- **Correction** : <description de la correction apportée, ou "non corrigé">
- **Test de non-régression** : <référence du test ajouté, ou "à ajouter">
- **Statut** : <ouvert | en cours | corrigé | clôturé>
- **Validation finale** : <nom/rôle du validateur et date, ou "en attente">
```

## Journal des incidents

## INC-3 — Blocage intermittent et total du serveur `next dev` de test partagé (suite de tests, `npm test`)

- **Date** : 2026-08-15
- **Environnement** : test (suite Vitest locale, serveur `next dev` de test dédié sur le port 3811, base `xrent_test`) — jamais observé en développement (`npm run dev`) ni en production
- **Gravité** : mineure pour le produit (aucun code applicatif ni utilisateur final concerné), mais gênante pour la fiabilité de la suite de tests (résultats `npm test` intermittents)
- **Description** : lors de l'exécution de la suite complète (610 tests, ~30 fichiers), certaines exécutions échouent avec des `Test timed out in 20000ms`/`Hook timed out in 60000ms` répartis sur un ensemble de fichiers différent à chaque run, sans jamais d'échec d'assertion. Signalé initialement sur `location-payment.test.ts` (hook `beforeAll`) et `e2e-full.test.ts`.
- **Impact** : aucun impact produit/production. Impact sur la suite de tests uniquement : `npm test` (parallélisme par défaut ou `--no-file-parallelism`) peut échouer de façon non déterministe sans qu'aucune régression de code n'existe réellement, ce qui oblige à relancer/isoler pour distinguer un vrai échec d'un faux positif d'infrastructure.
- **Cause** : confirmée par investigation (voir TESTREPORT.md, « Tests Sprint 24-2 », paragraphe « Investigation complémentaire ») — le serveur `next dev` unique et de longue durée partagé par toute la suite (nécessaire car `next/headers`, utilisé par NextAuth, exige un contexte de requête HTTP réel) entre parfois, sous charge soutenue (~610 tests, milliers de requêtes sur un seul processus tournant plusieurs minutes), dans un état de blocage complet où **toutes** les requêtes HTTP échouent (confirmé par watchdog externe : serveur totalement injoignable, pas seulement lent, jusqu'à plus de 4 minutes d'affilée dans le pire cas observé). Profilage du processus (`ps`, `sample`) pendant un blocage : 0 % CPU (processus réellement bloqué, pas en boucle infinie), 36 threads du processus tous parqués dans une attente de variable de condition noyau (`pthread_cond_wait`), avec le binding natif du moteur de requêtes Prisma présent dans au moins une des piles observées — piste plausible mais non confirmée avec certitude absolue (attribution de pile peu fiable sur binaire Rust optimisé sans symboles). `DATABASE_URL` de test ne définit aucun `connection_limit`/`pool_timeout` Prisma explicite.
- **Correction** : aucune appliquée. Cause identifiée comme infrastructurelle et hors périmètre du sprint en cours (Sprint 24-2, dont le brief demandait explicitement de ne pas modifier la configuration globale de test sans cause certaine et démontrée) — un correctif nécessiterait une décision architecturale (restart périodique du serveur de test, plusieurs serveurs en parallèle, `connection_limit`/`pool_timeout` explicites sur `DATABASE_URL` de test, etc.) à valider par le propriétaire du projet.
- **Test de non-régression** : sans objet (incident d'infrastructure de test, pas un bug de code applicatif) — non-régression du Sprint 24-2 confirmée à la place par exécution isolée des fichiers concernés (`vehicles.test.ts`/`data-reset.test.ts`, 100 % verts dans les 4 exécutions complètes et toutes les exécutions ciblées).
- **Statut** : ouvert (documenté, non corrigé — cause hors périmètre du sprint qui l'a mise en évidence)
- **Validation finale** : diagnostic jugé suffisamment rigoureux et concluant par investigation directe (reproduction isolée, 4 exécutions complètes, watchdog HTTP externe, profilage processus `ps`/`sample`) ; aucune validation de correctif car aucun correctif n'a été appliqué — décision de correction à prendre par le propriétaire du projet lors d'un futur sprint dédié à l'infrastructure de test.

## INC-2 — Hydration mismatch sur les icônes SVG du dashboard (extension navigateur Dark Reader)

- **Date** : 2026-08-14
- **Environnement** : développement/préproduction (signalé lors d'un test de reset du SaaS)
- **Gravité** : mineure (avertissement console uniquement, aucune donnée ni fonctionnalité affectée — même famille qu'INC précédent traité au Sprint 20, non numéroté à l'époque)
- **Description** : après le correctif Sprint 20 (hydration mismatch sur `<html>` dû à Dark Reader), un nouveau hydration mismatch de même origine est apparu, cette fois sur les icônes SVG (`lucide-react`) du chrome de tableau de bord (Sidebar/Header/BottomNav) — attributs `data-darkreader-inline-stroke` et `style={{ "--darkreader-inline-stroke": "currentColor" }}` injectés par l'extension avant l'hydratation React.
- **Impact** : avertissement console React pour tout visiteur utilisant Dark Reader (ou extension similaire modifiant le DOM avant hydratation) sur toute page `/dashboard/*` — aucune casse fonctionnelle observée (React tolère les mismatchs d'attributs sans démonter le sous-arbre concerné), mais bruit console gênant lors des tests réels et signal potentiellement trompeur lors d'un futur diagnostic.
- **Cause** : `lucide-react` (`node_modules/lucide-react/dist/esm/Icon.mjs`) positionne les attributs `stroke`/`fill` uniquement sur l'élément `<svg>` racine de chaque icône (jamais sur ses enfants `<path>`) — exactement la classe d'élément que l'overrider de style inline de Dark Reader cible. Le correctif Sprint 20 (`suppressHydrationWarning` sur `<html>`) ne couvre que cet élément précis, la prop n'étant pas récursive — les icônes du dashboard restaient donc exposées au même mécanisme.
- **Correction** : `suppressHydrationWarning` ajouté sur les icônes rendues sans condition dans le HTML du premier chargement de toute page `/dashboard/*` (`Sidebar.tsx`, `Header.tsx`, `BottomNav.tsx`) — voir HANDOFF.md Sprint 21 pour le détail complet, y compris le risque résiduel documenté (mais non corrigé, hors périmètre) sur les icônes des tableaux de contenu par page.
- **Test de non-régression** : aucun test automatisé dédié (bug de rendu DOM/hydratation sans surface HTTP testable en Vitest, même nature qu'INC Sprint 20/14E) — vérifié avec un navigateur réel (Chromium/Playwright), voir TESTREPORT.md section 1 « Vérification manuelle (Sprint 21) », y compris la limite documentée sur la fiabilité de la reproduction synthétique en environnement `next dev` local.
- **Statut** : corrigé (pour le chrome persistant du dashboard ; risque résiduel documenté mais non corrigé pour les icônes de contenu par page, voir HANDOFF.md Sprint 21)
- **Validation finale** : `npm run lint` / `npx tsc --noEmit` / `npm run test` (480/480) / `npm run build` verts + vérification navigateur réel, 2026-08-14.

## INC-1 — Agent de développement ayant exécuté `git stash` sans le restaurer avant expiration de son budget de session

- **Date** : 2026-08-14
- **Environnement** : développement (copie de travail locale, jamais poussé/déployé)
- **Gravité** : majeure (risque de perte de travail important), sans impact final (entièrement récupéré)
- **Description** : pendant le Sprint 15, plusieurs agents assistants travaillaient en parallèle sur la copie de travail locale (non isolée par worktree Git). L'un d'eux, chargé d'ajouter des tests d'audit/bout-en-bout, a exécuté `git stash` (visiblement pour isoler temporairement l'état de certains fichiers avant restauration), puis a atteint la limite d'usage de sa session avant d'exécuter `git stash pop` — laissant la copie de travail dans l'état d'avant le stash (fichiers `src/lib/*.ts`, toutes les routes `src/app/api/**` retrofitées ce sprint, tous les composants `src/app/dashboard/**` modifiés, `src/components/layout/Sidebar.tsx`) alors que le stash contenait la totalité de ce travail non commité.
- **Impact** : aucune perte de données réelle — détecté avant tout commit/push. Repéré indirectement via des échecs de tests inattendus et incohérents (routes se comportant comme avant le sprint, ex. `generateContractNumber` encore basé sur `Tenant` au lieu d'`Agency`) plutôt que par un message d'erreur explicite.
- **Cause** : agent avec accès complet à `git` opérant sur la copie de travail partagée (pas de `git worktree`/isolation entre agents concurrents) ; `git stash` (réversible) a heureusement été utilisé plutôt qu'une commande destructive (`git checkout -- .`, `git reset --hard`) qui aurait rendu la récupération impossible sans les journaux de conversation.
- **Correction** : diagnostic via `git status`/`git stash list`/`git diff <fichier>` (confirmation que le stash contenait la version correcte) ; restauration sélective fichier par fichier depuis `git checkout stash@{0} -- <chemin>` pour chaque fichier hors `src/__tests__/` (les fichiers de test, réécrits/étendus après le stash par d'autres agents, étaient déjà plus complets dans la copie de travail que dans le stash — restaurer le stash en bloc les aurait fait régresser) ; vérification complète (`npx tsc --noEmit`, `npm run lint`, `npm run build`, suite de tests complète) avant de supprimer le stash (`git stash drop`).
- **Test de non-régression** : aucun test automatisé dédié (incident de processus, pas de bug applicatif) — la suite complète (416/416) a servi de filet de sécurité pour confirmer la restauration complète et correcte.
- **Statut** : corrigé
- **Validation finale** : vérifié par relecture complète des fichiers restaurés + suite de tests 416/416 verte, 2026-08-14.
- **Enseignement pour les sprints futurs** : lorsque plusieurs agents travaillent en parallèle sur la même copie de travail, éviter de leur laisser une autonomie complète sur des commandes `git` d'état global (`stash`, `reset`, `checkout` sans chemin explicite) ; préférer l'isolation par `git worktree` par agent, ou limiter les agents parallèles à des fichiers strictement disjoints sans accès `git` d'état partagé.
