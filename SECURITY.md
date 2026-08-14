# SECURITY.md — Sécurité

Ce document définit les règles de sécurité de XRent Manager. Il mélange des exigences à respecter (marquées **À DÉCIDER** quand le détail n'est pas encore tranché) et l'état réel de ce qui est **implémenté**, section par section — chaque section indique explicitement son statut ; ne pas déduire l'état d'une section à partir d'une autre.

## 1. Séparation stricte entre tenants

- Aucune donnée d'un tenant ne doit jamais être accessible, visible ou modifiable par un autre tenant, à quelque niveau que ce soit (interface, action serveur, base de données, logs, exports).
- Toute requête d'accès à une ressource doit vérifier que la ressource appartient bien au tenant de l'utilisateur authentifié, côté serveur, systématiquement — jamais en se fiant à un identifiant fourni par le client sans revérification.
- **Décision validée (Sprint 1)** : le modèle technique d'isolation retenu est une colonne `tenant_id` partagée entre tenants dans les mêmes tables (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 8).
- **Risque** : ce modèle offre une isolation logique, non physique. Le risque principal est l'omission d'un filtre `tenant_id` dans une requête, qui exposerait des données d'un tenant à un autre. Ce risque doit être traité par : (1) l'usage exclusif de la couche d'accès aux données centralisée avec garde tenant/agence obligatoire (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 7), qui doit rester le seul point d'accès à la base de données ; (2) des tests multi-tenant automatisés systématiques dès le premier module concerné (voir [TESTREPORT.md](./TESTREPORT.md)) ; (3), le cas échéant, l'ajout ultérieur de Row-Level Security PostgreSQL en renfort défensif — **À DÉCIDER**.

## 2. Séparation entre agences

- À l'intérieur d'un même tenant, un utilisateur ne doit accéder qu'aux agences auxquelles il est explicitement rattaché, sauf rôle transverse tenant explicitement autorisé (ex. administrateur tenant).
- Cette vérification doit également être effectuée côté serveur, indépendamment de ce que l'interface affiche ou masque.

## 3. Authentification

**Implémenté (Sprint 3)** : NextAuth.js (Auth.js) v5, avec un unique fournisseur `CredentialsProvider` (email/password, pas d'OAuth à ce stade — décision explicite du propriétaire du projet). Les mots de passe sont hashés avec `bcryptjs` (`src/app/api/auth/register/route.ts`), jamais stockés ni retournés en clair (voir section 10).

- `src/app/api/auth/login/route.ts` renvoie systématiquement le même message d'erreur (« Identifiants invalides. », HTTP 401) pour un mot de passe incorrect et pour un email inexistant — vérifié par test (`src/__tests__/auth.test.ts`), conformément à l'exigence de ne pas distinguer un compte existant d'un compte inexistant.
- **Non implémenté** : limitation du nombre de tentatives (protection brute force), mécanisme de récupération de compte (mot de passe oublié), MFA — tous **À DÉCIDER**, à traiter avant mise en production.
- **Résolu (Sprint 9, Option B)** : `User.email` reste unique par tenant seulement (`@@unique([tenantId, email])`, pas globalement), mais l'ambiguïté à la connexion est désormais gérée explicitement. `resolveLoginTenants(email, password)` (`src/lib/auth.ts`) vérifie le mot de passe contre **tous** les users partageant cet email, tous tenants confondus, **avant** de révéler quoi que ce soit — principe crucial pour ne pas fuiter l'appartenance multi-tenant d'un email sans preuve d'identité (cohérent avec le paragraphe ci-dessus). `POST /api/auth/login` : 0 correspondance → 401 générique (inchangé) ; exactement 1 → connexion directe (comportement historique, inchangé) ; plusieurs → `200 { requiresTenantSelection: true, tenants: [...] }` **sans poser de cookie de session**, le client (`LoginForm.tsx`) affiche alors une sélection explicite du tenant puis resoumet avec `tenantId`. `authorize()` (NextAuth) accepte ce `tenantId` optionnel pour un lookup non ambigu (`findUnique` sur `tenantId_email`).
- **Piège technique découvert pendant ce sprint** : `signIn()` de NextAuth appelé côté serveur sérialise ses options via `URLSearchParams`, qui coerce une valeur JavaScript `undefined` en la chaîne littérale `"undefined"` — passer `tenantId: undefined` directement cassait silencieusement le lookup tenant-scopé. Corrigé en n'incluant la clé `tenantId` dans les options que lorsqu'elle est réellement définie.

## 4. Autorisation côté serveur

- Toute action sensible doit être validée côté serveur, indépendamment des contrôles côté client (masquage de bouton, désactivation de champ, etc.), qui ne sont que des aides d'expérience utilisateur et non des mesures de sécurité.
- **Décision validée (Sprint 1)** : chaque action serveur doit vérifier l'identité de l'utilisateur, son rôle, son tenant, son agence, et l'appartenance de la ressource ciblée à ce même tenant/agence. Cette vérification doit s'appuyer sur la couche d'accès aux données centralisée avec garde tenant/agence obligatoire (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 7).
- **Implémenté (Sprint 12C, portée étendue Sprint 15)** : système de permissions granulaires (`can(user, key)`, `src/lib/permissions.ts`) en **complément** de l'autorisation par rôle/agence ci-dessus, pas en remplacement. Vérifié côté serveur, additivement à `canAccessAgency()`/aux vérifications de rôle déjà en place, sur (quasiment) tous les modules métier : agences (y compris écriture, depuis Sprint 15), véhicules, clients, locations, réservations, factures, paiements, rapports, maintenances, alertes, caisse, transferts de véhicules, bons de déplacement — jamais uniquement côté UI (le filtrage de la sidebar, `Sidebar.tsx`, n'est qu'une aide d'affichage, sans valeur de sécurité à lui seul ; une route appelée directement sans passer par l'UI reste soumise à la même vérification `can()`). Un `ADMIN` (`role === "ADMIN"`) a toujours accès à tout, sans jamais consulter les tables `PermissionGroup`/`GroupPermission`/`UserPermission` — même principe de bypass déjà en vigueur pour `canAccessAgency()`. **Restent volontairement en contrôle de rôle strict (`role !== "ADMIN"`), non convertis en `can()`** : utilisateurs, invitations, groupes de permissions eux-mêmes, tenants, reset de données, audit — DOMAINRULES.md section 4 réserve explicitement la gestion des utilisateurs à `ADMIN`, même sur son propre compte ; les clés `users.*`/`invitations.*`/`audit.view` du catalogue restent donc décoratives, par choix délibéré (voir DOMAINRULES.md section 22).
- **Décision explicite (Sprint 15)** : un `MEMBER` n'ayant jamais été explicitement rattaché à un `PermissionGroup` (aucun code de l'application ne le fait automatiquement à la création d'un compte — voir DOMAINRULES.md section 22) retombe implicitement sur les permissions du groupe par défaut « MEMBER », plutôt que sur un ensemble vide. Avant l'extension de portée ci-dessus, l'absence de permission n'avait aucun effet réel (seuls le rôle et l'agence comptaient) ; sans ce repli, un `MEMBER` fraîchement créé se retrouverait bloqué sur la quasi-totalité de l'application dès son premier accès — régression réelle et non un simple resserrement de sécurité, détectée et corrigée en cours de sprint (voir INCIDENTS.md pour l'incident de processus associé à ce sprint, sans rapport direct avec cette décision). Seule l'absence totale de groupe déclenche ce repli : un `PermissionGroup` personnalisé explicitement assigné, même vide, continue de restreindre réellement l'accès.

## 5. Gestion des sessions

**Implémenté (Sprint 3)** : sessions **JWT** (cookie chiffré, signé avec `AUTH_SECRET`), pas de sessions "database". Ce choix n'est pas arbitraire : NextAuth v5 lève une erreur au runtime (`UnsupportedStrategy`, vérifié dans `node_modules/@auth/core/lib/utils/assert.js`) si `CredentialsProvider` est combiné avec `session.strategy: "database"` — les deux décisions initiales du Sprint 3 (sessions database + login email/password) étaient techniquement incompatibles ; la stratégie JWT a été retenue après validation explicite du propriétaire du projet.

- Cookie posé par NextAuth (`authjs.session-token`, `HttpOnly`, `SameSite=lax`, `Secure` en HTTPS) — configuration par défaut de la librairie, non personnalisée.
- Déconnexion (`POST /api/auth/logout`) : efface le cookie côté serveur (`Max-Age=0`), vérifié par test. **Limite connue des sessions JWT (stateless)** : un jeton déjà émis reste cryptographiquement valide jusqu'à son expiration même après "déconnexion" ou changement de mot de passe, puisqu'il n'existe pas de table de sessions consultée à chaque requête pour le révoquer — seule la suppression du cookie côté client est garantie. Une éventuelle révocation serveur (ex. liste de blocage, passage à des sessions database avec un flux de connexion custom) reste **À DÉCIDER** si ce risque devient inacceptable.
- Les modèles `Account`/`Session`/`VerificationToken` de l'adaptateur Prisma (`@auth/prisma-adapter`) sont présents dans le schéma pour permettre l'ajout futur de fournisseurs OAuth sans nouvelle migration, mais la table `Session` n'est pas utilisée pour les connexions par mot de passe actuelles.
- **Implémenté (Sprint 9)** : `session.maxAge` configuré explicitement à 30 jours (au lieu de reposer sur la valeur par défaut implicite de NextAuth). Case « Se souvenir de moi » sur `/login` : décochée, le callback `jwt()` fixe l'expiration réelle du JWT (`token.exp`) à 1 jour au lieu de 30 — ajuste l'expiration effectivement vérifiée par NextAuth à chaque requête, pas seulement l'attribut `Max-Age` du cookie côté navigateur.
- ~~**Limite documentée (Sprint 10)** : un changement de nom/email/mot de passe via `PATCH /api/users/me` ne rafraîchit pas le JWT existant.~~ **Résolu (Sprint 11)** : `SessionProvider` + `useSession().update()` (`next-auth/react`) côté client déclenchent `trigger: "update"` dans le callback `jwt()` (`src/lib/auth.ts`), qui relit `name`/`email` en base par `token.id` — jamais depuis le payload client de l'`update()`, pour ne faire confiance qu'à ce que `PATCH /api/users/me` a déjà validé et persisté côté serveur (aucun risque d'élévation de privilège : `tenantId`/`role` ne sont jamais touchés par ce mécanisme). Les autorisations serveur n'étaient de toute façon pas affectées par la limite précédente (`tenantId`/`role`, seuls champs réellement utilisés pour les décisions d'accès, restaient inchangés) — c'était une limite d'affichage (UX), pas une faille de sécurité. Voir HANDOFF.md point 35.

## 6. Validation des entrées

- Toute entrée utilisateur (formulaire, paramètre d'URL, corps de requête API) doit être validée côté serveur avant tout traitement ou écriture en base, indépendamment d'une validation côté client.
- La validation côté client est une aide d'expérience utilisateur, jamais une garantie de sécurité.
- Le choix d'une bibliothèque de validation (ex. schémas de validation TypeScript) est **À DÉCIDER**.

## 7. Protection contre les accès directs non autorisés

- Aucune ressource (réservation, contrat, client, véhicule, document) ne doit être accessible par simple connaissance ou devinette de son identifiant (protection contre les failles de type IDOR — Insecure Direct Object Reference).
- Chaque accès direct à une ressource par identifiant doit revérifier l'appartenance au tenant/agence et les droits de l'utilisateur.

## 8. Secrets et variables d'environnement

- Les secrets (clés API, identifiants de base de données, clés de chiffrement) ne doivent jamais être codés en dur dans le code source ni dans la documentation.
- Les fichiers `.env*` sont déjà exclus du suivi git via `.gitignore` ; c'est le seul emplacement local prévu pour les secrets, en complément d'un gestionnaire de secrets externe le cas échéant (À DÉCIDER pour la production).
- Voir également [PROJECT_MAP.md](./PROJECT_MAP.md) section 6 pour la liste des fichiers ne devant jamais contenir de secrets.

## 9. Cartes bancaires

- **Aucune donnée de carte bancaire (numéro, date d'expiration, cryptogramme) ne doit jamais être stockée en clair**, ni en base de données, ni dans les logs, ni dans un export, en aucune circonstance.
- La seule approche envisagée est la tokenisation via un prestataire de paiement tiers conforme PCI-DSS, qui héberge lui-même les données de carte ; XRent Manager ne devra manipuler que des tokens ou références opaques fournies par ce prestataire.
- Choix du prestataire : **À DÉCIDER** (voir [DOMAINRULES.md](./DOMAINRULES.md)).

## 10. Mots de passe

- Aucun mot de passe ne doit jamais être stocké en clair ni dans un format réversible.
- **Implémenté (Sprint 3)** : hachage avec `bcryptjs` (facteur de coût 12), champ `User.passwordHash` (nullable — un `User` créé sans mot de passe, par exemple via un futur fournisseur OAuth, n'en a pas).
- **Implémenté (Sprint 9)** : politique de complexité (`src/lib/password-policy.ts`, `validatePassword`) — 8 caractères minimum, au moins une majuscule, un chiffre, un caractère spécial. Appliquée à `POST /api/auth/register`, à l'acceptation d'une invitation (`POST /api/invitations/[id]/accept`) et à la réinitialisation de mot de passe par un ADMIN (`PATCH /api/users/[id]`) — et, depuis le Sprint 10, à l'auto-édition du mot de passe (`PATCH /api/users/me`). Expiration et historique de mots de passe restent **À DÉCIDER**.
- **Implémenté (Sprint 10)** : `PATCH /api/users/me` exige la vérification du mot de passe **actuel** (`currentPassword`, comparé via `bcrypt.compare`) avant tout changement de mot de passe par l'utilisateur lui-même — distinct de la réinitialisation *par un ADMIN sur un autre user* (Sprint 9), qui reste une action administrative sans cette vérification. Aucune invalidation des sessions JWT déjà émises sur d'autres appareils n'est déclenchée par ce changement (limite connue, cohérente avec la section 5 ci-dessous) — **À DÉCIDER** si jugé nécessaire.
- `passwordHash` n'est jamais inclus dans une réponse API (vérifié par test sur `/register`, `/login`, `/me`) ni dans le payload de session NextAuth (le callback `session` ne recopie que `id`, `tenantId`, `role`).

## 11. Données personnelles

- Les données personnelles des clients (identité, coordonnées, documents de permis de conduire) sont des données sensibles à protéger.
- Principes à respecter (détail À DÉCIDER) : minimisation de la collecte, chiffrement au repos des données les plus sensibles si applicable, droit d'accès/rectification/suppression selon la réglementation applicable (ex. RGPD si des utilisateurs européens sont concernés — juridiction(s) cible(s) **À DÉCIDER**).

## 12. Logs

- Les logs applicatifs ne doivent jamais contenir : mots de passe, tokens de session, données de carte bancaire, secrets, ni de données personnelles sensibles non nécessaires au diagnostic.
- Stratégie de rétention et d'accès aux logs : **À DÉCIDER**.

## 13. Audit

- Toute action sensible doit être tracée de façon non falsifiable (ou au minimum difficilement falsifiable) : qui, quoi, quand, sur quelle ressource, dans quel tenant/agence.
- **Décision validée (Sprint 1)** : le mécanisme technique retenu est une table d'audit dédiée. Durée de conservation et droits d'accès fins au-delà de « réservé ADMIN » restent **À DÉCIDER**.
- **Implémenté (Sprint 9, étendu Sprint 10, Sprint 15)** : modèle `AuditLog`, `src/lib/audit.ts`, `GET /api/audit` + `/dashboard/audit` (réservés ADMIN, tenant-scopé, filtrable par ressource/action/utilisateur depuis Sprint 10). Câblé sur le changement de rôle utilisateur, la suppression d'utilisateur, le cycle de vie des invitations (Sprint 9), l'édition de profil (Sprint 10), et désormais **tout** le CRUD métier (véhicules, locations, clients, factures, paiements, maintenances, acquittement/résolution d'alertes — Sprint 10 ; réservations, caisse, transferts/bons de déplacement — Sprint 12C/13A/14C ; agences (création/modification/suppression, y compris un rewind manuel de numérotation tracé avec les anciennes valeurs), tenant (modification), création d'un utilisateur via acceptation d'invitation — Sprint 15). `logAction` n'échoue jamais l'action métier appelante (erreur d'écriture capturée et journalisée en console). L'audit lui-même n'est accessible en écriture à aucun utilisateur standard (aucune route `PATCH`/`DELETE` sur `AuditLog`) ; la seule suppression possible reste la purge totale via le reset de données (`POST /api/data-reset`, option `includeAuditLog`), déjà strictement réservée ADMIN et tenant-scopée (section 17). Durée de conservation et purge automatique périodique restent **À DÉCIDER**.
- Voir [DOMAINRULES.md](./DOMAINRULES.md) section 16 et [ARCHITECTURE.md](./ARCHITECTURE.md) section 12.

## 14. Exports

- **Décision validée (Sprint 1)** : tout export doit être validé côté serveur et scopé par tenant, sans exception.
- Un export ne doit jamais contenir de données d'un autre tenant que celui de l'utilisateur qui le demande.
- Un export ne doit jamais contenir de données de carte bancaire en clair, ni de mots de passe/hashs de mots de passe.
- Tout export doit être soumis aux mêmes règles d'autorisation que les données sous-jacentes, et doit être audité (voir section 13). Format et périmètre précis restent **À DÉCIDER**.
- **Implémenté (Sprint 12C)** : export CSV du journal d'audit (`/dashboard/audit`, réservé ADMIN comme la page elle-même) — génération côté client (`papaparse`, déjà utilisé pour l'export des rapports depuis le Sprint 6) à partir des lignes déjà chargées côté serveur pour l'utilisateur courant (tenant-scopées) ; aucune requête réseau supplémentaire ne fuit de données non déjà autorisées.

## 15. Imports

- **Décision validée (Sprint 1)** : tout import doit être validé côté serveur et scopé par tenant, sans exception.
- Toute donnée importée doit être validée côté serveur avant écriture (structure, types, cohérence métier), au même niveau d'exigence qu'une saisie manuelle.
- Un import ne doit jamais permettre de contourner l'isolation tenant/agence (ex. en injectant un `tenant_id` arbitraire dans un fichier importé). Contrôles de validation détaillés : **À DÉCIDER**.
- **Implémenté (Sprint 12C)** : import Excel des réservations (`POST /api/reservations/import`) — `tenantId` toujours dérivé de la session serveur, jamais du fichier ; chaque ligne validée indépendamment côté serveur (`parseReservationImportRow`, `src/lib/reservations.ts`) avant toute écriture ; réservé par permission (`reservations.import`, voir section 4) ; extension `.xlsx` vérifiée avant traitement, fichier illisible/corrompu refusé (400) sans détail d'erreur interne exposé au client.
- **Choix de dépendance motivé par la sécurité** : la librairie `xlsx` (SheetJS), pourtant explicitement suggérée par l'énoncé du sprint, a une vulnérabilité haute sévérité sans correctif disponible sur le registre npm au moment de ce sprint (prototype pollution `GHSA-4r6h-8v6p-xvw6` + ReDoS `GHSA-5pgg-2g8v-p4x9`, confirmé par `npm audit`) — pertinent ici puisque cette librairie traite directement un fichier fourni par l'utilisateur. `exceljs` a été retenu à la place (aucune vulnérabilité haute/critique au moment du sprint).

## 16. Sauvegardes

- Stratégie de sauvegarde (fréquence, rétention, chiffrement, lieu de stockage) : **À DÉCIDER**, à définir avant la mise en production.
- Toute sauvegarde contenant des données sensibles (personnelles ou financières) doit être protégée au moins au même niveau que la base de données de production.

## 17. Reset sécurisé

- **Décision validée (Sprint 1)** : tout reset de données doit être **techniquement impossible en environnement de production** — la vérification du contexte d'environnement doit être effectuée côté serveur, de façon non contournable depuis le client.
- Un reset de données (hors production) ne doit jamais être possible sans confirmation explicite et validation côté serveur du rôle de l'utilisateur qui le déclenche.
- **Tranché et implémenté (Sprint 14D)** : `POST`/`GET /api/data-reset` (`src/lib/data-reset.ts`, fonction `assertNotProduction()`) vérifie `process.env.NODE_ENV === "production"` côté serveur avant toute lecture/suppression — même convention que `src/lib/prisma.ts` (seul `next build && next start` positionne `NODE_ENV` à `"production"` ; `next dev`, utilisé en développement comme par le serveur de test Vitest, le laisse à `"development"`). Non contournable depuis le client : aucun paramètre de la requête n'influence ce contrôle. Rôle autorisé hors production : `ADMIN` uniquement, strictement scopé à son propre tenant (`user.tenantId`, jamais un `tenantId` arbitraire fourni en entrée) — pas de rôle superadmin transverse (voir section 1, HANDOFF.md point 16). Confirmation explicite exigée : l'ADMIN doit saisir le nom exact du tenant dans la boîte de dialogue (`DataResetCard.tsx`) avant que le bouton de confirmation ne s'active ; validée à nouveau côté serveur (`InvalidResetConfirmationError` si le nom ne correspond pas). Action journalisée (`AuditLog`, action `"data.reset"`) après exécution, y compris quand l'option « réinitialisation complète » vide le journal d'audit lui-même. Voir DOMAINRULES.md section 31 (nouvelle) pour le périmètre exact des données vidées/conservées.

## 18. Erreurs

- Les messages d'erreur exposés à l'utilisateur ne doivent jamais révéler de détails techniques internes (stack trace, requête SQL, chemin de fichier serveur) susceptibles d'aider un attaquant.
- Les détails techniques complets peuvent être journalisés côté serveur (en respectant les règles de la section 12), mais ne doivent pas être renvoyés au client.

## 19. Headers de sécurité

- Aucun header de sécurité personnalisé n'est configuré à ce jour (`next.config.ts` est à sa configuration par défaut).
- Lors de l'implémentation, des headers tels que `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` devront être envisagés. Configuration précise : **À DÉCIDER**.

## 20. Prévention des injections

- Toute interaction future avec une base de données devra utiliser des requêtes paramétrées ou un ORM protégeant nativement contre l'injection SQL — jamais de concaténation de chaînes pour construire une requête.
- Toute donnée affichée dans l'interface devra être échappée correctement pour éviter les injections XSS (React échappe par défaut le contenu rendu, mais toute utilisation de `dangerouslySetInnerHTML` ou équivalent devra être justifiée et validée).

## 21. Protection CSRF

- Les Server Actions de Next.js intègrent des protections natives contre certaines classes d'attaques CSRF ; toute route API personnalisée qui accepterait des requêtes mutantes (POST/PUT/DELETE) devra être évaluée au cas par cas pour déterminer si une protection CSRF additionnelle est nécessaire.
- Détail à traiter au moment de l'implémentation de chaque route sensible — **À DÉCIDER** au cas par cas.

## 22. Tests de sécurité inspirés de l'OWASP WSTG

- Aucune revue de sécurité formelle inspirée de l'OWASP WSTG n'a été réalisée à ce jour, mais chaque suite de tests d'intégration (Sprints 3 à 9) couvre déjà, module par module, l'isolation multi-tenant/multi-agence, le contrôle d'accès par rôle (403/404 attendus) et la non-distinction compte inexistant/mot de passe invalide — voir [TESTREPORT.md](./TESTREPORT.md) pour le détail par sprint.
- Une revue WSTG complète devra couvrir a minima : gestion de l'authentification et des sessions, contrôle d'accès, validation des entrées, gestion des erreurs, protection des données sensibles au repos et en transit.
- Intégration systématique de ces tests dans le cycle de développement : **À DÉCIDER**, voir [TESTREPORT.md](./TESTREPORT.md).

## 23. Revue de sécurité consolidée et checklist MVP (Sprint 10)

Revue manuelle de **toutes** les routes `src/app/api/**/route.ts` (37 routes) menée pendant ce sprint, en complément (pas en remplacement) d'une future revue WSTG formelle (section 22, toujours À DÉCIDER). Méthode : vérifier pour chaque route (1) la présence d'un appel à `getSessionUser()` sauf exception documentée, (2) le scoping `tenantId` de toute lecture/écriture, (3) la cohérence du contrôle de rôle avec les décisions de DOMAINRULES.md.

**Résultat : aucune faille trouvée.** Un seul écart identifié, et c'était un **gap de couverture de test**, pas une faille de sécurité réelle : `GET /api/reports/revenue` et `GET /api/reports/vehicles` appliquaient bien le contrôle ADMIN-only en code, mais aucun test HTTP ne le vérifiait (`src/__tests__/reports.test.ts` ne testait que les fonctions `src/lib/reports.ts` directement) — six tests ajoutés (401/403/200 pour les deux routes).

Checklist de conformité MVP, vérifiée section par section de ce document :

| # | Point | Statut |
|---|---|---|
| 1 | Isolation stricte par tenant sur toutes les routes de lecture/écriture (section 1) | ✅ Vérifié (revue manuelle complète, aucune exception trouvée) |
| 2 | Séparation par agence pour véhicules/locations/maintenances/alertes (section 2) | ✅ Vérifié (`canAccessAgency`/`getAccessibleAgencyIds`, `src/lib/authz.ts`) |
| 3 | Authentification par mot de passe hashé, message d'erreur non distinctif | ✅ Implémenté (section 3) |
| 4 | Autorisation serveur systématique (jamais côté client seul) | ✅ Vérifié sur toutes les routes de mutation |
| 5 | Routes réservées ADMIN correctement gardées : `tenants`, `agencies` (écriture), `users`, `invitations` (écriture), `audit`, `reports/*`, `tasks/check-alerts` | ✅ Vérifié (revue manuelle + tests HTTP 403 pour un MEMBER sur chacune, section 22) |
| 6 | Mots de passe jamais exposés en clair ni dans les réponses API | ✅ Vérifié (section 10) |
| 7 | Aucune donnée de carte bancaire stockée | ✅ Respecté (aucune fonctionnalité de paiement en ligne n'existe, section 9) |
| 8 | Audit exhaustif sur le CRUD métier | ✅ Implémenté ce sprint (section 13) |
| 9 | Garde « dernier ADMIN » (self et tiers) | ✅ Confirmé (HANDOFF.md section 6) |
| 10 | Rate limiting / protection brute force sur l'authentification | ❌ **Non implémenté** — à traiter avant mise en production (section 3) |
| 11 | MFA | ❌ **Non implémenté**, **À DÉCIDER** (section 3) |
| 12 | Headers de sécurité (CSP, HSTS, etc.) | ❌ **Non implémenté**, **À DÉCIDER** (section 19) |
| 13 | Environnement de production / stratégie de sauvegarde | ❌ **Non défini**, **À DÉCIDER** (section 16, HANDOFF.md section 8) |
| 14 | Revue OWASP WSTG formelle | ❌ **Non réalisée**, **À DÉCIDER** (section 22) |

Les points 10 à 14 restent des prérequis explicites avant tout déploiement en production réelle (voir HANDOFF.md section 4) — le MVP est fonctionnellement complet et sans faille connue, mais n'est pas encore *déployé* en production au sens de ce document.

## 24. Audit de suivi (Sprint 11)

Nouvelle revue manuelle de **toutes** les routes `src/app/api/**/route.ts` (36 fichiers), menée dans le cadre d'un sprint de consolidation explicitement demandé par le propriétaire du projet (audit des points ouverts du handoff, corrections d'écarts réels). Même méthode que la revue Sprint 10 (section 23).

**Résultat : aucune faille d'isolation inter-tenant ou inter-agence trouvée.** Un **écart fonctionnel** a été identifié et corrigé — distinct d'une faille de sécurité, car il ne permettait à aucun moment une lecture ou une écriture croisée entre tenants :

- `POST /api/tenants` permettait à tout `ADMIN` authentifié de créer un `Tenant` totalement disjoint de son propre compte (aucun `User` rattaché), ensuite invisible et inaccessible via `GET`/`PATCH`/`DELETE /api/tenants/[id]` (tous scopés strictement à `id === user.tenantId`). Un `ADMIN` malveillant ou distrait pouvait donc créer un nombre arbitraire d'enregistrements `Tenant` orphelins — abus mineur de ressources nécessitant une authentification ADMIN valide (pas un vecteur pré-authentification), sans impact de confidentialité inter-tenant. **Corrigé** : route et page `/dashboard/tenants/new` retirées ; la création de tenant reste l'exclusivité de `POST /api/auth/register` (tenant + premier ADMIN, atomique) — voir HANDOFF.md point 36.

Checklist de conformité MVP (section 23) : statut inchangé, aucun des points 1 à 14 n'est affecté par cette revue au-delà de la confirmation du point 1 (isolation stricte par tenant), déjà vérifié.

## 25. Audit de sécurité approfondi (Sprint 16)

Sprint exclusivement dédié à la sécurité (aucun nouveau module métier) — audit méthodique en 4 volets menés en parallèle, chacun avec relecture intégrale du code concerné (pas un échantillonnage) :

1. **Routes API — authentification/tenant/agence/permissions** : les ~60 fichiers `src/app/api/**/route.ts*` relus méthode par méthode. Vérifié : présence de `getSessionUser()` (401 sinon, sauf routes publiques documentées) ; scoping `tenantId` systématique côté serveur (jamais un `tenantId` accepté du client) ; couverture du retrofit `can()` du Sprint 15 sur les 12 modules concernés (agencies/vehicles/locations/clients/invoices/payments/maintenances/alerts/cash-register/vehicle-transfers/vehicle-trips/reports) ; contrôle de rôle strict ADMIN sans `can()` sur users/invitations/permission-groups/tenants/data-reset/audit (conforme, voir section 4).
2. **IDOR sur les routes `[id]`** : les 26 fichiers `src/app/api/**/[id]/**/route.ts*` relus avec les fonctions `get*ById(tenantId, id)` qu'ils appellent — toutes filtrent bien `tenantId` **dans** la requête Prisma (`findFirst({ where: { id, tenantId } })`), jamais en vérification a posteriori. `canAccessAgency()`/`getAccessibleAgencyIds()` cohérents sur les ressources agency-scopées, y compris le cas à double agence des transferts de véhicules. Endpoints à sélection multiple (`batch-pdf`, suppression en masse de réservations) : chaque identifiant individuellement revérifié.
3. **Données sensibles, gestion d'erreurs, audit log, permissions par défaut** : aucune fuite de `passwordHash`/secret dans une réponse API ou un log ; aucun message d'erreur non filtré (stack trace, requête SQL) renvoyé au client ; `can()`/`getEffectivePermissions()` cohérents (un ADMIN ne retombe jamais sur le groupe `MEMBER` par défaut, seul un non-ADMIN sans groupe assigné en bénéficie).
4. **Imports/exports/reset** : import Excel des réservations, export CSV de l'audit, reset de données, PDF de lot — isolation tenant/agence appliquée à plusieurs niveaux dans les 4 cas, permissions/rôles revérifiés en base à chaque requête, aucune fuite dans les messages d'erreur.

**Résultat : aucune faille d'isolation tenant/agence ni IDOR trouvée** (confirmant à nouveau la solidité du modèle d'isolation logique, section 1). Les écarts réels trouvés sont des gaps de permission granulaire, de traçabilité d'audit, ou de robustesse (absence de plafond) — tous corrigés ce sprint :

| # | Faille/incohérence | Sévérité | Correctif |
|---|---|---|---|
| 1 | `POST /api/documents/batch-pdf` ne vérifiait aucune permission granulaire (`can()`), contrairement à toutes les autres routes `locations`/`invoices` retrofitées au Sprint 15 — commentaire de code obsolète jamais mis à jour | Moyenne | `can(user, "locations.view"/"invoices.view")` ajouté selon `type` |
| 2 | `VehicleNotAvailableError.conflictingLocations` exposait l'enregistrement `Location` complet (prix, caution, notes, `clientId`) dans la réponse `409` de `POST`/`PATCH /api/locations` et `POST /api/reservations/[id]/convert`, contournant `locations.view` pour un appelant n'ayant que `locations.create`/`edit` | Faible-Moyenne | `findConflictingLocations` (`src/lib/vehicles.ts`) sélectionne désormais uniquement `id`/`startDate`/`endDate`/`status` |
| 3 | Réinitialisation de mot de passe par un ADMIN sur un autre user non journalisée, contrairement au changement de rôle/agences dans le même handler | Moyenne | `logAction("user.password_reset")` ajouté (`PATCH /api/users/[id]`), sans le mot de passe en métadonnée |
| 4 | Tentative de reset de données avec un nom de confirmation incorrect non journalisée (seul un reset réussi laissait une trace) | Faible-Moyenne | `logAction("data.reset_failed")` ajouté (`src/lib/data-reset.ts`), sans le nom saisi |
| 5 | Injection de formule CSV (OWASP) dans l'export CSV partagé (`ExportCsvButton.tsx`, `/dashboard/audit` et `/dashboard/reports`) — `Papa.unparse` n'échappait pas un champ texte libre commençant par `=`/`+`/`-`/`@` | Faible | Préfixe d'apostrophe (`sanitizeCsvCell`) sur toute cellule texte à risque avant `Papa.unparse` |
| 6 | Import Excel des réservations sans limite de taille de fichier (DoS potentiel, utilisateur authentifié avec `reservations.import`) | Faible | Plafonné à 20 Mo (`POST /api/reservations/import`) |
| 7 | `POST /api/documents/batch-pdf` sans plafond sur les modes « identifiants »/« plage de dates », contrairement au mode « plage de numéros » déjà plafonné à 500 | Faible | Plafond de 500 étendu aux trois modes |

**Écart documentaire relevé en marge, sans impact sécurité** : DOMAINRULES.md section 31 affirmait encore que le reset de données remet à 0 `Tenant.lastContractNumber`, alors que le code (déjà correct depuis le Sprint 15) remet à 0 `Agency.lastContractNumber` — corrigé dans la documentation, le code n'a jamais eu besoin d'être modifié.

**Deux observations écartées après analyse, non retenues comme failles** : (a) `DELETE /api/tenants/[id]` n'émet pas de `logAction`, contrairement à `PATCH` du même fichier — `AuditLog.tenantId` a une FK obligatoire vers `Tenant` sans cascade, donc journaliser après coup échouerait systématiquement (silencieusement) et journaliser avant donnerait un log trompeur pour une suppression qui échoue quasi systématiquement de toute façon (409 FK, un tenant a toujours au moins un `User`) — documenté dans le code plutôt que « corrigé » par un log qui ne fonctionnerait pas ; (b) le groupe `MEMBER` par défaut accorde un CRUD large plutôt qu'un minimum — déjà documenté comme un choix délibéré (DOMAINRULES.md section 22), pas une régression de ce sprint.

Checklist de conformité MVP (section 23) : statut inchangé sur les points 10-14 (rate limiting, MFA, headers CSP, environnement de production, revue WSTG formelle — toujours hors périmètre MVP, **À DÉCIDER**). Les points 1-9 restent ✅, renforcés par cet audit (aucune régression, gaps additionnels corrigés).

Voir DOMAINRULES.md section 34 pour le détail complet et TESTREPORT.md section 3 « Tests Sprint 16 » pour les tests ajoutés.

## 26. Tests intensifs et régressions (Sprint 17)

Sprint de tests de bout en bout (aucun nouveau module métier, voir DOMAINRULES.md section 35 pour le détail complet) — 4 des 10 bugs trouvés ont une dimension sécurité (contournement d'isolation par agence, contournement d'un verrou métier, régression de permission, intégrité de la traçabilité d'audit), reportés ici par cohérence avec le format des sections 23-25 :

| # | Faille/incohérence | Sévérité | Correctif |
|---|---|---|---|
| 1 | `PATCH`/`DELETE /api/agencies/[id]` ne vérifiaient pas `canAccessAgency()` (seul `GET` le faisait) — un MEMBER avec un groupe personnalisé accordant `agencies.edit`/`agencies.delete` pouvait modifier/supprimer n'importe quelle agence du tenant, pas seulement celles auxquelles il a accès via `UserAgency` | Moyenne | `canAccessAgency()` ajouté sur `PATCH`/`DELETE`, même garde que `GET` |
| 2 | `PATCH /api/reservations/[id]` acceptait sans erreur une modification de n'importe quel champ (prix, dates, identité client) sur une réservation déjà `CONVERTED`/`CANCELLED` — seule l'UI empêchait ce cas, le contrat déjà généré à la conversion n'est jamais mis à jour rétroactivement | Faible-Moyenne | Nouveau `ReservationLockedError` (409) sur toute réservation terminale, notes exceptées |
| 3 | Régression fonctionnelle Sprint 15 (pas une faille de sécurité au sens strict, mais un déni de service applicatif pour le groupe concerné) : le groupe par défaut `AGENCE` n'avait jamais reçu `agencies.view`/`cash_register.*`, bloquant `GET /api/agencies` et donc plusieurs formulaires pour ce groupe | Faible | Clés ajoutées à `DEFAULT_GROUPS`/`SPRINT15_BACKFILL_PERMISSIONS` |
| 4 | Reset de données (section 17) non pleinement atomique — la purge conditionnelle de l'`AuditLog`, le recalcul de caisse et l'entrée d'audit finale s'exécutaient hors de la transaction principale ; un échec entre les deux pouvait laisser des données purgées sans que l'entrée d'audit obligatoire ne soit jamais écrite | Faible | Transaction interactive unique englobant l'ensemble (`src/lib/data-reset.ts`) |

Les deux autres bugs corrigés ce sprint (paiement mixte non atomique sur la fiche facture, prix d'option non effacé) sont des bugs de correction métier, pas des failles de sécurité — voir DOMAINRULES.md section 35 pour le détail complet, y compris le gap de concurrence identifié sur les transferts/déplacements de véhicule et documenté plutôt que corrigé ce sprint (hors périmètre proportionné, pattern préexistant ailleurs dans le projet).

Aucune nouvelle faille d'isolation tenant/agence ni IDOR trouvée par ailleurs — les 4 revues en parallèle de ce sprint (voir HANDOFF.md section 1) confirment une nouvelle fois la solidité du modèle (section 1) après les audits Sprint 10/11/15/16.

## 27. Pilote réel et validation terrain (Sprint 18)

Sprint de validation d'usage réel (aucun nouveau module métier ; ce n'est pas un audit de sécurité — déjà fait Sprint 16 — mais 3 des 14 bugs trouvés ont une dimension fuite d'information/accès, reportés ici par cohérence avec le format des sections 23-26 ; voir DOMAINRULES.md section 36 pour le détail complet) :

| # | Faille/incohérence | Sévérité | Correctif |
|---|---|---|---|
| 1 | Carte « Alertes récentes » du dashboard et cloche/badge du `Header` (visible sur toutes les pages) affichaient le message réel de chaque alerte et un compteur à tout user authentifié, sans vérifier `alerts.view` — un groupe `COMPTABILITÉ` (sans cette clé) voyait le contenu d'un module auquel `/dashboard/alerts` lui refuse pourtant explicitement l'accès | Faible | `can(user, "alerts.view")` ajouté aux deux endroits |
| 2 | `/dashboard/reports/page.tsx` restée en contrôle `role === "ADMIN"` strict alors que `/api/reports/*` avait été retrofité au Sprint 15 pour `can(user, "reports.view")` — incohérence de contrôle d'accès entre deux couches de la même fonctionnalité (pas une fuite en soi, la page bloquait *plus* que l'API, mais un défaut de cohérence du modèle de permission qui aurait pu évoluer dans le mauvais sens) | Faible | Page alignée sur la même vérification que l'API |
| 3 | Assignation d'un groupe de permissions à un utilisateur (`PATCH /api/users/[id]/permissions`, action sensible modifiant les droits d'accès) signalée non auditée par un agent de walkthrough navigateur — **vérifié directement en base après investigation, la journalisation (`user.permissions_changed`) existe déjà et fonctionne** ; signalement non confirmé, verrouillé par un test de régression plutôt que corrigé | N/A (faux positif) | Aucun correctif nécessaire — test ajouté pour garder la preuve |

Les autres bugs corrigés ce sprint (caisse non alimentée, facture à 0 jamais `PAID`, kilométrage retour perdu, bouton Annuler non gated, `reservations.import` manquant, champs obligatoires non appliqués, CSV sans BOM, mobile rogné, groupe ADMIN sans avertissement, formulaire tenant, année véhicule) sont des bugs de correction métier/UX, pas des failles de sécurité au sens strict — voir DOMAINRULES.md section 36 pour le détail complet.

Aucune nouvelle faille d'isolation tenant/agence ni IDOR trouvée — les 4 revues en parallèle de ce sprint (voir HANDOFF.md section 1) confirment une nouvelle fois la solidité du modèle (section 1) après les audits Sprint 10/11/15/16.
