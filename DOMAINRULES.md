# DOMAINRULES.md — Règles métier

Ce document définit les règles métier initiales de XRent Manager. Aucun de ces domaines n'est implémenté en code à ce jour ; ce document sert de base de discussion et de référence pour les futurs sprints. Chaque point non tranché est explicitement marqué **À DÉCIDER** — une hypothèse non validée ne doit jamais être traitée comme une décision définitive.

## 1. Tenants

- Un tenant représente une organisation cliente du SaaS (ex. une société de location de véhicules).
- Un tenant est isolé de tout autre tenant : aucune donnée, utilisateur, véhicule, réservation, contrat ou paiement ne doit être partagé entre tenants.
- Cycle de vie d'un tenant (création, suspension, suppression, période d'essai) : **À DÉCIDER**.
- Modalités de facturation du SaaS lui-même (abonnement, par agence, par véhicule) : **À DÉCIDER**.

## 2. Agences

- Une agence est un point de location rattaché à un tenant. Un tenant peut avoir une ou plusieurs agences.
- Une agence appartient à exactement un tenant.
- Un véhicule peut-il être partagé entre plusieurs agences d'un même tenant, ou est-il rattaché à une seule agence : **À DÉCIDER**.
- Une réservation ou un contrat peut-il impliquer un retrait dans une agence et un retour dans une autre (location croisée) : **À DÉCIDER**.

## 3. Utilisateurs

- Un utilisateur appartient à un tenant.
- Un utilisateur peut-il appartenir à plusieurs agences du même tenant, et avec quels droits : **À DÉCIDER**.
- Modalités de création de compte (invitation par un administrateur, auto-inscription) : **À DÉCIDER**.
- Politique de mots de passe et de sécurité de compte : voir [SECURITY.md](./SECURITY.md).

## 4. Rôles

- Existence a minima envisagée : un rôle administrateur au niveau tenant (accès au dashboard-admin) et un ou plusieurs rôles opérationnels au niveau agence.
- Liste précise des rôles, permissions associées à chaque rôle, et granularité (par action, par module) : **À DÉCIDER**.
- Toute vérification de rôle devra être appliquée côté serveur (voir [ARCHITECTURE.md](./ARCHITECTURE.md) et [SECURITY.md](./SECURITY.md)).

## 5. Véhicules

- Un véhicule appartient à un tenant, et probablement à une agence (voir section 2 — À DÉCIDER).
- Attributs attendus a minima (immatriculation, marque, modèle, kilométrage, état) : **À DÉCIDER** dans le détail.
- Gestion de la disponibilité (calendrier, statut en temps réel) : **À DÉCIDER**.
- Gestion de la maintenance et de l'historique technique : **À DÉCIDER**.

## 6. Catégories de véhicules

- Une catégorie regroupe des véhicules par type (ex. citadine, SUV, utilitaire) à des fins de tarification et de recherche.
- Rattachement des catégories au tenant (catégories propres à chaque tenant) ou catégories globales partagées : **À DÉCIDER**.
- Modèle de tarification par catégorie (prix de base, variations saisonnières) : **À DÉCIDER**.

## 7. Réservations

- Une réservation précède un contrat ; elle réserve un véhicule (ou une catégorie de véhicule) sur une période donnée.
- Réservation d'un véhicule précis vs réservation d'une catégorie (attribution du véhicule précis plus tard) : **À DÉCIDER**.
- Règles d'annulation, de modification, et de non-présentation (no-show) : **À DÉCIDER**.
- États possibles d'une réservation et transitions autorisées : **À DÉCIDER** (voir section 12).

## 8. Contrats

- Un contrat matérialise la location effective d'un véhicule à un client sur une période donnée, généralement issu d'une réservation validée.
- Contenu exact du contrat (conditions générales, franchise, kilométrage inclus, options) : **À DÉCIDER**.
- Gestion des prolongations, retours anticipés, et retours en retard : **À DÉCIDER**.
- Un contrat doit être rattaché sans ambiguïté à un tenant, une agence, un client et un véhicule.

## 9. Clients

- Un client est une personne physique ou morale qui loue un véhicule auprès d'un tenant.
- Un client est-il rattaché à un tenant uniquement, ou peut-il être partagé/reconnu entre tenants (ex. via un identifiant national) : **À DÉCIDER**. Par défaut, hypothèse de travail : un client est propre à un tenant, sans partage entre tenants, sauf décision contraire.
- Documents d'identité et de permis de conduire requis, et modalités de vérification : **À DÉCIDER**. Ce sont des données personnelles sensibles (voir [SECURITY.md](./SECURITY.md)).

## 10. Paiements

- Un paiement est associé à une réservation ou un contrat.
- **Aucune carte bancaire ne doit être stockée en clair** dans le système, en base de données ou dans les logs, en aucune circonstance (voir [SECURITY.md](./SECURITY.md)). La tokenisation via un prestataire de paiement tiers conforme PCI-DSS est la seule approche envisagée à ce stade.
- Choix du/des prestataires de paiement : **À DÉCIDER**.
- Gestion des paiements partiels, échelonnés, et des remboursements : **À DÉCIDER**.
- Tout montant financier doit être représenté sans perte de précision, jamais en `float`/`double` (voir section 14).

## 11. Cautions

- Une caution peut être associée à un contrat, distincte du paiement de la location elle-même.
- Modalités techniques (préautorisation carte, dépôt en espèces, garantie tierce) : **À DÉCIDER**.
- Conditions de restitution ou de retenue (partielle ou totale) de la caution, et traçabilité de cette décision : **À DÉCIDER**.

## 12. Incidents

Deux natures d'incidents doivent être distinguées :

1. **Incidents métier** (liés à une location : dommage sur véhicule, accident, litige avec un client) — règles de déclaration, de qualification de gravité, et de rattachement à un contrat : **À DÉCIDER**.
2. **Incidents projet/techniques** (bugs, pannes) — suivis dans [INCIDENTS.md](./INCIDENTS.md), sans rapport avec le domaine métier de la location.

## 13. États et transitions

- Chaque entité ayant un cycle de vie (réservation, contrat, paiement, véhicule) devra avoir une machine à états explicite, avec des transitions autorisées définies et validées côté serveur.
- Les états précis et les transitions autorisées pour chaque entité sont **À DÉCIDER** au moment de la conception de chaque module.
- Principe directeur déjà acté : aucune transition d'état sensible ne doit pouvoir être déclenchée uniquement depuis le client (voir [SECURITY.md](./SECURITY.md)).

## 14. Montants financiers

- **Décision actée** : aucun montant financier ne sera représenté ou calculé en `float`/`double`, afin d'éviter toute perte de précision.
- **Décision validée (Sprint 1)** : tout montant financier sera représenté par un entier exprimé dans la plus petite unité monétaire (ex. centimes), avec la devise stockée explicitement à côté de chaque montant.
- Devise initiale et gestion du multi-devises entre tenants : **À DÉCIDER**.
- Règles d'arrondi (le cas échéant) : **À DÉCIDER**.

## 15. Dates et fuseaux horaires

- **Décision validée (Sprint 1)** : toutes les dates/heures seront stockées en UTC, avec conversion à l'affichage selon le fuseau horaire de l'agence.
- Modélisation précise du fuseau horaire propre à chaque agence (utile pour les horaires de retrait/retour de véhicule) : **À DÉCIDER**.
- Format de dates utilisé dans les exports/imports : **À DÉCIDER**.

## 16. Règles d'audit

- Toute action sensible (création, modification, suppression, changement d'état, export, import, reset) devra être auditée avec : qui, quoi, quand, sur quelle ressource, dans quel tenant/quelle agence.
- **Décision validée (Sprint 1)** : le mécanisme technique retenu est une table d'audit dédiée (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 12).
- Durée de conservation des journaux d'audit : **À DÉCIDER**.
- Accès aux journaux d'audit (qui peut les consulter) : **À DÉCIDER**, mais par principe restreint (probablement réservé aux administrateurs du tenant concerné, sans accès inter-tenant).
