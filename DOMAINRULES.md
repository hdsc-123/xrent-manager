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
- **Décision Sprint 5 (provisoire, à confirmer)** : pour véhicules et locations, un `MEMBER` explicitement rattaché à une agence via `UserAgency` peut créer/modifier/supprimer les véhicules et locations **de cette agence** (lecture et écriture), pas seulement les consulter — contrairement à `Tenant`/`Agency` où l'écriture reste réservée à `ADMIN`. Choix pragmatique (le personnel d'agence a besoin de gérer le quotidien de sa flotte et de ses locations), pas une décision produit définitive — à confirmer explicitement avec le propriétaire du projet, notamment si un rôle plus restreint (lecture seule agence, ex. « agent junior ») s'avère nécessaire.
- Toute vérification de rôle devra être appliquée côté serveur (voir [ARCHITECTURE.md](./ARCHITECTURE.md) et [SECURITY.md](./SECURITY.md)).

## 5. Véhicules

- **Décision validée (Sprint 5)** : un véhicule appartient à un tenant et à **exactement une** agence (`agencyId` requis, non nul sur `Vehicle`) — pas de partage entre agences d'un même tenant à ce stade.
- **Décision validée (Sprint 5)** : attributs a minima implémentés — `name`, `licensePlate` (unique par tenant), `make`, `model`, `year`, `category` (chaîne libre, voir section 6), `status` (`AVAILABLE`/`RENTED`/`MAINTENANCE`/`INACTIVE`), `pricePerDay` (entier, centimes) + `currency` (voir section 14). Kilométrage et état technique détaillé : **toujours À DÉCIDER**.
- **Décision validée (Sprint 5)** : disponibilité calculée à la demande à partir des `Location` existantes (`PENDING`/`CONFIRMED`/`ACTIVE` bloquent, `CANCELLED`/`COMPLETED` ne bloquent pas), pas de calendrier ni de statut de disponibilité mis à jour séparément — `status` reste un champ manuel distinct (ex. `MAINTENANCE`), pas dérivé automatiquement des locations.
- Gestion de la maintenance et de l'historique technique : **À DÉCIDER**.
- Suppression : bloquée si le véhicule a au moins une location associée, quel qu'en soit le statut (implémenté Sprint 5, `DELETE /api/vehicles/[id]`).

## 6. Catégories de véhicules

- **Décision Sprint 5** : `category` est un champ texte libre sur `Vehicle`, propre à chaque tenant de fait (pas de table `Category` partagée ni de contrainte de valeurs), pour rester simple et ne pas figer une taxonomie non validée. À revoir si un besoin de tarification/recherche par catégorie normalisée émerge — **toujours À DÉCIDER** pour un modèle `Category` dédié.
- Modèle de tarification par catégorie (prix de base, variations saisonnières) : **À DÉCIDER** — pour l'instant, le prix est porté directement par chaque véhicule (`pricePerDay`).

## 7. Réservations et contrats (fusionnés : `Location`)

- **Décision validée (Sprint 5)** : réservation et contrat sont fusionnés en un seul modèle `Location`, avec un cycle de statuts explicite plutôt que deux entités séparées — simplification assumée pour le MVP, validée explicitement par le propriétaire du projet. À scinder ultérieurement si des besoins distincts émergent (ex. signature de contrat, conditions générales spécifiques).
- **Décision validée (Sprint 5)** : états et transitions autorisées (machine à états explicite, `src/lib/locations.ts`) :
  `PENDING → CONFIRMED | CANCELLED`, `CONFIRMED → ACTIVE | CANCELLED`, `ACTIVE → COMPLETED | CANCELLED`, `COMPLETED`/`CANCELLED` terminaux. Toute transition non listée est refusée côté serveur (409).
- **Décision validée (Sprint 5)** : une location réserve toujours un véhicule précis (pas de réservation par catégorie avec attribution différée).
- **Décision validée (Sprint 5)** : deux locations sur le même véhicule sont en conflit si leurs périodes se chevauchent strictement (`newStart < existingEnd && newEnd > existingStart`) — une reprise le jour même de la restitution d'une autre location n'est **pas** un conflit. Seules les locations `PENDING`/`CONFIRMED`/`ACTIVE` comptent comme conflictuelles.
- **Décision validée (Sprint 5)** : suppression d'une location autorisée uniquement si son statut est `PENDING` ou `CANCELLED` ; sinon, elle doit d'abord être annulée (`PATCH status=CANCELLED`) — aucune donnée de location confirmée/active/terminée n'est physiquement supprimable, en l'absence de table d'audit (voir section 16).
- Règles de non-présentation (no-show) : **À DÉCIDER** — aujourd'hui, seule une annulation manuelle existe.
- Contenu détaillé du contrat (conditions générales, franchise, kilométrage inclus, options), prolongations, retours anticipés/en retard : **toujours À DÉCIDER**.

## 8. (fusionné avec la section 7 — voir ci-dessus)

## 9. Clients

- **Décision validée (Sprint 5)** : un client est un modèle `Client` minimal et distinct (`name`, `email?`, `phone?`), propre à un tenant, **sans identifiants de connexion** — distinct du modèle `User` (comptes staff du tenant avec rôle `ADMIN`/`MEMBER`). Décision explicite du propriétaire du projet pour éviter de mélanger comptes internes et locataires externes.
- Un client est-il rattaché à un tenant uniquement, ou peut-il être partagé/reconnu entre tenants (ex. via un identifiant national) : **toujours À DÉCIDER**. Hypothèse de travail confirmée : un client est propre à un tenant, sans partage entre tenants.
- Pas de page `/dashboard/clients` dédiée au Sprint 5 (sélection/création uniquement depuis le formulaire de création de location) — **À DÉCIDER** si un module clients à part entière (recherche, historique, fusion de doublons) est nécessaire.
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
- **Premier exemple implémenté (Sprint 5)** : `Location.status` (voir section 7) — transitions validées côté serveur (`src/lib/locations.ts`, fonction `canTransition`), jamais côté client seul.
- Les états précis et les transitions autorisées pour les autres entités futures (paiement, etc.) restent **À DÉCIDER** au moment de la conception de chaque module. `Vehicle.status` (Sprint 5) reste un champ manuel simple (`AVAILABLE`/`RENTED`/`MAINTENANCE`/`INACTIVE`), pas une machine à états à transitions contraintes pour l'instant.
- Principe directeur déjà acté : aucune transition d'état sensible ne doit pouvoir être déclenchée uniquement depuis le client (voir [SECURITY.md](./SECURITY.md)).

## 14. Montants financiers

- **Décision actée** : aucun montant financier ne sera représenté ou calculé en `float`/`double`, afin d'éviter toute perte de précision.
- **Décision validée (Sprint 1)** : tout montant financier sera représenté par un entier exprimé dans la plus petite unité monétaire (ex. centimes), avec la devise stockée explicitement à côté de chaque montant.
- **Premier exemple implémenté (Sprint 5)** : `Vehicle.pricePerDay`/`Location.pricePerDay`/`Location.totalPrice` sont des entiers (centimes), chacun accompagné d'un champ `currency` (String, ex. ISO 4217) — décision explicite du propriétaire du projet pour respecter cette règle malgré l'absence de décision multi-devises définitive.
- **Décision Sprint 5 (provisoire)** : devise par défaut **`"MAD"`** (Dirham marocain) pour tout nouveau `Vehicle`/`Location`, en attendant la décision multi-devises définitive ci-dessous. Changée depuis `"EUR"` peu après le Sprint 5 (migration `20260811203931_change_default_currency_to_mad`, `ALTER COLUMN ... SET DEFAULT` — les enregistrements déjà créés avec `"EUR"` ne sont pas rétroactivement modifiés). Ce n'est pas un verrouillage : le champ `currency` existe précisément pour permettre d'introduire d'autres devises (EUR, USD, etc.) sans nouvelle migration de schéma.
- Devise(s) réellement supportée(s) en production et gestion du multi-devises entre tenants : **toujours À DÉCIDER**.
- **Décision validée (Sprint 5)** : `Location.pricePerDay` est une copie figée (« snapshot ») du `Vehicle.pricePerDay` au moment de la création de la location — un changement ultérieur du tarif du véhicule ne modifie jamais rétroactivement une location existante.
- **Décision validée (Sprint 5)** : `totalPrice = pricePerDay × nombre de jours`, nombre de jours arrondi au jour supérieur (`Math.ceil`), minimum 1 jour (`src/lib/locations.ts`, fonction `calculateTotalPrice`).
- Règles d'arrondi financier au-delà de ce calcul de jours (ex. taxes, remises) : **À DÉCIDER**.

## 15. Dates et fuseaux horaires

- **Décision validée (Sprint 1)** : toutes les dates/heures seront stockées en UTC, avec conversion à l'affichage selon le fuseau horaire de l'agence.
- Modélisation précise du fuseau horaire propre à chaque agence (utile pour les horaires de retrait/retour de véhicule) : **À DÉCIDER**.
- Format de dates utilisé dans les exports/imports : **À DÉCIDER**.

## 16. Règles d'audit

- Toute action sensible (création, modification, suppression, changement d'état, export, import, reset) devra être auditée avec : qui, quoi, quand, sur quelle ressource, dans quel tenant/quelle agence.
- **Décision validée (Sprint 1)** : le mécanisme technique retenu est une table d'audit dédiée (voir [ARCHITECTURE.md](./ARCHITECTURE.md) section 12).
- Durée de conservation des journaux d'audit : **À DÉCIDER**.
- Accès aux journaux d'audit (qui peut les consulter) : **À DÉCIDER**, mais par principe restreint (probablement réservé aux administrateurs du tenant concerné, sans accès inter-tenant).
