# TESTREPORT.md — Suivi des tests

Ce document fait le point sur les tests réellement exécutés à ce jour et définit la stratégie de test future. Un framework de test (Vitest) est installé depuis le Sprint 2 et couvre l'isolation multi-tenant de la couche d'accès aux données ; ce document ne doit toutefois pas être lu comme la preuve d'une couverture de test métier, qui reste actuellement **nulle** (aucun module métier n'existe).

## 1. Tests déjà exécutés et résultats

| Date | Commande | Résultat | Détail |
|---|---|---|---|
| 2026-08-11 | `npm run lint` | ✅ Validé | Aucune erreur ESLint (config `eslint-config-next`) |
| 2026-08-11 | `npm run build` | ✅ Validé | Build de production Next.js 16.3.0 réussi (Turbopack), 2 routes statiques générées (`/`, `/_not-found`) |
| 2026-08-11 | `npm run test` (Vitest) | ✅ Validé | 5/5 tests passés — `src/__tests__/db.test.ts`, isolation multi-tenant de `getTenantById`/`getAgencyById`/`getUserById`, exécutés contre `xrent_dev` avec nettoyage systématique (`afterAll`) |
| 2026-08-11 | `npm run build` (après ajout de la couche d'accès aux données) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur, aucune régression sur les routes existantes |
| 2026-08-11 | `npm run test` (Vitest, après bascule sur base de test dédiée) | ✅ Validé | 5/5 tests passés — `vitest.config.mts` charge désormais `DATABASE_URL` depuis `.env.test` via `loadEnv` (Vite, mode `test`) ; tests exécutés contre `xrent_test` (base PostgreSQL distincte de `xrent_dev`, migration `init_tenant_agency_user` appliquée via `prisma migrate deploy`), aucune donnée résiduelle après nettoyage |
| 2026-08-11 | `npm run lint` (Sprint 3, après authentification + CRUD tenants/agences) | ✅ Validé | Aucune erreur ESLint |
| 2026-08-11 | `npm run build` (Sprint 3) | ✅ Validé | Build de production réussi, TypeScript strict sans erreur ; 10 routes API compilées (`/api/auth/*`, `/api/tenants*`, `/api/agencies*`) + Proxy (`src/proxy.ts`) enregistré |
| 2026-08-11 | `npm run test` (Vitest, Sprint 3) | ✅ Validé | 37/37 tests passés sur 4 fichiers (`db.test.ts`, `auth.test.ts`, `tenants.test.ts`, `agencies.test.ts`), voir section 3 « Tests d'intégration authentification et CRUD » |

**Aucun test métier n'est disponible à ce jour**, pour la raison simple qu'aucun module métier n'existe encore dans le code (voir [HANDOFF.md](./HANDOFF.md) et [PROJECT_MAP.md](./PROJECT_MAP.md)). En revanche, la couche d'accès aux données technique (`src/lib/db.ts`), l'authentification et le CRUD tenants/agences disposent désormais de tests d'isolation multi-tenant et multi-agence.

## 2. Tests disponibles et non encore disponibles

- Framework installé : **Vitest** (`npm run test`), choisi en Sprint 2 pour sa compatibilité native avec TypeScript/ESM et Next.js 16.
- Base de test dédiée : **`xrent_test`**, distincte de `xrent_dev`. `vitest.config.mts` charge `DATABASE_URL` depuis `.env.test` via `loadEnv` de Vite (mode `test`) ; la migration `init_tenant_agency_user` y est appliquée via `prisma migrate deploy`.
- Test disponible : isolation multi-tenant de la couche d'accès aux données (`src/__tests__/db.test.ts`), voir section 3 « Tests multi-tenant ».
- Non encore disponible : tests métier, de permission, de concurrence, de charge, de sécurité (OWASP WSTG) ou de régression — aucun module métier ni authentification n'existe encore pour les motiver.

## 3. Stratégie future de tests

Le framework de test unitaire/intégration est désormais **tranché : Vitest** (Sprint 2). L'outil e2e et l'outil de test de charge restent **À DÉCIDER**. Les principes suivants sont actés (dont certains confirmés lors de la validation du Sprint 1, voir [HANDOFF.md](./HANDOFF.md)) :

- **Décision validée (Sprint 1)** : chaque module métier devra être accompagné de tests dès sa création (voir [CLAUDE.md](./CLAUDE.md)), pas ajoutés a posteriori.
- **Décision validée (Sprint 1)** : priorité aux tests d'isolation multi-tenant, le modèle d'isolation par `tenant_id` partagé étant désormais retenu (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 8 et [SECURITY.md](./SECURITY.md) section 1).
- Les règles de sécurité critiques (isolation tenant/agence, autorisation, montants financiers) devront être couvertes par des tests avant toute mise en production.

### Tests unitaires
Cibleront la logique métier pure (calculs de montants, règles de transition d'état, validations). Aucun test unitaire n'existe à ce jour.

### Tests d'intégration
Cibleront les interactions entre la logique serveur et la future couche d'accès aux données (ex. une action serveur qui crée une réservation et vérifie les règles de disponibilité). Aucun test d'intégration n'existe à ce jour.

### Tests end-to-end
Cibleront les parcours utilisateurs complets (ex. création d'une réservation jusqu'à la signature d'un contrat), notamment en mobile-first. Aucun test end-to-end n'existe à ce jour.

### Tests métier
Vérifieront le respect des règles définies dans [DOMAINRULES.md](./DOMAINRULES.md) au fur et à mesure qu'elles seront tranchées et implémentées — en particulier les règles déjà validées de représentation des montants (section 14) et des dates (section 15), premières candidates pour des tests unitaires dès leur implémentation. Aucun test métier n'existe à ce jour.

### Tests de permissions
Vérifieront qu'un utilisateur ne peut jamais accéder à une action ou une ressource hors de son rôle. Aucun test de permission n'existe à ce jour.

### Tests multi-tenant
Priorité de test la plus élevée du projet (décision Sprint 1) : le modèle d'isolation retenu (`tenant_id` partagé, voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 8) rend l'omission d'un filtre tenant le risque de sécurité le plus critique (voir [SECURITY.md](./SECURITY.md) section 1). Ces tests vérifient explicitement qu'aucune donnée d'un tenant n'est accessible depuis un autre tenant, y compris par accès direct par identifiant (IDOR, voir [SECURITY.md](./SECURITY.md) section 7).

**Premier test multi-tenant en place (Sprint 2)** : `src/__tests__/db.test.ts` crée deux tenants de test, une agence et un utilisateur pour chacun, puis vérifie que `getAgencyById(tenantA, agencyIdDeB)` et `getUserById(tenantA, userIdDeB)` retournent systématiquement `null` — jamais la ressource de l'autre tenant. Les données créées sont supprimées en fin de suite (`afterAll`). Ce test s'exécute contre `xrent_test`, base de test dédiée distincte de `xrent_dev` (voir section 2).

Limites connues de ce premier test, à traiter dans une prochaine itération :
- Il couvre uniquement la couche d'accès aux données (`src/lib/db.ts`), pas encore une action ou route serveur réelle (aucune n'existe).
- Il ne couvre pas l'écriture (création/modification/suppression), uniquement la lecture — à étendre dès que des fonctions d'écriture existeront dans la couche d'accès aux données.

**Extension Sprint 3 — isolation au niveau des routes API** : `src/__tests__/tenants.test.ts` et `src/__tests__/agencies.test.ts` vérifient, à travers de vraies requêtes HTTP authentifiées, qu'un ADMIN d'un tenant ne peut ni lister, ni lire, ni modifier, ni supprimer les ressources (`Tenant`, `Agency`) d'un autre tenant (404, jamais de fuite d'existence — SECURITY.md section 7), et qu'au sein d'un même tenant, un MEMBER non rattaché à une agence via `UserAgency` ne peut pas non plus y accéder (SECURITY.md section 2). Ces écritures (création/modification/suppression) sont désormais couvertes, en plus de la lecture.

### Tests d'intégration authentification et CRUD (Sprint 3)

`src/__tests__/auth.test.ts`, `tenants.test.ts` et `agencies.test.ts` sont des tests d'intégration HTTP réels, pas des appels directs aux fonctions des route handlers : NextAuth (`auth()`) utilise en interne `next/headers`, une API qui lève une erreur (« headers was called outside a request scope ») si elle n'est pas invoquée dans le contexte d'une vraie requête servie par Next.js — vérifié empiriquement pendant ce sprint. `vitest.global-setup.ts` démarre donc un vrai serveur `next dev` (port dédié 3811, pointé sur `xrent_test` via `.env.test`) avant la suite de tests et l'arrête à la fin ; les tests utilisent `fetch` et gèrent eux-mêmes le cookie de session (`authjs.session-token`).

Couverture :
- **`auth.test.ts`** : inscription (tenant + admin), rejet d'un mot de passe trop court, rejet d'un slug de tenant dupliqué, `passwordHash` jamais présent dans une réponse API (vérifié aussi bien sur `/register` que `/login`) tout en confirmant via Prisma que le hash est bien stocké et distinct du mot de passe en clair, `/me` sans session → 401, `/login` avec mauvais mot de passe et avec compte inexistant → même code et même message d'erreur (SECURITY.md section 3), cycle complet login → me → logout avec vérification que `/logout` efface bien le cookie de session côté serveur (`Max-Age=0`).
- **`tenants.test.ts`** : CRUD complet avec vérification systématique de l'isolation multi-tenant (404 sur toute tentative d'accès au tenant d'un autre admin) et du contrôle de rôle (403 pour un MEMBER sur les routes réservées ADMIN), y compris le refus de suppression d'un tenant ayant des utilisateurs actifs (contrainte de clé étrangère, 409).
- **`agencies.test.ts`** : CRUD complet avec isolation multi-tenant (404 sur une agence d'un autre tenant) **et** multi-agence (404 pour un MEMBER non explicitement rattaché via `UserAgency`, 200 une fois rattaché), contrôle de rôle (403 pour un MEMBER sur la création/modification, même rattaché), et refus de suppression d'une agence ayant des utilisateurs rattachés (409).

Limite connue : ces tests valident le comportement HTTP réel (le plus proche des conditions de production), mais ajoutent une dépendance à un serveur `next dev` démarré pour la durée de la suite — plus lent qu'un test unitaire pur, et sensible à la disponibilité du port 3811 en local.

### Tests de concurrence
Vérifieront le comportement du système en cas d'accès concurrent à une même ressource (ex. deux réservations simultanées sur le même véhicule). Aucun test de concurrence n'existe à ce jour.

### Tests de charge
Vérifieront le comportement du système sous charge réaliste avant mise en production. Aucun test de charge n'existe à ce jour, et aucun environnement de staging n'est encore disponible pour les exécuter.

### Tests de sécurité
S'appuieront sur les principes de l'OWASP WSTG définis dans [SECURITY.md](./SECURITY.md) section 22. Aucun test de sécurité n'existe à ce jour.

### Tests de régression
Chaque correction de bug ou d'incident (voir [INCIDENTS.md](./INCIDENTS.md)) devra être accompagnée d'un test de non-régression avant clôture de l'incident. Aucun test de régression n'existe à ce jour, faute d'incident enregistré.

## 4. Format attendu des futurs rapports

Chaque exécution future de la suite de tests devra être consignée dans ce document (ou dans un rapport daté associé) selon le format suivant :

```
## Rapport du <date>

Environnement : <dev|test|staging|production>
Commande exécutée : <commande>

| Type de test | Nombre exécuté | Réussis | Échoués | Ignorés |
|---|---|---|---|---|
| Unitaires | | | | |
| Intégration | | | | |
| End-to-end | | | | |
| Sécurité | | | | |

Échecs notables : <description ou "aucun">
Actions de suivi : <description ou "aucune">
```

Ce format sera ajusté une fois les outils de test choisis (**À DÉCIDER**).
