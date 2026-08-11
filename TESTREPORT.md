# TESTREPORT.md — Suivi des tests

Ce document fait le point sur les tests réellement exécutés à ce jour et définit la stratégie de test future. Aucun framework de test n'est installé dans le projet à ce jour ; ce document ne doit donc pas être lu comme la preuve d'une couverture de test métier, qui est actuellement **nulle**.

## 1. Tests déjà exécutés et résultats

| Date | Commande | Résultat | Détail |
|---|---|---|---|
| 2026-08-11 | `npm run lint` | ✅ Validé | Aucune erreur ESLint (config `eslint-config-next`) |
| 2026-08-11 | `npm run build` | ✅ Validé | Build de production Next.js 16.3.0 réussi (Turbopack), 2 routes statiques générées (`/`, `/_not-found`) |

**Aucun test métier n'est disponible à ce jour**, pour la raison simple qu'aucun module métier n'existe encore dans le code (voir [HANDOFF.md](./HANDOFF.md) et [PROJECT_MAP.md](./PROJECT_MAP.md)). `npm run lint` et `npm run build` valident uniquement la qualité syntaxique/type et la constructibilité du socle Next.js par défaut — ils ne constituent pas des tests fonctionnels.

## 2. Tests non encore disponibles

- Aucun framework de test (unitaire, intégration ou end-to-end) n'est installé dans `package.json`.
- Aucune commande `npm run test` n'existe.
- Aucun test métier, de permission, multi-tenant, de concurrence, de charge, de sécurité ou de régression n'existe.

## 3. Stratégie future de tests

Le choix précis des outils (framework de test unitaire, outil e2e, outil de test de charge) est **À DÉCIDER**. Les principes suivants sont actés (dont certains confirmés lors de la validation du Sprint 1, voir [HANDOFF.md](./HANDOFF.md)) :

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
Priorité de test la plus élevée du projet (décision Sprint 1) : le modèle d'isolation retenu (`tenant_id` partagé, voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 8) rend l'omission d'un filtre tenant le risque de sécurité le plus critique (voir [SECURITY.md](./SECURITY.md) section 1). Ces tests vérifieront explicitement qu'aucune donnée d'un tenant n'est accessible depuis un autre tenant, y compris par accès direct par identifiant (IDOR, voir [SECURITY.md](./SECURITY.md) section 7). Aucun test multi-tenant n'existe à ce jour.

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
