import { Prisma } from "@prisma/client";
import type { PermissionGroup, GroupPermission } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/authz";

/**
 * Système de permissions granulaires (Sprint 12C). Le catalogue des clés de permission
 * vit ici, en code — pas dans une table dédiée (voir le commentaire sur PermissionGroup
 * dans prisma/schema.prisma) — pour ne pas avoir à garder une table de référence
 * synchronisée avec le code à chaque nouvelle permission.
 *
 * Portée (Sprint 15, DOMAINRULES.md section 22) : ces permissions sont désormais
 * appliquées côté serveur sur (quasiment) tous les modules métier — agencies, vehicles,
 * clients, locations, reservations, invoices, payments, reports, maintenances, alerts,
 * cash_register, vehicle_transfers, vehicle_trips — en complément, jamais en remplacement,
 * de `canAccessAgency()`/`getAccessibleAgencyIds()` là où elles existent déjà. Restent
 * volontairement en contrôle de rôle strict (ADMIN only), non convertis en `can()` :
 * users, invitations, permission-groups, tenants, data-reset, audit — DOMAINRULES.md
 * section 4 réserve explicitement la gestion des utilisateurs à ADMIN, même sur son
 * propre compte ; les clés `users.*`/`invitations.*`/`audit.view` du catalogue restent
 * donc décoratives (choix délibéré, pas un oubli). Les groupes par défaut ci-dessous ont
 * été mis à jour pour préserver le comportement effectif d'aujourd'hui (aucune régression
 * involontaire) — voir le commentaire sur chaque groupe.
 */
export interface PermissionDefinition {
  key: string;
  label: string;
  category: string;
}

export const PERMISSIONS: PermissionDefinition[] = [
  { key: "agencies.view", label: "Voir les agences", category: "Agences" },
  { key: "agencies.create", label: "Créer des agences", category: "Agences" },
  { key: "agencies.edit", label: "Modifier des agences", category: "Agences" },
  { key: "agencies.delete", label: "Supprimer des agences", category: "Agences" },

  { key: "vehicles.view", label: "Voir les véhicules", category: "Véhicules" },
  { key: "vehicles.create", label: "Créer des véhicules", category: "Véhicules" },
  { key: "vehicles.edit", label: "Modifier des véhicules", category: "Véhicules" },
  { key: "vehicles.delete", label: "Supprimer des véhicules", category: "Véhicules" },

  { key: "clients.view", label: "Voir les clients", category: "Clients" },
  { key: "clients.create", label: "Créer des clients", category: "Clients" },
  { key: "clients.edit", label: "Modifier des clients", category: "Clients" },
  { key: "clients.delete", label: "Supprimer des clients", category: "Clients" },

  { key: "locations.view", label: "Voir les locations", category: "Locations" },
  { key: "locations.create", label: "Créer des locations", category: "Locations" },
  { key: "locations.edit", label: "Modifier des locations", category: "Locations" },
  { key: "locations.delete", label: "Supprimer des locations", category: "Locations" },
  // Sprint 24 : même correctif que reservations.confirm/cancel/no_show ci-dessous — les
  // transitions de statut d'un contrat (Confirmer/Activer/Terminer/Annuler) passaient toutes
  // par locations.edit, la même clé que la modification des champs. Clés dédiées, vérifiées
  // par transition cible (voir PATCH /api/locations/[id]/route.ts). N'affecte pas
  // adminCancelValidatedLocation (POST .../admin-cancel), déjà réservé au rôle ADMIN sans
  // permission granulaire (DOMAINRULES.md section 39).
  { key: "locations.confirm", label: "Confirmer un contrat (PENDING → CONFIRMED)", category: "Locations" },
  { key: "locations.activate", label: "Activer un contrat (CONFIRMED → ACTIVE)", category: "Locations" },
  { key: "locations.complete", label: "Terminer un contrat (→ COMPLETED)", category: "Locations" },
  { key: "locations.cancel", label: "Annuler un contrat non validé (PENDING → CANCELLED)", category: "Locations" },
  // Sprint 32 : la date/heure réelle de retour (Location.actualReturnAt) est préremplie par
  // l'heure serveur à l'ouverture du formulaire de retour et jamais modifiable côté client
  // seul (DOMAINRULES.md section 32) — cette clé, isolée, autorise uniquement sa correction ;
  // elle ne donne aucun droit supplémentaire sur le contrat, le véhicule, les paiements ou les
  // dégâts. Non accordée à aucun groupe par défaut à cette étape (catalogue uniquement — voir
  // le commentaire équivalent sur damages.* ci-dessous).
  {
    key: "locations.return_time.edit",
    label: "Corriger la date/heure réelle de retour",
    category: "Locations",
  },

  { key: "reservations.view", label: "Voir les réservations", category: "Réservations" },
  { key: "reservations.create", label: "Créer des réservations", category: "Réservations" },
  { key: "reservations.edit", label: "Modifier des réservations", category: "Réservations" },
  { key: "reservations.delete", label: "Supprimer des réservations", category: "Réservations" },
  { key: "reservations.import", label: "Importer des réservations (Excel)", category: "Réservations" },
  { key: "reservations.convert", label: "Convertir une réservation en contrat", category: "Réservations" },
  // Sprint 24 : jusqu'ici, confirmer/annuler/marquer No Show une réservation n'étaient pas
  // des actions distinctes — elles passaient toutes par reservations.edit, la même clé que
  // la modification des champs (dates/prix/identité client...). Un groupe accordant
  // reservations.edit pour de simples corrections de champ accordait donc implicitement ces
  // trois actions de statut, sans possibilité de les retirer séparément. Clés dédiées,
  // vérifiées par transition (voir PATCH /api/reservations/[id]/route.ts).
  { key: "reservations.confirm", label: "Confirmer une réservation", category: "Réservations" },
  { key: "reservations.cancel", label: "Annuler une réservation", category: "Réservations" },
  { key: "reservations.no_show", label: "Marquer une réservation No Show", category: "Réservations" },

  { key: "invoices.view", label: "Voir les factures", category: "Factures" },
  { key: "invoices.create", label: "Créer des factures", category: "Factures" },
  { key: "invoices.edit", label: "Modifier des factures", category: "Factures" },
  { key: "invoices.delete", label: "Supprimer des factures", category: "Factures" },
  // Sprint 26E : versionnement documentaire d'une facture SENT sans paiement (voir
  // src/lib/invoices.ts, versionInvoice) — clé dédiée, distincte de invoices.edit (modification
  // des champs d'une facture DRAFT) et invoices.delete (suppression), même patron que
  // payments.correct (Sprint 26D) : une action de statut sensible mérite sa propre clé plutôt
  // que de réutiliser une clé plus générique.
  { key: "invoices.version", label: "Créer une nouvelle version d'une facture", category: "Factures" },

  { key: "payments.view", label: "Voir les paiements", category: "Paiements" },
  { key: "payments.create", label: "Créer des paiements", category: "Paiements" },
  { key: "payments.delete", label: "Supprimer des paiements", category: "Paiements" },
  // Sprint 26D (Finding D1) : payments.correct remplace le détournement historique de
  // payments.create sur PATCH /api/payments/[id] (correction de montant/moyen/date d'un
  // paiement déjà encaissé, avec compensation de caisse) — clé dédiée, plus précise. La route
  // accepte encore payments.create en alternative (voir son commentaire) pour ne retirer
  // silencieusement l'accès à aucun groupe personnalisé existant.
  { key: "payments.correct", label: "Corriger un paiement (montant, moyen, date)", category: "Paiements" },
  // Sprint 26D (Finding D1) : action exceptionnelle — par défaut, le remboursement lié à
  // l'annulation d'un contrat reprend automatiquement le moyen du paiement d'origine
  // (jamais modifiable). Cette clé permet de forcer un autre moyen de remboursement ; non
  // accordée à aucun groupe par défaut (même politique que audit.delete).
  { key: "payments.override_refund_method", label: "Modifier le moyen de remboursement", category: "Paiements" },

  { key: "reports.view", label: "Voir les rapports", category: "Rapports" },
  // Sprint 23 (DOMAINRULES.md section 39) : deux nouveaux onglets de reporting métier —
  // listing de tous les contrats (toutes agences confondues pour un ADMIN) et performance par
  // véhicule. Clés distinctes de reports.view (KPI agrégés) : ce sont des listings détaillés,
  // pas un tableau de bord financier — un tenant peut vouloir accorder l'un sans l'autre.
  { key: "contracts_overview.view", label: "Voir le listing des contrats", category: "Rapports" },
  { key: "vehicle_performance.view", label: "Voir la performance des véhicules", category: "Rapports" },

  { key: "users.view", label: "Voir les utilisateurs", category: "Utilisateurs" },
  { key: "users.create", label: "Créer des utilisateurs", category: "Utilisateurs" },
  { key: "users.edit", label: "Modifier des utilisateurs", category: "Utilisateurs" },
  { key: "users.delete", label: "Supprimer des utilisateurs", category: "Utilisateurs" },

  { key: "invitations.create", label: "Créer des invitations", category: "Invitations" },
  { key: "invitations.revoke", label: "Révoquer des invitations", category: "Invitations" },

  { key: "audit.view", label: "Voir le journal d'audit", category: "Audit" },
  // Sprint 24-1 : suppression du journal d'audit (unité, en masse, purge totale du tenant),
  // strictement réservée ADMIN — voir PATCH /api/audit/[id]/route.ts et le commentaire sur
  // requireAuditDeleteAccess. Contrairement à audit.view (décorative, DOMAINRULES.md section 22
  // — l'accès en lecture reste un contrôle de rôle strict, jamais can()), cette clé est une
  // vraie permission vérifiée : l'accès exige à la fois role === "ADMIN" ET can(user,
  // "audit.delete"). Un ADMIN a par construction toujours cette permission (can() court-circuite
  // sur le rôle avant toute consultation de PermissionGroup/UserPermission, comme pour toutes les
  // autres clés) ; un non-ADMIN qui se la verrait accorder via un groupe personnalisé reste
  // bloqué par la vérification de rôle, qui est évaluée en plus, jamais à la place. N'est
  // accordée à aucun groupe par défaut (DEFAULT_GROUPS ci-dessous) — capacité nouvelle, pas un
  // comportement préexistant à préserver.
  { key: "audit.delete", label: "Supprimer des entrées du journal d'audit", category: "Audit" },

  { key: "maintenances.view", label: "Voir les maintenances", category: "Maintenances" },
  { key: "maintenances.create", label: "Planifier des maintenances", category: "Maintenances" },
  { key: "maintenances.edit", label: "Modifier des maintenances", category: "Maintenances" },
  { key: "maintenances.delete", label: "Supprimer des maintenances", category: "Maintenances" },
  // Sprint 24 : même correctif — Terminer/Annuler une maintenance passaient par
  // maintenances.edit, la même clé que la modification des champs (coût/notes/dates...).
  { key: "maintenances.complete", label: "Terminer une maintenance", category: "Maintenances" },
  { key: "maintenances.cancel", label: "Annuler une maintenance", category: "Maintenances" },

  { key: "alerts.view", label: "Voir les alertes", category: "Alertes" },
  { key: "alerts.acknowledge", label: "Acquitter des alertes", category: "Alertes" },
  { key: "alerts.resolve", label: "Résoudre des alertes", category: "Alertes" },

  { key: "cash_register.view", label: "Voir la caisse", category: "Caisse" },
  { key: "cash_register.create_entry", label: "Enregistrer une entrée de caisse", category: "Caisse" },
  { key: "cash_register.create_expense", label: "Enregistrer une dépense de caisse", category: "Caisse" },
  // Sprint 19 : édition/suppression d'une écriture MANUELLE uniquement (sans lien vers un
  // paiement, voir CashEntry.contractId et src/lib/cash-register.ts) — une écriture issue
  // d'un paiement reste immuable quel que soit le porteur de ces permissions.
  { key: "cash_register.edit", label: "Modifier une écriture de caisse manuelle", category: "Caisse" },
  { key: "cash_register.delete", label: "Supprimer une écriture de caisse manuelle", category: "Caisse" },
  { key: "cash_register.manage_categories", label: "Gérer les catégories de dépense", category: "Caisse" },

  // Sprint 32 (DOMAINRULES.md section 32) : module dégâts — jusqu'ici explicitement reporté
  // (Sprint 19, section 37 point 15 : "aucun code de ce module n'existe"). Damage.status est
  // dérivé automatiquement (Sprint 33 : de l'état de sa DamageInvoice une fois facturé, voir
  // src/lib/damages.ts, applyDamageInvoiceStatus) ; damages.edit ne couvre que
  // nature/description/billableAmount, jamais une fois le dégât facturé (Damage.damageInvoiceId
  // renseigné). Catalogue non attribué par défaut — non ajoutées à DEFAULT_GROUPS/
  // PAST_PERMISSION_BACKFILLS : l'attribution par rôle reste une décision ultérieure du
  // propriétaire du projet, aucun workflow/répartition de responsabilités n'a été validé.
  { key: "damages.view", label: "Voir les dégâts", category: "Dégâts" },
  { key: "damages.create", label: "Déclarer un dégât", category: "Dégâts" },
  { key: "damages.edit", label: "Corriger un dégât (jamais une fois facturé)", category: "Dégâts" },

  // Sprint 33 (DOMAINRULES.md section 48) : facturation séparée des dégâts — remplace
  // damages.payment.create (Sprint 32, retirée : un paiement de dégât n'est plus jamais possible
  // sans DamageInvoice). damage_invoices.create gate la génération automatique d'une facture
  // (au retour ou à la déclaration d'un dégât facturable) — jamais une création manuelle, aucune
  // route ne l'expose comme telle. damage_invoices.export gate spécifiquement le PDF (distincte
  // de .view, décision explicite du propriétaire du projet pour ce module).
  { key: "damage_invoices.view", label: "Voir les factures de dégâts", category: "Dégâts" },
  { key: "damage_invoices.create", label: "Générer une facture de dégâts (au retour/à la déclaration)", category: "Dégâts" },
  { key: "damage_invoices.payment.create", label: "Encaisser un paiement de facture de dégâts", category: "Dégâts" },
  { key: "damage_invoices.export", label: "Télécharger le PDF d'une facture de dégâts", category: "Dégâts" },
  { key: "damage_invoices.cancel", label: "Annuler une facture de dégâts", category: "Dégâts" },

  { key: "vehicle_transfers.view", label: "Voir les transferts de véhicules", category: "Transferts" },
  { key: "vehicle_transfers.create", label: "Lancer un transfert de véhicule", category: "Transferts" },
  { key: "vehicle_transfers.validate", label: "Valider un transfert de véhicule", category: "Transferts" },
  { key: "vehicle_transfers.cancel", label: "Annuler un transfert de véhicule", category: "Transferts" },

  { key: "vehicle_trips.view", label: "Voir les bons de déplacement", category: "Déplacements" },
  { key: "vehicle_trips.create", label: "Créer un bon de déplacement", category: "Déplacements" },
  { key: "vehicle_trips.return", label: "Enregistrer un retour de déplacement", category: "Déplacements" },
  { key: "vehicle_trips.cancel", label: "Annuler un bon de déplacement", category: "Déplacements" },
];

export const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key);

interface DefaultGroupDefinition {
  name: string;
  permissions: string[];
}

/**
 * Groupes de base (spec Sprint 12C section 3), créés automatiquement pour chaque
 * tenant (voir ensureDefaultGroups). Le groupe "ADMIN" est créé pour référence/affichage
 * dans l'UI de gestion des groupes uniquement — un ADMIN (role === "ADMIN") n'a jamais
 * besoin d'y être rattaché, can() court-circuite déjà sur le rôle (voir plus bas).
 */
export const DEFAULT_GROUPS: DefaultGroupDefinition[] = [
  { name: "ADMIN", permissions: PERMISSION_KEYS },
  {
    // Sprint 15 : vehicles.delete/locations.delete/clients.delete/invoices.delete/
    // payments.delete et les modules maintenances/alerts/cash_register/vehicle_transfers/
    // vehicle_trips ont été ajoutés pour préserver le comportement actuel — ces actions
    // étaient possibles sans aucune restriction avant le retrofit des routes (seul
    // canAccessAgency() s'appliquait), les retirer par défaut aurait été une régression
    // fonctionnelle silencieuse, pas un simple resserrement de sécurité.
    name: "MEMBER",
    permissions: [
      "agencies.view",
      "vehicles.view",
      "vehicles.create",
      "vehicles.edit",
      "vehicles.delete",
      "clients.view",
      "clients.create",
      "clients.edit",
      "clients.delete",
      "locations.view",
      "locations.create",
      "locations.edit",
      "locations.delete",
      // Sprint 24 : locations.confirm/activate/complete/cancel désormais distinctes de
      // locations.edit — accordées ici pour préserver le comportement actuel de ce groupe.
      "locations.confirm",
      "locations.activate",
      "locations.complete",
      "locations.cancel",
      "reservations.view",
      "reservations.create",
      "reservations.edit",
      "reservations.import",
      "reservations.convert",
      // Sprint 24 : reservations.confirm/cancel/no_show désormais distinctes de
      // reservations.edit — accordées ici pour préserver le comportement actuel de ce groupe.
      "reservations.confirm",
      "reservations.cancel",
      "reservations.no_show",
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      "invoices.delete",
      // Sprint 26E : ce groupe a déjà invoices.edit/create/delete — invoices.version accordée
      // par défaut pour ne pas retirer silencieusement une capacité de gestion de facturation
      // déjà largement couverte (voir le commentaire sur PERMISSIONS ci-dessus).
      "invoices.version",
      "payments.view",
      "payments.create",
      // Sprint 26D : voir le commentaire sur PERMISSIONS ci-dessus (remplace le détournement
      // historique de payments.create sur la correction de paiement).
      "payments.correct",
      "payments.delete",
      "reports.view",
      // Sprint 23 : deux nouveaux onglets de reporting (listing contrats/performance
      // véhicules) — accordés par défaut comme reports.view, préservant la même largeur
      // d'accès pour ce groupe déjà largement doté.
      "contracts_overview.view",
      "vehicle_performance.view",
      "maintenances.view",
      "maintenances.create",
      "maintenances.edit",
      "maintenances.delete",
      // Sprint 24 : maintenances.complete/cancel désormais distinctes de maintenances.edit —
      // accordées ici pour préserver le comportement actuel de ce groupe.
      "maintenances.complete",
      "maintenances.cancel",
      "alerts.view",
      "alerts.acknowledge",
      "alerts.resolve",
      "cash_register.view",
      "cash_register.create_entry",
      "cash_register.create_expense",
      "cash_register.edit",
      "cash_register.delete",
      "cash_register.manage_categories",
      "vehicle_transfers.view",
      "vehicle_transfers.create",
      "vehicle_transfers.validate",
      "vehicle_transfers.cancel",
      "vehicle_trips.view",
      "vehicle_trips.create",
      "vehicle_trips.return",
      "vehicle_trips.cancel",
    ],
  },
  {
    // Sprint 15 : resserrement assumé (confirmé explicitement avec le propriétaire du
    // projet) — ce groupe reste scopé finance/reporting, sans accès véhicules/locations/
    // clients/maintenances, même si ces actions étaient possibles sans restriction avant
    // le retrofit des routes (cohérent avec la description du rôle "comptabilité").
    name: "COMPTABILITÉ",
    permissions: [
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      "invoices.delete",
      // Sprint 26E : voir le commentaire équivalent sur MEMBER ci-dessus.
      "invoices.version",
      "payments.view",
      "payments.create",
      // Sprint 26D : voir le commentaire équivalent sur MEMBER ci-dessus.
      "payments.correct",
      "payments.delete",
      "reports.view",
      // Sprint 23 : voir le commentaire équivalent sur MEMBER ci-dessus.
      "contracts_overview.view",
      "vehicle_performance.view",
      "reservations.view",
    ],
  },
  {
    // Sprint 15 : maintenances/alerts/vehicle_transfers/vehicle_trips ajoutés (modules
    // opérationnels d'agence, cohérents avec la vocation de ce groupe) ; invoices.view/
    // create/edit et payments.view/create ajoutés pour préserver la capacité de facturer/
    // encaisser un contrat de son agence, déjà possible sans restriction avant le retrofit.
    // Sprint 17 : agencies.view et cash_register.* ajoutés — omis à tort du retrofit Sprint 15
    // (régression réelle : sans agencies.view, GET /api/agencies renvoie 403 pour ce groupe,
    // ce qui vide le sélecteur d'agence de "Créer un véhicule"/"Lancer un transfert"/"Créer une
    // réservation" et empêche de fait toute soumission de ces formulaires malgré des permissions
    // *.create par ailleurs accordées ; cash_register.* était possible sans restriction avant le
    // retrofit, comme pour MEMBER — même principe de préservation du comportement antérieur).
    // Sprint 23 : contracts_overview.view/vehicle_performance.view ajoutés — listings
    // opérationnels utiles au quotidien d'une agence (pas seulement financiers, contrairement à
    // reports.view que ce groupe n'a jamais eu).
    name: "AGENCE",
    permissions: [
      "agencies.view",
      "vehicles.view",
      "vehicles.create",
      "vehicles.edit",
      "vehicles.delete",
      "locations.view",
      "locations.create",
      "locations.edit",
      "locations.delete",
      // Sprint 24 : voir le commentaire équivalent sur MEMBER ci-dessus.
      "locations.confirm",
      "locations.activate",
      "locations.complete",
      "locations.cancel",
      "clients.view",
      "clients.create",
      "clients.edit",
      "clients.delete",
      "reservations.view",
      "reservations.create",
      "reservations.edit",
      "reservations.delete",
      "reservations.convert",
      // Sprint 24 : voir le commentaire équivalent sur MEMBER ci-dessus.
      "reservations.confirm",
      "reservations.cancel",
      "reservations.no_show",
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      // Sprint 26E : voir le commentaire équivalent sur MEMBER ci-dessus.
      "invoices.version",
      "payments.view",
      "payments.create",
      // Sprint 26D : voir le commentaire équivalent sur MEMBER ci-dessus.
      "payments.correct",
      "contracts_overview.view",
      "vehicle_performance.view",
      "maintenances.view",
      "maintenances.create",
      "maintenances.edit",
      "maintenances.delete",
      // Sprint 24 : voir le commentaire équivalent sur MEMBER ci-dessus.
      "maintenances.complete",
      "maintenances.cancel",
      "alerts.view",
      "alerts.acknowledge",
      "alerts.resolve",
      "cash_register.view",
      "cash_register.create_entry",
      "cash_register.create_expense",
      "cash_register.edit",
      "cash_register.delete",
      "cash_register.manage_categories",
      "vehicle_transfers.view",
      "vehicle_transfers.create",
      "vehicle_transfers.validate",
      "vehicle_transfers.cancel",
      "vehicle_trips.view",
      "vehicle_trips.create",
      "vehicle_trips.return",
      "vehicle_trips.cancel",
    ],
  },
];

/**
 * Historique des clés introduites par les retrofits de permissions successifs (Sprint 15 :
 * nouveaux modules maintenances/alerts/cash_register/vehicle_transfers/vehicle_trips, plus
 * les suppressions/factures/paiements ajoutées à MEMBER/AGENCE pour préserver leur
 * comportement d'alors ; Sprint 18 : reservations.import ; Sprint 19 : cash_register.edit/
 * delete). `DEFAULT_GROUPS` ci-dessus inclut déjà ces clés pour tout tenant créé après le
 * sprint qui les a introduites — ce dictionnaire ne sert plus qu'à documenter/rejouer,
 * ponctuellement et manuellement (voir scripts/backfill-permissions.ts et son commentaire),
 * le rattrapage nécessaire pour les tenants déjà existants au moment de chaque sprint.
 *
 * IMPORTANT (correctif Sprint 19, bug réel corrigé) : ce dictionnaire n'est plus jamais
 * invoqué automatiquement par `ensureDefaultGroups` — il l'était auparavant à chaque
 * `GET /api/permission-groups`, ce qui réinjectait silencieusement ces clés précises dans
 * un groupe MEMBER/AGENCE à chaque chargement de la page, même après qu'un ADMIN les ait
 * explicitement décochées (aucun moyen de distinguer « jamais eu cette clé » de « clé
 * retirée intentionnellement »). Un tenant déjà existant au moment d'un sprint qui introduit
 * une nouvelle clé doit désormais être rattrapé une seule fois, explicitement, via le script
 * dédié — jamais de façon récurrente depuis une route consultée par un utilisateur normal.
 */
export const PAST_PERMISSION_BACKFILLS: Record<string, string[]> = {
  MEMBER: [
    // Sprint 18 : reservations.import — gap antérieur à Sprint 15 (jamais accordé à MEMBER
    // depuis la création du module Réservations, Sprint 12C), contredisant DOMAINRULES.md
    // section 22 (« réservations (hors suppression) »). Réutilise ce même mécanisme générique
    // de backfill par union (skipDuplicates), pas seulement les clés nées au Sprint 15.
    "reservations.import",
    "vehicles.delete",
    "clients.delete",
    "locations.delete",
    "invoices.delete",
    "payments.delete",
    // Sprint 26D (Finding D1) : voir le commentaire sur DEFAULT_GROUPS.
    "payments.correct",
    "maintenances.view",
    "maintenances.create",
    "maintenances.edit",
    "maintenances.delete",
    "alerts.view",
    "alerts.acknowledge",
    "alerts.resolve",
    "cash_register.view",
    "cash_register.create_entry",
    "cash_register.create_expense",
    // Sprint 19 : nouvelles clés (édition/suppression d'écriture manuelle, voir
    // src/lib/cash-register.ts) — mêmes groupes que create_entry/create_expense.
    "cash_register.edit",
    "cash_register.delete",
    "cash_register.manage_categories",
    "vehicle_transfers.view",
    "vehicle_transfers.create",
    "vehicle_transfers.validate",
    "vehicle_transfers.cancel",
    "vehicle_trips.view",
    "vehicle_trips.create",
    "vehicle_trips.return",
    "vehicle_trips.cancel",
    // Sprint 23 : deux nouveaux onglets de reporting (voir le commentaire sur DEFAULT_GROUPS).
    "contracts_overview.view",
    "vehicle_performance.view",
    // Sprint 24 : reservations.confirm/cancel/no_show, locations.confirm/activate/complete/
    // cancel, maintenances.complete/cancel — voir le commentaire sur DEFAULT_GROUPS.
    "reservations.confirm",
    "reservations.cancel",
    "reservations.no_show",
    "locations.confirm",
    "locations.activate",
    "locations.complete",
    "locations.cancel",
    "maintenances.complete",
    "maintenances.cancel",
    // Sprint 26E : voir le commentaire sur DEFAULT_GROUPS.
    "invoices.version",
  ],
  AGENCE: [
    // Sprint 17 : agencies.view/cash_register.* — voir le commentaire sur DEFAULT_GROUPS
    // (régression Sprint 15 : ce groupe n'avait jamais reçu ces clés, ni à sa création dans
    // DEFAULT_GROUPS ni dans ce backfill, contrairement à MEMBER qui les avait toutes les deux).
    "agencies.view",
    "cash_register.view",
    "cash_register.create_entry",
    "cash_register.create_expense",
    "cash_register.edit",
    "cash_register.delete",
    "cash_register.manage_categories",
    "invoices.view",
    "invoices.create",
    "invoices.edit",
    "payments.view",
    "payments.create",
    // Sprint 26D (Finding D1) : voir le commentaire sur DEFAULT_GROUPS.
    "payments.correct",
    "maintenances.view",
    "maintenances.create",
    "maintenances.edit",
    "maintenances.delete",
    "alerts.view",
    "alerts.acknowledge",
    "alerts.resolve",
    "vehicle_transfers.view",
    "vehicle_transfers.create",
    "vehicle_transfers.validate",
    "vehicle_transfers.cancel",
    "vehicle_trips.view",
    "vehicle_trips.create",
    "vehicle_trips.return",
    "vehicle_trips.cancel",
    // Sprint 23 : voir le commentaire équivalent sur MEMBER ci-dessus.
    "contracts_overview.view",
    "vehicle_performance.view",
    // Sprint 24 : voir le commentaire équivalent sur MEMBER ci-dessus.
    "reservations.confirm",
    "reservations.cancel",
    "reservations.no_show",
    "locations.confirm",
    "locations.activate",
    "locations.complete",
    "locations.cancel",
    "maintenances.complete",
    "maintenances.cancel",
    // Sprint 26E : voir le commentaire sur DEFAULT_GROUPS.
    "invoices.version",
  ],
  // Sprint 23 : COMPTABILITÉ n'avait jamais eu d'entrée dans ce dictionnaire (resserré, jamais
  // étendu, depuis le Sprint 15) — première extension pour ce groupe.
  // Sprint 26D (Finding D1) : payments.correct — voir le commentaire sur DEFAULT_GROUPS.
  // Sprint 26E : invoices.version — voir le commentaire sur DEFAULT_GROUPS.
  COMPTABILITÉ: ["contracts_overview.view", "vehicle_performance.view", "payments.correct", "invoices.version"],
};

/**
 * Crée les groupes par défaut pour un tenant s'il n'en a aucun encore — idempotent,
 * appelée à l'inscription (nouveaux tenants) et paresseusement depuis les pages de
 * gestion des permissions (création différée pour un tenant existant qui n'aurait
 * jamais eu ces groupes). Ignore silencieusement une violation de contrainte unique
 * (P2002) en cas d'appels concurrents.
 *
 * Correctif Sprint 19 (bug réel corrigé, DOMAINRULES.md section 37) : cette fonction ne
 * touche plus jamais un groupe déjà existant. Avant ce sprint, elle fusionnait en plus
 * (skipDuplicates) les clés de PAST_PERMISSION_BACKFILLS dans les groupes MEMBER/AGENCE déjà
 * présents, à *chaque* appel — donc à chaque `GET /api/permission-groups`. Un ADMIN qui
 * décochait explicitement une de ces clés précises (ex. `cash_register.manage_categories`
 * sur AGENCE) la voyait silencieusement réapparaître au chargement suivant de la page,
 * sans aucun moyen de la retirer durablement : rien ne distingue en base « cette clé n'a
 * jamais été accordée » de « cette clé a été retirée intentionnellement ». Le rattrapage
 * ponctuel nécessaire pour des tenants déjà existants au moment d'un sprint qui introduit
 * une nouvelle clé (ex. cash_register.edit/delete ce sprint) doit désormais être fait une
 * seule fois, explicitement, hors de ce chemin récurrent (voir scripts/backfill-permissions.ts).
 */
export async function ensureDefaultGroups(tenantId: string): Promise<void> {
  const existingGroups = await prisma.permissionGroup.findMany({
    where: { tenantId },
    select: { name: true },
  });
  const existingNames = new Set(existingGroups.map((group) => group.name));

  for (const def of DEFAULT_GROUPS) {
    if (existingNames.has(def.name)) {
      continue;
    }

    try {
      await prisma.permissionGroup.create({
        data: {
          tenantId,
          name: def.name,
          groupPermissions: {
            createMany: { data: def.permissions.map((permissionKey) => ({ permissionKey })) },
          },
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
  }
}

/**
 * Permissions effectives d'un user : union des permissions de son groupe et de ses
 * UserPermission individuelles (additives, jamais de retrait — spec section 3). Un ADMIN
 * a toujours toutes les permissions, sans jamais consulter les tables de permission.
 */
export async function getEffectivePermissions(user: SessionUser): Promise<Set<string>> {
  if (user.role === "ADMIN") {
    return new Set(PERMISSION_KEYS);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      permissionGroupId: true,
      userPermissions: { select: { permissionKey: true } },
    },
  });

  const keys = new Set<string>();
  if (!dbUser) {
    return keys;
  }

  if (dbUser.permissionGroupId) {
    const groupPermissions = await prisma.groupPermission.findMany({
      where: { groupId: dbUser.permissionGroupId },
      select: { permissionKey: true },
    });
    for (const groupPermission of groupPermissions) {
      keys.add(groupPermission.permissionKey);
    }
  } else {
    // Sprint 15 : un MEMBER n'ayant jamais été explicitement rattaché à un groupe (aucun
    // code de l'application ne le fait automatiquement à sa création — invitation acceptée,
    // voir src/lib/invitations.ts) retombe implicitement sur le groupe par défaut "MEMBER"
    // (DEFAULT_GROUPS ci-dessus), plutôt que sur un ensemble vide. Avant le retrofit de ce
    // sprint, l'absence de permission granulaire n'avait aucun effet (seuls role/agence
    // comptaient) ; un MEMBER non assigné se retrouverait sinon totalement bloqué sur tous
    // les modules dès la création de son compte — régression réelle, pas un simple
    // resserrement, et contraire à l'objectif explicite des DEFAULT_GROUPS (préserver le
    // comportement actuel). N'affecte jamais un groupe personnalisé explicitement assigné,
    // même vide (id renseigné) : seule l'absence totale d'assignation retombe ici.
    const memberDefaults = DEFAULT_GROUPS.find((group) => group.name === "MEMBER");
    for (const permissionKey of memberDefaults?.permissions ?? []) {
      keys.add(permissionKey);
    }
  }

  for (const userPermission of dbUser.userPermissions) {
    keys.add(userPermission.permissionKey);
  }

  return keys;
}

export async function can(user: SessionUser, permissionKey: string): Promise<boolean> {
  if (user.role === "ADMIN") {
    return true;
  }

  const keys = await getEffectivePermissions(user);
  return keys.has(permissionKey);
}

export class PermissionGroupNameInUseError extends Error {
  constructor() {
    super("Un groupe de permissions avec ce nom existe déjà.");
    this.name = "PermissionGroupNameInUseError";
  }
}

export class PermissionGroupHasUsersError extends Error {
  constructor() {
    super("Impossible de supprimer un groupe encore assigné à des utilisateurs.");
    this.name = "PermissionGroupHasUsersError";
  }
}

export class InvalidPermissionGroupError extends Error {
  constructor() {
    super("Groupe de permissions introuvable.");
    this.name = "InvalidPermissionGroupError";
  }
}

export interface PermissionGroupWithPermissions {
  id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  permissions: string[];
}

function toGroupWithPermissions(
  group: PermissionGroup & { groupPermissions: GroupPermission[] }
): PermissionGroupWithPermissions {
  return {
    id: group.id,
    tenantId: group.tenantId,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    permissions: group.groupPermissions.map((groupPermission) => groupPermission.permissionKey),
  };
}

export async function getPermissionGroups(tenantId: string): Promise<PermissionGroupWithPermissions[]> {
  const groups = await prisma.permissionGroup.findMany({
    where: { tenantId },
    include: { groupPermissions: true },
    orderBy: { createdAt: "asc" },
  });
  return groups.map(toGroupWithPermissions);
}

export async function getPermissionGroupById(
  tenantId: string,
  groupId: string
): Promise<PermissionGroupWithPermissions | null> {
  const group = await prisma.permissionGroup.findFirst({
    where: { id: groupId, tenantId },
    include: { groupPermissions: true },
  });
  return group ? toGroupWithPermissions(group) : null;
}

export interface CreatePermissionGroupInput {
  tenantId: string;
  name: string;
  permissions: string[];
}

export async function createPermissionGroup(
  data: CreatePermissionGroupInput
): Promise<PermissionGroupWithPermissions> {
  const validKeys = data.permissions.filter((key) => PERMISSION_KEYS.includes(key));

  try {
    const group = await prisma.permissionGroup.create({
      data: {
        tenantId: data.tenantId,
        name: data.name,
        groupPermissions: { createMany: { data: validKeys.map((permissionKey) => ({ permissionKey })) } },
      },
      include: { groupPermissions: true },
    });
    return toGroupWithPermissions(group);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new PermissionGroupNameInUseError();
    }
    throw error;
  }
}

export interface UpdatePermissionGroupInput {
  name?: string;
  permissions?: string[];
}

export async function updatePermissionGroup(
  tenantId: string,
  groupId: string,
  data: UpdatePermissionGroupInput
): Promise<PermissionGroupWithPermissions | null> {
  const existing = await prisma.permissionGroup.findFirst({ where: { id: groupId, tenantId } });
  if (!existing) {
    return null;
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (data.name !== undefined) {
        await tx.permissionGroup.update({ where: { id: groupId }, data: { name: data.name } });
      }
      if (data.permissions !== undefined) {
        const validKeys = data.permissions.filter((key) => PERMISSION_KEYS.includes(key));
        await tx.groupPermission.deleteMany({ where: { groupId } });
        if (validKeys.length > 0) {
          await tx.groupPermission.createMany({
            data: validKeys.map((permissionKey) => ({ groupId, permissionKey })),
          });
        }
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new PermissionGroupNameInUseError();
    }
    throw error;
  }

  return getPermissionGroupById(tenantId, groupId);
}

/** Bloque la suppression tant que des users sont encore rattachés (même principe que
 * ClientHasLocationsError/VehicleHasLocationsError) plutôt que de les faire silencieusement
 * retomber sans permission (permissionGroupId a onDelete: SetNull, techniquement possible,
 * mais retirer silencieusement l'accès d'un user n'est pas souhaitable). */
export async function deletePermissionGroup(tenantId: string, groupId: string): Promise<boolean> {
  const existing = await prisma.permissionGroup.findFirst({ where: { id: groupId, tenantId } });
  if (!existing) {
    return false;
  }

  const userCount = await prisma.user.count({ where: { permissionGroupId: groupId } });
  if (userCount > 0) {
    throw new PermissionGroupHasUsersError();
  }

  await prisma.permissionGroup.delete({ where: { id: groupId } });
  return true;
}

export interface UserPermissionsView {
  userId: string;
  permissionGroupId: string | null;
  groupPermissions: string[];
  individualPermissions: string[];
  effectivePermissions: string[];
}

export async function getUserPermissionsView(
  tenantId: string,
  userId: string
): Promise<UserPermissionsView | null> {
  const dbUser = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: {
      id: true,
      role: true,
      permissionGroupId: true,
      userPermissions: { select: { permissionKey: true } },
    },
  });
  if (!dbUser) {
    return null;
  }

  const groupPermissions = dbUser.permissionGroupId
    ? (
        await prisma.groupPermission.findMany({
          where: { groupId: dbUser.permissionGroupId },
          select: { permissionKey: true },
        })
      ).map((groupPermission) => groupPermission.permissionKey)
    : [];
  const individualPermissions = dbUser.userPermissions.map((userPermission) => userPermission.permissionKey);

  const effectivePermissions =
    dbUser.role === "ADMIN"
      ? PERMISSION_KEYS
      : Array.from(new Set([...groupPermissions, ...individualPermissions]));

  return {
    userId: dbUser.id,
    permissionGroupId: dbUser.permissionGroupId,
    groupPermissions,
    individualPermissions,
    effectivePermissions,
  };
}

export interface SetUserPermissionsInput {
  permissionGroupId?: string | null;
  individualPermissions?: string[];
}

export async function setUserPermissions(
  tenantId: string,
  userId: string,
  data: SetUserPermissionsInput
): Promise<UserPermissionsView | null> {
  const existing = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!existing) {
    return null;
  }

  if (data.permissionGroupId !== undefined && data.permissionGroupId !== null) {
    const group = await prisma.permissionGroup.findFirst({
      where: { id: data.permissionGroupId, tenantId },
    });
    if (!group) {
      throw new InvalidPermissionGroupError();
    }
  }

  await prisma.$transaction(async (tx) => {
    if (data.permissionGroupId !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { permissionGroupId: data.permissionGroupId } });
    }
    if (data.individualPermissions !== undefined) {
      const validKeys = data.individualPermissions.filter((key) => PERMISSION_KEYS.includes(key));
      await tx.userPermission.deleteMany({ where: { userId } });
      if (validKeys.length > 0) {
        await tx.userPermission.createMany({
          data: validKeys.map((permissionKey) => ({ userId, permissionKey })),
        });
      }
    }
  });

  return getUserPermissionsView(tenantId, userId);
}
