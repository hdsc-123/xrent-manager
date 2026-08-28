# ARCHITECTURE.md — Architecture du projet

Ce document décrit l'architecture **prévue** de XRent Manager, sans code. Il distingue ce qui existe aujourd'hui (socle Next.js par défaut) de ce qui est envisagé pour les sprints futurs. De nombreux points restent **À DÉCIDER** : ce document ne doit pas être lu comme un ensemble de décisions figées.

## 1. Architecture générale

XRent Manager est envisagé comme une application web **full-stack Next.js** (App Router), servant à la fois l'interface utilisateur et la logique serveur, sans backend séparé dans un premier temps. Ce choix découle du socle déjà en place (Next.js 16.3.0, TypeScript, App Router) ; il n'exclut pas une évolution future vers des services séparés si le besoin apparaît, mais aucune telle évolution n'est planifiée à ce stade.

Le produit cible est un SaaS **multi-tenant** et **multi-agence**, **mobile-first**, avec un **dashboard-admin** dès le MVP.

## 2. Frontend

- Interface construite avec l'App Router de Next.js, React 19 et Tailwind CSS v4 (déjà en place).
- Approche mobile-first : les interfaces devront être conçues et testées d'abord pour de petits écrans, l'agrandissement vers desktop étant secondaire.
- Le détail des bibliothèques de composants UI (design system, composants de formulaire, etc.) est **À DÉCIDER**.

## 3. Backend

- La logique serveur sera portée par Next.js lui-même (Server Components, Server Actions et/ou routes API), sans service backend distinct à ce stade.
- Aucun serveur applicatif séparé n'est prévu pour le MVP ; ce choix pourra être révisé si des contraintes de charge ou d'isolation l'exigent (À DÉCIDER le cas échéant).

## 4. App Router

Le projet utilise l'App Router de Next.js (dossier `src/app`), déjà en place pour la page par défaut. Toute organisation future des routes (groupes de routes, routes imbriquées pour le dashboard-admin, séparation par tenant/agence dans l'URL ou non) est **À DÉCIDER**.

## 5. Server Components et Client Components

- Principe directeur : privilégier les Server Components par défaut, et ne recourir aux Client Components que lorsque l'interactivité côté navigateur l'exige (formulaires, état local, etc.).
- Aucune donnée sensible ou secret ne doit transiter vers un Client Component.
- Le détail de cette répartition n'est pas encore appliqué puisqu'aucune page métier n'existe.

## 6. Actions ou routes serveur

- Toute action sensible (créer, modifier, supprimer, changer un état, initier un paiement) devra être exécutée via une action ou route serveur, avec revalidation systématique de l'identité de l'utilisateur, de son rôle, et de son appartenance au tenant/agence concernés.
- Aucune règle de validation ne doit reposer uniquement sur l'interface.
- Le choix entre Server Actions et routes API dédiées (Route Handlers) sera fait au cas par cas selon le besoin (formulaire vs API externe) — **À DÉCIDER** au moment de l'implémentation de chaque module.

## 7. Future couche d'accès aux données

- Une couche dédiée d'accès aux données est prévue pour centraliser toutes les requêtes vers la base de données et y appliquer systématiquement les filtres d'isolation tenant/agence. Cette couche constitue la garde tenant/agence obligatoire : aucune requête vers la base ne doit la contourner.
- **Décision validée (Sprint 1)** : PostgreSQL est retenu comme base de données cible et Prisma comme ORM cible. **Aucun des deux n'est installé à ce jour** — cette décision porte sur le choix technique, pas sur son implémentation.
- Le nom et l'emplacement exacts des dossiers accueillant cette couche (`server/`, `data/`, `db/`, etc.) restent **À DÉCIDER**.

## 8. Multi-tenant

- Chaque tenant représente une organisation cliente isolée : aucune donnée d'un tenant ne doit être visible ou modifiable par un autre tenant, à aucun niveau (interface, serveur, base de données).
- **Décision validée (Sprint 1)** : l'isolation technique repose sur une colonne `tenant_id` partagée entre tenants dans les mêmes tables (pas de schémas ni de bases séparées). Cette isolation est logique, pas physique — voir [SECURITY.md](./SECURITY.md) section 1 pour le détail du risque associé et les mesures compensatoires attendues.
- La vérification d'appartenance au tenant devra être appliquée côté serveur, de façon systématique et non contournable, via la couche d'accès aux données centralisée (section 7).

## 9. Multi-agence

- Un tenant peut opérer plusieurs agences. Une agence est un sous-périmètre à l'intérieur d'un tenant (ex. plusieurs points de location d'une même société).
- **Décision validée (Sprint 1)** : le rattachement technique aux agences se fait par un `agency_id`, soumis aux mêmes exigences de vérification côté serveur que le `tenant_id` (section 8).
- Le modèle précis de droits par agence (un utilisateur peut-il appartenir à plusieurs agences d'un même tenant, un véhicule peut-il être rattaché à plusieurs agences, etc.) reste **À DÉCIDER** — voir [DOMAINRULES.md](./DOMAINRULES.md).

## 10. Authentification

- Aucune authentification n'est implémentée à ce jour.
- Le choix de la solution (implémentation maison vs service tiers) est **À DÉCIDER**.
- Quel que soit le choix, les mots de passe (le cas échéant) ne devront jamais être stockés en clair (voir [SECURITY.md](./SECURITY.md)).

## 11. Autorisation

- Le modèle de rôles (ex. administrateur tenant, gestionnaire d'agence, agent, etc.) et les permissions détaillées associées restent **À DÉCIDER** — voir [DOMAINRULES.md](./DOMAINRULES.md).
- **Décision validée (Sprint 1)** : l'autorisation devra systématiquement être vérifiée côté serveur, pour chaque action sensible, en contrôlant l'identité de l'utilisateur, son rôle, son tenant, son agence, et l'appartenance de la ressource ciblée — indépendamment de ce que l'interface autorise ou masque.

## 12. Audit

- Toute action sensible (création, modification, suppression, changement d'état, export, import, reset) devra être tracée : qui, quoi, quand, sur quelle ressource, dans quel tenant/agence.
- **Décision validée (Sprint 1)** : le mécanisme technique retenu est une table d'audit dédiée. La durée de conservation et les droits d'accès aux journaux d'audit restent **À DÉCIDER** — voir [DOMAINRULES.md](./DOMAINRULES.md) section 16.

## 13. Exports et imports

- Le produit devra permettre l'export et l'import de données métier.
- **Décision validée (Sprint 1)** : tout export et tout import devra être validé côté serveur et scopé par tenant, sans exception.
- Le format, le périmètre précis (par tenant, par agence), les contrôles de validation détaillés à l'import, et la traçabilité associée restent **À DÉCIDER**.
- Tout export/import devra respecter la séparation tenant/agence et être soumis aux mêmes règles d'autorisation que les données concernées.

## 14. Environnements : développement, test, staging et production

- **Décision validée (Sprint 1)** : les environnements développement, test, staging et production devront être strictement séparés.
- **Développement** : environnement actuel, exécuté localement via `npm run dev` (base `xrent_dev`).
- **Test** : base dédiée `xrent_test`, distincte de `xrent_dev` (voir [TESTREPORT.md](./TESTREPORT.md)).
- **Staging** : non défini à ce jour. Hébergeur et configuration restent **À DÉCIDER**.
- **Production** : **cadrage validé par le propriétaire du projet (2026-08-24), aucun environnement encore réellement créé.** Hébergeur cible, base de données, secrets et sauvegardes de production doivent être **strictement séparés** de `xrent_dev`/`xrent_test` — aucune variable ni base de développement/test ne doit être réutilisée en production. Détail du cadrage : sections 16 à 21 ci-dessous.

Aucun de ces environnements (hormis le développement local) n'est actuellement configuré ou déployé — le cadrage ci-dessous fixe des décisions à appliquer lors du déploiement, pas un état déjà en place.

## 15. Migrations de production

- Prisma est déjà installé et utilisé en développement/test (section 7).
- **Décision validée (cadrage 2026-08-24)** : les migrations de production doivent utiliser exclusivement `npx prisma migrate deploy`, exécuté de façon contrôlée et non interactive, en étape de déploiement séparée (jamais dans un build concurrent non maîtrisé).
- **Interdit en production, sans exception** : `npx prisma migrate dev`, `npx prisma db push`, `npx prisma db seed`.
- Cette procédure est **documentée ici comme exigence à respecter lors du déploiement** ; elle n'a pas été exécutée dans le cadre de ce cadrage documentaire, conformément à la contrainte de ne lancer aucune migration.

## 16. Hébergement de production — options validées, choix final non arrêté

**Statut : options validées, choix final non arrêté** (décision de périmètre validée par le propriétaire du projet, 2026-08-24) : l'hébergeur cible est **Render ou Railway** — catégorie PaaS à conteneur long-running. **Aucun des deux n'est retenu de façon définitive** : le choix final doit être départagé par une comparaison documentée portant sur le prix réel, la région disponible, la latence depuis le Maroc, la qualité du PostgreSQL managé, les sauvegardes proposées, la facilité de restauration, la gestion du CRON, les limites de l'offre retenue, et la compatibilité avec le budget maximal (section 19). Cette comparaison reste à réaliser et à documenter avant toute création d'environnement.

- **Vercel** : écarté pour le moment (architecture serverless incompatible en l'état avec le verrou en mémoire du reset de données — section 21 — et nécessiterait un store externe pour le rate limiting dès le premier jour). Peut être reconsidéré sur décision explicite ultérieure du propriétaire du projet, pas par défaut.
- **VPS administré manuellement** : écarté pour le lancement (charge opérationnelle disproportionnée à ce stade : patching OS, TLS, supervision, sauvegardes toutes à la charge de l'équipe).
- **Application** : processus Next.js long-running (`next start`), **une seule instance au lancement**, sans scaling horizontal prévu au démarrage. L'architecture doit rester compatible avec plusieurs instances futures — voir section 21 pour les mécanismes qui devront être adaptés avant ce passage.

## 17. Région d'hébergement et localisation des données

**Priorité au Maroc** si une offre fiable, performante et correctement sauvegardée y est disponible chez l'hébergeur retenu (section 16). À défaut, une région de l'Union européenne suffisamment proche du Maroc. Le choix final doit prendre en compte la latence depuis le Maroc, la localisation réelle des données, la fiabilité de la région, la disponibilité de sauvegardes et de restauration dans cette région, le coût, et les obligations légales applicables (dépend de la juridiction cible — voir [DOMAINRULES.md](./DOMAINRULES.md), point encore ouvert au niveau juridique/comptable).

## 18. Base de données de production

- PostgreSQL **managé**, jamais installé manuellement sur le même serveur que l'application.
- Séparation stricte development/test/production : trois bases distinctes, trois jeux de secrets distincts (section 20).
- Procédure de migration : voir section 15.

## 19. Tâches planifiées (CRON) en production

- Utiliser le planificateur CRON natif de la plateforme retenue (section 16), aucune configuration réelle créée à ce stade.
- Route déjà implémentée et vérifiée dans le code : `POST /api/tasks/scheduled-alerts` (`src/app/api/tasks/scheduled-alerts/route.ts`), authentification par secret partagé `Authorization: Bearer <CRON_SECRET>` (comparaison à temps constant, échec fermé si le secret n'est pas configuré côté serveur).
- Idempotence et protection contre les doubles exécutions déjà garanties côté code par un verrou atomique PostgreSQL (`Tenant.lastAlertCheckAt`, `src/lib/scheduled-tasks.ts`) — pas un mécanisme à construire, déjà en place et testé.
- À prévoir lors du déploiement (non fait à ce stade) : visibilité des échecs dans les logs de la plateforme et, si possible, une alerte dédiée en cas d'échec récurrent de cette route.
- `CRON_SECRET` de production : propre à l'environnement de production, jamais réutilisé depuis `.env`/`.env.test` — voir section 20.

## 20. Secrets de production

Trois secrets identifiés dans le code : `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`. Règles validées (cadrage 2026-08-24) :

- valeurs de production distinctes de développement et de test, sans exception ;
- aucun secret dans Git (déjà garanti par `.gitignore` sur `.env*`) ;
- aucun secret dans les logs applicatifs (voir [SECURITY.md](./SECURITY.md) section 12) ;
- rotation documentée (voir [SECURITY.md](./SECURITY.md) pour la procédure) ;
- accès limité aux personnes autorisées ;
- store de secrets : celui natif de la plateforme d'hébergement retenue (section 16), suffisant à ce stade — un gestionnaire externe dédié reste une option à évaluer plus tard si des exigences de conformité l'imposent, non nécessaire pour démarrer.

## 21. Sauvegardes, restauration et instance unique — exigences à respecter lors du déploiement

**Aucune sauvegarde n'est configurée à ce jour — cette section documente des exigences à appliquer lors du déploiement, pas un état déjà en place.**

- Sauvegardes automatiques **quotidiennes**, stockées indépendamment du serveur applicatif (jamais uniquement dans le conteneur/la base colocalisée).
- Rétention des sauvegardes : **30 jours minimum**. Cette rétention concerne uniquement les copies de restauration techniques — elle est **indépendante** de la politique de conservation des données métier elles-mêmes (clients, contrats, factures, paiements, audits), qui suit sa propre règle : voir [DOMAINRULES.md](./DOMAINRULES.md), conservation ≥ un exercice comptable complet. Aucune donnée de production active n'est supprimée après 30 jours du seul fait de cette politique de sauvegarde.
- **Restauration testée obligatoirement avant le lancement public**, puis testée périodiquement ensuite (fréquence à fixer par le propriétaire du projet).
- RPO cible provisoire : **24 heures maximum**. RTO cible provisoire : **4 heures maximum**. Ces deux valeurs devront être confirmées selon les possibilités réelles de l'hébergeur finalement retenu (section 16) — elles ne sont pas encore garanties par un fournisseur précis.
- **Instance unique au lancement** : aucun scaling horizontal prévu au démarrage, mais l'architecture doit rester compatible avec plusieurs instances futures. **Mécanisme identifié dans le code comme reposant sur la mémoire du processus, à corriger avant toute activation multi-instance** : le verrou anti-double-exécution du reset de données (`tenantsResetting`, `src/lib/data-reset.ts`) — déjà documenté comme limite connue dans [SECURITY.md](./SECURITY.md) section 17. **Non corrigé dans le cadre de cette tâche documentaire** (signalé comme point technique à traiter, conformément au cadrage). À l'inverse, le throttle des tâches CRON d'alertes (section 19) utilise déjà un verrou atomique PostgreSQL et n'a pas besoin d'être revu pour un déploiement multi-instance.
- **Déploiement progressif retenu** : configuration de l'environnement → secrets → base PostgreSQL managée → activation des sauvegardes → test de restauration → déploiement de l'application → migrations contrôlées (`prisma migrate deploy`) → vérification d'un endpoint de santé (`/api/health`, **à créer, absent du code à ce jour**) → **pilote interne dans une seule agence** → correction des problèmes observés → extension progressive aux autres agences. Le déploiement public ou l'usage opérationnel généralisé ne doit pas commencer avant la validation du pilote interne.

## 22. Budget infrastructure

**Budget maximum validé : 60 € par mois**, pour l'ensemble infrastructure + services indispensables. Composition indicative : application PaaS long-running + PostgreSQL managé d'entrée de gamme + sauvegardes incluses ou peu coûteuses + monitoring simple. Explicitement exclus au départ, sauf besoin démontré : Redis, APM premium, architecture multi-instance, VPS administré manuellement. Toute dépense prévisible dépassant ce plafond doit être signalée et validée par le propriétaire du projet avant adoption d'un nouveau service.

## 23. Dimensionnement cible (voir aussi [DOMAINRULES.md](./DOMAINRULES.md))

Déploiement initial prévu pour environ 5 agences (une par ville), ~200 véhicules pour le tenant, ~16 à 18 utilisateurs, volumétrie 10-30 réservations/jour/agence (50-150 opérations/jour à 5 agences). L'architecture (instance unique, PostgreSQL managé, rate limiting Postgres) est jugée par le propriétaire du projet comme suffisante pour ce dimensionnement, avec évolution possible vers 10-15 agences sans refonte immédiate. Aucun mode offline requis (connexion stable + secours 4G/5G supposés disponibles pour chaque utilisateur/agence).

## 24. `proxy.ts` — rôle étendu : garde de route centralisé pour `/dashboard/*` (correctif soft 404, 2026-08-24)

**Décision technique validée et implémentée** — précise la section 6 ci-dessus (revalidation systématique côté serveur) pour un cas particulier propre au rendu streamé de l'App Router : `src/proxy.ts` (anciennement `middleware.ts`, renommé dans cette version de Next.js) conservait jusqu'ici un rôle strictement limité à une vérification "optimiste" de session (redirection vers `/login` si non authentifié, lecture du JWT côté cookie uniquement, aucun accès base de données). Il porte désormais, en plus, un **registre centralisé de gardes de route** (`src/lib/route-guards.ts`) qui revérifie, avant tout rendu de page, l'existence d'une ressource, l'appartenance au tenant, l'accès à l'agence et la permission requise — pour les seules pages `/dashboard/*` adressées par identifiant (`[id]`) ou par permission de création, dont la liste exhaustive vit dans ce registre.

**Raison technique** : sous cette version de Next.js, `notFound()`/`redirect()` invoqués depuis une page enveloppée par un `loading.tsx` ancêtre (`dashboard/loading.tsx` et les `loading.tsx` de chaque liste) ne peuvent plus changer le code HTTP une fois le flux de réponse démarré (statut `200` déjà émis) — voir SECURITY.md section 35 et DOMAINRULES.md section 64 pour l'analyse complète et la liste des routes couvertes. `proxy` s'exécutant avant toute frontière `Suspense`, c'est le seul point où un vrai code HTTP (`404`/redirection) peut encore être choisi.

**Garanties de conception, applicables à toute évolution future de ce mécanisme** :
- Runtime Node.js (par défaut dans cette version de `proxy`, vérifié) — Prisma et les mêmes fonctions déjà utilisées par chaque page/route API sont directement réutilisées, aucune règle métier n'est réécrite dans `proxy`.
- `proxy` n'est jamais la seule protection : chaque page et chaque route API conserve intégralement sa propre vérification (authentification, permission, tenant, agence) — défense en profondeur, pas un remplacement.
- Lecture seule, aucun état stocké, aucune écriture en base.
- Un filtre synchrone (`matchesDashboardRouteGuard`) évite tout accès base pour les pages `/dashboard/*` non couvertes par le registre — la charge supplémentaire reste strictement limitée aux routes réellement gardées.
- Les redirections de confort liées à un état métier (ex. réservation déjà convertie) ne sont volontairement pas dupliquées dans `proxy` — voir la distinction documentée en SECURITY.md section 35.

## 25. `locationAgencyScopeWhere` — règle de visibilité agence centralisée pour les listes/exports de locations (correctif BUG-004, 2026-08-26)

**Constat corrigé** : la règle « une location reste visible par son agence de rattachement (`agencyId`) OU son agence de retour (`dropoffAgencyId`) quand elle diffère » (Sprint 19, DOMAINRULES.md section 37, `canAccessLocationAgency`, `src/lib/authz.ts`) n'avait été appliquée qu'aux routes portant sur une seule location (détail, PATCH, retour). Chaque liste/export (`GET /api/locations`, `/dashboard/locations`, export CSV des contrats) avait reconstruit indépendamment un filtre plus étroit (`agencyId` seul) — trois implémentations divergentes de la même intention, dont l'une documentait explicitement cet écart comme une « fidélité délibérée » plutôt que comme un défaut.

**Correctif** : `locationAgencyScopeWhere(accessibleAgencyIds)` (`src/lib/locations.ts`) — fragment Prisma unique (`OR: [{agencyId}, {dropoffAgencyId}]`, ou `{}` pour un ADMIN sans restriction), désormais la seule implémentation de cette portée dans le code. Toute liste/export futur portant sur `Location` doit la réutiliser plutôt que reconstruire un filtre équivalent.

**Placement délibéré dans `src/lib/locations.ts`, pas `src/lib/authz.ts`** (malgré la parenté directe avec `canAccessLocationAgency`) : `authz.ts` importe `@/lib/auth` (NextAuth), donc transitivement `next-auth` — un module purement data-shape (`locationAgencyScopeWhere` ne dépend que de `string[] | null`, aucun accès session/DB) placé là forcerait tout module qui importe `@/lib/locations` à charger `next-auth`, y compris les tests unitaires qui importent `@/lib/locations` directement (hors serveur `next dev`), ce qui casse la résolution ESM de `next-auth/lib/env.js` en dehors du runtime Next.js. Même principe déjà appliqué à `InvalidFuelLevelError`/`validateFuelLevel` dans le même fichier (dupliqué plutôt qu'importé depuis un module voisin, pour éviter un cycle ou un couplage superflu).

## 26. `src/lib/vehicle-status.ts` — source de vérité unique du statut opérationnel d'un véhicule (sprint « statut opérationnel automatique », 2026-08-28)

Nouveau module central, appelé depuis `src/lib/locations.ts`/`location-return.ts`/`location-chains.ts`/`maintenances.ts`/`vehicle-transfers.ts`/`vehicle-trips.ts` — jamais l'inverse (pas de dépendance circulaire : `vehicle-status.ts` n'importe que `@/lib/prisma` et `@/lib/vehicles`, jamais les modules métier qui l'appellent). Deux exports : `getVehicleOperationalStatus` (calcul pur, lit `Location`/`VehicleTransfer`/`Maintenance`/`VehicleTrip`, ne modifie rien) et `syncVehicleStatus` (l'appelle puis réécrit `Vehicle.status`) — voir DOMAINRULES.md section 71 pour le modèle métier complet (priorité, transitions, état administratif de désactivation qui remplace l'ancien `VehicleStatus.INACTIVE`).

**Convention `tx` optionnel** (même principe que `checkAvailability`/`findConflictingMaintenances`, `src/lib/vehicles.ts`) : `getVehicleOperationalStatus(vehicleId, referenceDate?, tx?)` accepte un `Prisma.TransactionClient` — à passer systématiquement depuis un appelant qui a déjà verrouillé le véhicule (`lockVehicleForUpdate`) dans sa propre transaction, pour lire un état garanti à jour vis-à-vis de toute transaction concurrente visant le même véhicule. `syncVehicleStatus` exige toujours un `tx` (jamais appelée hors transaction) — l'écriture du cache `Vehicle.status` doit toujours faire partie de la même transaction que l'écriture métier qui la motive.
