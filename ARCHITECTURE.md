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
- **Développement** : environnement actuel, exécuté localement via `npm run dev`.
- **Test** : aucun environnement de test dédié n'existe à ce jour ; aucune stratégie de test automatisé n'est encore en place (voir [TESTREPORT.md](./TESTREPORT.md)).
- **Staging** : non défini à ce jour. Hébergeur et configuration restent **À DÉCIDER**.
- **Production** : non défini à ce jour. Hébergeur, domaine, gestionnaire de secrets et stratégie de sauvegarde restent **À DÉCIDER**.

Aucun de ces environnements (hormis le développement local) n'est actuellement configuré ou déployé.

## 15. Migrations de production

Prisma étant désormais retenu comme ORM cible (section 7, **non installé à ce jour**), les migrations de production devront, lors de son introduction effective, être appliquées de façon contrôlée et non interactive, via `npx prisma migrate deploy`, jamais via une commande de migration interactive ou destructive en environnement de production.
