# SECURITY.md — Sécurité

Ce document définit les règles de sécurité de XRent Manager. Aucun mécanisme décrit ici n'est implémenté à ce jour (le projet est au stade Sprint 1 — cadrage architectural validé, aucune implémentation technique démarrée) : il s'agit d'exigences à respecter dès la conception des premiers modules, pas d'un état des lieux d'une implémentation existante.

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
- **Limite structurelle connue** : `User.email` n'est unique que par tenant (`@@unique([tenantId, email])`, pas globalement). La connexion (`/api/auth/login`) résout l'utilisateur par email seul (`findFirst`) : en cas d'email identique dans deux tenants différents, ce lookup est ambigu (retourne arbitrairement l'un des deux). Aucun mécanisme de résolution du tenant à la connexion (sous-domaine, sélection explicite, etc.) n'existe — **À DÉCIDER**, voir aussi [HANDOFF.md](./HANDOFF.md) section 8.

## 4. Autorisation côté serveur

- Toute action sensible doit être validée côté serveur, indépendamment des contrôles côté client (masquage de bouton, désactivation de champ, etc.), qui ne sont que des aides d'expérience utilisateur et non des mesures de sécurité.
- **Décision validée (Sprint 1)** : chaque action serveur doit vérifier l'identité de l'utilisateur, son rôle, son tenant, son agence, et l'appartenance de la ressource ciblée à ce même tenant/agence. Cette vérification doit s'appuyer sur la couche d'accès aux données centralisée avec garde tenant/agence obligatoire (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 7).

## 5. Gestion des sessions

**Implémenté (Sprint 3)** : sessions **JWT** (cookie chiffré, signé avec `AUTH_SECRET`), pas de sessions "database". Ce choix n'est pas arbitraire : NextAuth v5 lève une erreur au runtime (`UnsupportedStrategy`, vérifié dans `node_modules/@auth/core/lib/utils/assert.js`) si `CredentialsProvider` est combiné avec `session.strategy: "database"` — les deux décisions initiales du Sprint 3 (sessions database + login email/password) étaient techniquement incompatibles ; la stratégie JWT a été retenue après validation explicite du propriétaire du projet.

- Cookie posé par NextAuth (`authjs.session-token`, `HttpOnly`, `SameSite=lax`, `Secure` en HTTPS) — configuration par défaut de la librairie, non personnalisée.
- Déconnexion (`POST /api/auth/logout`) : efface le cookie côté serveur (`Max-Age=0`), vérifié par test. **Limite connue des sessions JWT (stateless)** : un jeton déjà émis reste cryptographiquement valide jusqu'à son expiration même après "déconnexion" ou changement de mot de passe, puisqu'il n'existe pas de table de sessions consultée à chaque requête pour le révoquer — seule la suppression du cookie côté client est garantie. Une éventuelle révocation serveur (ex. liste de blocage, passage à des sessions database avec un flux de connexion custom) reste **À DÉCIDER** si ce risque devient inacceptable.
- Les modèles `Account`/`Session`/`VerificationToken` de l'adaptateur Prisma (`@auth/prisma-adapter`) sont présents dans le schéma pour permettre l'ajout futur de fournisseurs OAuth sans nouvelle migration, mais la table `Session` n'est pas utilisée pour les connexions par mot de passe actuelles.
- Expiration de session par défaut de NextAuth (30 jours) — non personnalisée à ce stade, **À DÉCIDER** si une durée plus courte est nécessaire.

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
- **Implémenté (Sprint 3)** : hachage avec `bcryptjs` (facteur de coût 12), champ `User.passwordHash` (nullable — un `User` créé sans mot de passe, par exemple via un futur fournisseur OAuth, n'en a pas). Longueur minimale imposée à l'inscription : 8 caractères (`src/app/api/auth/register/route.ts`) — aucune autre règle de complexité, expiration ou historique n'est appliquée à ce stade, **À DÉCIDER**.
- `passwordHash` n'est jamais inclus dans une réponse API (vérifié par test sur `/register`, `/login`, `/me`) ni dans le payload de session NextAuth (le callback `session` ne recopie que `id`, `tenantId`, `role`).

## 11. Données personnelles

- Les données personnelles des clients (identité, coordonnées, documents de permis de conduire) sont des données sensibles à protéger.
- Principes à respecter (détail À DÉCIDER) : minimisation de la collecte, chiffrement au repos des données les plus sensibles si applicable, droit d'accès/rectification/suppression selon la réglementation applicable (ex. RGPD si des utilisateurs européens sont concernés — juridiction(s) cible(s) **À DÉCIDER**).

## 12. Logs

- Les logs applicatifs ne doivent jamais contenir : mots de passe, tokens de session, données de carte bancaire, secrets, ni de données personnelles sensibles non nécessaires au diagnostic.
- Stratégie de rétention et d'accès aux logs : **À DÉCIDER**.

## 13. Audit

- Toute action sensible doit être tracée de façon non falsifiable (ou au minimum difficilement falsifiable) : qui, quoi, quand, sur quelle ressource, dans quel tenant/agence.
- **Décision validée (Sprint 1)** : le mécanisme technique retenu est une table d'audit dédiée. Durée de conservation et droits d'accès restent **À DÉCIDER**.
- Voir [DOMAINRULES.md](./DOMAINRULES.md) section 16 et [ARCHITECTURE.md](./ARCHITECTURE.md) section 12.

## 14. Exports

- **Décision validée (Sprint 1)** : tout export doit être validé côté serveur et scopé par tenant, sans exception.
- Un export ne doit jamais contenir de données d'un autre tenant que celui de l'utilisateur qui le demande.
- Un export ne doit jamais contenir de données de carte bancaire en clair, ni de mots de passe/hashs de mots de passe.
- Tout export doit être soumis aux mêmes règles d'autorisation que les données sous-jacentes, et doit être audité (voir section 13). Format et périmètre précis restent **À DÉCIDER**.

## 15. Imports

- **Décision validée (Sprint 1)** : tout import doit être validé côté serveur et scopé par tenant, sans exception.
- Toute donnée importée doit être validée côté serveur avant écriture (structure, types, cohérence métier), au même niveau d'exigence qu'une saisie manuelle.
- Un import ne doit jamais permettre de contourner l'isolation tenant/agence (ex. en injectant un `tenant_id` arbitraire dans un fichier importé). Contrôles de validation détaillés : **À DÉCIDER**.

## 16. Sauvegardes

- Stratégie de sauvegarde (fréquence, rétention, chiffrement, lieu de stockage) : **À DÉCIDER**, à définir avant la mise en production.
- Toute sauvegarde contenant des données sensibles (personnelles ou financières) doit être protégée au moins au même niveau que la base de données de production.

## 17. Reset sécurisé

- **Décision validée (Sprint 1)** : tout reset de données doit être **techniquement impossible en environnement de production** — la vérification du contexte d'environnement doit être effectuée côté serveur, de façon non contournable depuis le client.
- Un reset de données (hors production) ne doit jamais être possible sans confirmation explicite et validation côté serveur du rôle de l'utilisateur qui le déclenche.
- Détail technique du mécanisme (comment le contexte d'environnement est vérifié, quels rôles peuvent déclencher un reset hors production) : **À DÉCIDER**, aucun mécanisme de reset n'existe à ce jour.

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

- Aucun test de sécurité n'est réalisé à ce jour (aucun module métier n'existe encore).
- Lorsque des modules métier seront développés, une revue inspirée de l'OWASP Web Security Testing Guide (WSTG) devra couvrir a minima : gestion de l'authentification et des sessions, contrôle d'accès (y compris tests d'isolation multi-tenant/multi-agence), validation des entrées, gestion des erreurs, protection des données sensibles au repos et en transit.
- Intégration de ces tests dans le cycle de développement : **À DÉCIDER**, voir [TESTREPORT.md](./TESTREPORT.md).
