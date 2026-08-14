import type { Alert } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAlert } from "@/lib/alerts";
import { formatMoney } from "@/lib/format";
import { getVehicleLastKnownState } from "@/lib/vehicles";

/**
 * Nombre de jours par défaut pour anticiper une maintenance à venir (checkDueMaintenances).
 * Pas encore configurable par tenant — voir HANDOFF.md section 8 (À DÉCIDER).
 */
const DEFAULT_MAINTENANCE_LOOKAHEAD_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Évite de recréer une alerte à chaque exécution pour la même ressource : une alerte
 * non résolue (PENDING/ACKNOWLEDGED) déjà ouverte pour ce couple entityType/entityId
 * suffit, tant qu'elle n'a pas été résolue.
 */
async function hasUnresolvedAlert(tenantId: string, entityType: string, entityId: string): Promise<boolean> {
  const existing = await prisma.alert.findFirst({
    where: { tenantId, entityType, entityId, status: { in: ["PENDING", "ACKNOWLEDGED"] } },
  });
  return existing !== null;
}

/**
 * Crée une alerte MAINTENANCE_DUE pour chaque maintenance SCHEDULED dont la date prévue
 * tombe dans les `daysAhead` prochains jours (ou est déjà dépassée), scopé à un tenant —
 * aucun rôle "superadmin" transverse n'existe (HANDOFF.md section 8 point 16), donc ce
 * scan reste par tenant plutôt qu'un cron global multi-tenant.
 */
export async function checkDueMaintenances(
  tenantId: string,
  daysAhead: number = DEFAULT_MAINTENANCE_LOOKAHEAD_DAYS
): Promise<Alert[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() + daysAhead * ONE_DAY_MS);

  const dueMaintenances = await prisma.maintenance.findMany({
    where: { tenantId, status: "SCHEDULED", scheduledDate: { lte: threshold } },
    include: { vehicle: { select: { name: true, licensePlate: true } } },
    orderBy: { scheduledDate: "asc" },
  });

  const created: Alert[] = [];
  for (const maintenance of dueMaintenances) {
    if (await hasUnresolvedAlert(tenantId, "Maintenance", maintenance.id)) {
      continue;
    }

    const overdue = maintenance.scheduledDate.getTime() <= now.getTime();
    const priority = overdue
      ? "URGENT"
      : maintenance.scheduledDate.getTime() - now.getTime() <= 2 * ONE_DAY_MS
        ? "HIGH"
        : "MEDIUM";

    const alert = await createAlert({
      tenantId,
      agencyId: maintenance.agencyId,
      type: "MAINTENANCE_DUE",
      priority,
      message: `Maintenance ${overdue ? "en retard" : "à venir"} pour ${maintenance.vehicle.name} (${maintenance.vehicle.licensePlate}) — prévue le ${maintenance.scheduledDate.toLocaleDateString("fr-FR")}.`,
      entityType: "Maintenance",
      entityId: maintenance.id,
    });
    created.push(alert);
  }

  return created;
}

/** Crée une alerte RETURN_TODAY pour chaque location ACTIVE dont la fin est aujourd'hui. */
export async function checkReturnsToday(tenantId: string): Promise<Alert[]> {
  const now = new Date();

  const locationsToday = await prisma.location.findMany({
    where: { tenantId, status: "ACTIVE", endDate: { gte: startOfDay(now), lte: endOfDay(now) } },
    include: {
      vehicle: { select: { name: true, licensePlate: true } },
      client: { select: { name: true } },
    },
  });

  const created: Alert[] = [];
  for (const location of locationsToday) {
    if (await hasUnresolvedAlert(tenantId, "Location", location.id)) {
      continue;
    }

    const alert = await createAlert({
      tenantId,
      agencyId: location.agencyId,
      type: "RETURN_TODAY",
      priority: "MEDIUM",
      message: `Retour prévu aujourd'hui : ${location.vehicle.name} (${location.vehicle.licensePlate}) — client ${location.client.name}.`,
      entityType: "Location",
      entityId: location.id,
    });
    created.push(alert);
  }

  return created;
}

/** Crée une alerte INVOICE_OVERDUE pour chaque facture SENT/PARTIALLY_PAID dont l'échéance est dépassée. */
export async function checkOverdueInvoices(tenantId: string): Promise<Alert[]> {
  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      status: { in: ["SENT", "PARTIALLY_PAID"] },
      dueDate: { lt: new Date() },
    },
  });

  const created: Alert[] = [];
  for (const invoice of overdueInvoices) {
    if (await hasUnresolvedAlert(tenantId, "Invoice", invoice.id)) {
      continue;
    }

    const remaining = invoice.totalAmount - invoice.amountPaid;
    const alert = await createAlert({
      tenantId,
      agencyId: invoice.agencyId,
      type: "INVOICE_OVERDUE",
      priority: "HIGH",
      message: `Facture ${invoice.number} en retard de paiement — solde restant ${formatMoney(remaining, invoice.currency)}.`,
      entityType: "Invoice",
      entityId: invoice.id,
    });
    created.push(alert);
  }

  return created;
}

/**
 * Six vérifications ajoutées Sprint 14C (DOMAINRULES.md section 30) pour rendre l'onglet
 * Alertes réellement utile au quotidien. Chaque fonction utilise un `entityType` distinct de
 * ceux déjà utilisés par les vérifications ci-dessus (`Location`/`Invoice`/`Maintenance`) même
 * quand elle porte sur le même type de ressource métier (ex. "LocationAtRisk" plutôt que
 * "Location") — hasUnresolvedAlert() ne distingue pas par AlertType, seulement par
 * entityType+entityId : réutiliser un entityType déjà pris par une autre vérification
 * empêcherait les deux alertes de coexister sur la même ressource alors qu'elles signalent des
 * situations différentes et toutes deux actionnables.
 */
const CONTRACT_AT_RISK_LOOKAHEAD_DAYS = 2;
const VEHICLE_UNAVAILABLE_STUCK_DAYS = 3;

function startOfToday(): Date {
  return startOfDay(new Date());
}

/** ACTIVE dont le retour approche (ou est déjà dépassé) alors que la facture n'est pas soldée —
 * risque financier distinct d'un simple retour du jour (RETURN_TODAY) ou d'une échéance dépassée
 * (INVOICE_OVERDUE, qui exige un dueDate renseigné et dépassé — beaucoup de factures n'en ont
 * pas, voir Invoice.dueDate optionnel). */
export async function checkContractsAtRisk(tenantId: string): Promise<Alert[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() + CONTRACT_AT_RISK_LOOKAHEAD_DAYS * ONE_DAY_MS);

  const atRiskLocations = await prisma.location.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      endDate: { lte: threshold },
      invoices: { some: { status: { in: ["SENT", "PARTIALLY_PAID"] } } },
    },
    include: {
      vehicle: { select: { name: true, licensePlate: true } },
      client: { select: { name: true } },
      invoices: { where: { status: { in: ["SENT", "PARTIALLY_PAID"] } }, take: 1 },
    },
  });

  const created: Alert[] = [];
  for (const location of atRiskLocations) {
    if (await hasUnresolvedAlert(tenantId, "LocationAtRisk", location.id)) {
      continue;
    }

    const invoice = location.invoices[0];
    const remaining = invoice.totalAmount - invoice.amountPaid;
    const overdue = location.endDate.getTime() <= now.getTime();
    const alert = await createAlert({
      tenantId,
      agencyId: location.agencyId,
      type: "CONTRACT_AT_RISK",
      priority: overdue ? "URGENT" : "HIGH",
      message: `Contrat à risque : ${location.vehicle.name} (${location.vehicle.licensePlate}), client ${location.client.name} — retour ${overdue ? "dépassé" : "proche"} avec ${formatMoney(remaining, invoice.currency)} restant dû.`,
      entityType: "LocationAtRisk",
      entityId: location.id,
    });
    created.push(alert);
  }

  return created;
}

/** Location COMPLETED (contrat terminé) dont la facture reste SENT/PARTIALLY_PAID, sans égard à
 * un éventuel dueDate — comble le cas fréquent où Invoice.dueDate n'est pas renseigné (optionnel,
 * voir DOMAINRULES.md section 17), donc jamais couvert par INVOICE_OVERDUE. */
export async function checkPaymentsDue(tenantId: string): Promise<Alert[]> {
  const completedWithBalance = await prisma.location.findMany({
    where: { tenantId, status: "COMPLETED", invoices: { some: { status: { in: ["SENT", "PARTIALLY_PAID"] } } } },
    include: {
      vehicle: { select: { name: true, licensePlate: true } },
      client: { select: { name: true } },
      invoices: { where: { status: { in: ["SENT", "PARTIALLY_PAID"] } }, take: 1 },
    },
  });

  const created: Alert[] = [];
  for (const location of completedWithBalance) {
    const invoice = location.invoices[0];
    if (await hasUnresolvedAlert(tenantId, "InvoicePaymentDue", invoice.id)) {
      continue;
    }

    const remaining = invoice.totalAmount - invoice.amountPaid;
    const alert = await createAlert({
      tenantId,
      agencyId: location.agencyId,
      type: "PAYMENT_DUE",
      priority: "MEDIUM",
      message: `Paiement restant dû : contrat terminé ${location.vehicle.name} (${location.vehicle.licensePlate}), client ${location.client.name} — ${formatMoney(remaining, invoice.currency)} restant.`,
      entityType: "InvoicePaymentDue",
      entityId: invoice.id,
    });
    created.push(alert);
  }

  return created;
}

/** Véhicule bloqué (MAINTENANCE/TRANSFERRING/ON_TRIP) depuis plus de
 * VEHICLE_UNAVAILABLE_STUCK_DAYS jours sans résolution — signale un blocage opérationnel réel
 * (INACTIVE est un choix délibéré du staff, exclu de cette vérification). */
export async function checkVehiclesUnavailable(tenantId: string): Promise<Alert[]> {
  const threshold = new Date(Date.now() - VEHICLE_UNAVAILABLE_STUCK_DAYS * ONE_DAY_MS);

  const stuckVehicles = await prisma.vehicle.findMany({
    where: { tenantId, status: { in: ["MAINTENANCE", "TRANSFERRING", "ON_TRIP"] }, updatedAt: { lte: threshold } },
  });

  const created: Alert[] = [];
  for (const vehicle of stuckVehicles) {
    if (await hasUnresolvedAlert(tenantId, "VehicleUnavailable", vehicle.id)) {
      continue;
    }

    const alert = await createAlert({
      tenantId,
      agencyId: vehicle.agencyId,
      type: "VEHICLE_UNAVAILABLE",
      priority: "HIGH",
      message: `Véhicule indisponible depuis plus de ${VEHICLE_UNAVAILABLE_STUCK_DAYS} jours : ${vehicle.name} (${vehicle.licensePlate}) — statut ${vehicle.status}.`,
      entityType: "VehicleUnavailable",
      entityId: vehicle.id,
    });
    created.push(alert);
  }

  return created;
}

/** ACTIVE dont la date de retour est déjà dépassée (pas seulement "aujourd'hui", voir
 * checkReturnsToday) — un vrai retard, jamais généré tant que checkReturnsToday n'a pas laissé
 * passer le jour même. */
export async function checkOverdueReturns(tenantId: string): Promise<Alert[]> {
  const overdueLocations = await prisma.location.findMany({
    where: { tenantId, status: "ACTIVE", endDate: { lt: startOfToday() } },
    include: {
      vehicle: { select: { name: true, licensePlate: true } },
      client: { select: { name: true } },
    },
  });

  const created: Alert[] = [];
  for (const location of overdueLocations) {
    if (await hasUnresolvedAlert(tenantId, "LocationOverdueReturn", location.id)) {
      continue;
    }

    const alert = await createAlert({
      tenantId,
      agencyId: location.agencyId,
      type: "RETURN_OVERDUE",
      priority: "URGENT",
      message: `Retour en retard : ${location.vehicle.name} (${location.vehicle.licensePlate}) — client ${location.client.name}, prévu le ${location.endDate.toLocaleDateString("fr-FR")}.`,
      entityType: "LocationOverdueReturn",
      entityId: location.id,
    });
    created.push(alert);
  }

  return created;
}

/** Client dont le permis est expiré alors qu'il a une location PENDING/CONFIRMED/ACTIVE en
 * cours — utile pour anticiper un refus de prise en charge ou un contrôle routier. */
export async function checkExpiredDocuments(tenantId: string): Promise<Alert[]> {
  const now = new Date();

  const clientsWithExpiredLicense = await prisma.client.findMany({
    where: {
      tenantId,
      licenseExpiryDate: { lt: now },
      locations: { some: { status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] } } },
    },
    include: { locations: { where: { status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] } }, take: 1 } },
  });

  const created: Alert[] = [];
  for (const client of clientsWithExpiredLicense) {
    if (await hasUnresolvedAlert(tenantId, "ClientExpiredDocument", client.id)) {
      continue;
    }

    const location = client.locations[0];
    const alert = await createAlert({
      tenantId,
      agencyId: location?.agencyId,
      type: "DOCUMENT_EXPIRED",
      priority: "HIGH",
      message: `Permis expiré : ${client.name} — a une location en cours/à venir alors que son permis a expiré le ${client.licenseExpiryDate!.toLocaleDateString("fr-FR")}.`,
      entityType: "ClientExpiredDocument",
      entityId: client.id,
    });
    created.push(alert);
  }

  return created;
}

/** Incohérence entre Vehicle.status (champ manuel, DOMAINRULES.md section 5) et la réalité des
 * locations : AVAILABLE avec une location ACTIVE en cours, ou RENTED sans aucune location
 * ACTIVE — signale une désynchronisation à corriger manuellement (aucune correction
 * automatique : voir la même prudence documentée pour deleteUser/Alert.userId). */
export async function checkStockInconsistencies(tenantId: string): Promise<Alert[]> {
  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, status: { in: ["AVAILABLE", "RENTED"] } },
    include: { locations: { where: { status: "ACTIVE" }, take: 1 } },
  });

  const created: Alert[] = [];
  for (const vehicle of vehicles) {
    const hasActiveLocation = vehicle.locations.length > 0;
    const inconsistent =
      (vehicle.status === "AVAILABLE" && hasActiveLocation) || (vehicle.status === "RENTED" && !hasActiveLocation);
    if (!inconsistent) {
      continue;
    }
    if (await hasUnresolvedAlert(tenantId, "VehicleStockInconsistency", vehicle.id)) {
      continue;
    }

    const detail =
      vehicle.status === "AVAILABLE"
        ? "marqué Disponible alors qu'une location est ACTIVE"
        : "marqué Loué alors qu'aucune location n'est ACTIVE";
    const alert = await createAlert({
      tenantId,
      agencyId: vehicle.agencyId,
      type: "STOCK_INCONSISTENCY",
      priority: "MEDIUM",
      message: `Incohérence de stock : ${vehicle.name} (${vehicle.licensePlate}) ${detail}.`,
      entityType: "VehicleStockInconsistency",
      entityId: vehicle.id,
    });
    created.push(alert);
  }

  return created;
}

/**
 * Sprint 19 (DOMAINRULES.md section 37) : quatre vérifications proactives fondées sur les
 * nouveaux champs `Vehicle` (insuranceExpiryDate/vignetteExpiryDate/
 * technicalInspectionExpiryDate/nextOilChangeDate/nextOilChangeKm) — tous optionnels, jamais
 * renseignés rétroactivement (même principe que pricePerDay, Sprint 14A) : un véhicule sans
 * ces champs ne génère simplement aucune alerte, aucune valeur inventée. Fenêtre d'anticipation
 * commune aux échéances documentaires (30 jours, cohérente avec DOCUMENT_EXPIRED déjà existant
 * pour le permis client). entityType distinct de chaque vérification existante, même principe
 * que les six vérifications Sprint 14C ci-dessus.
 */
const DOCUMENT_EXPIRY_LOOKAHEAD_DAYS = 30;
/** Marge kilométrique (Sprint 19) avant le seuil nextOilChangeKm pour déclencher l'alerte —
 * évite d'attendre le kilomètre exact (le véhicule peut ne pas repasser par un module de
 * mobilité avant de le dépasser réellement). */
const OIL_CHANGE_KM_LOOKAHEAD = 500;

/** Assurance expirant dans les DOCUMENT_EXPIRY_LOOKAHEAD_DAYS prochains jours, ou déjà expirée
 * — Vehicle.insuranceExpiryDate. */
export async function checkInsuranceExpiring(tenantId: string): Promise<Alert[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() + DOCUMENT_EXPIRY_LOOKAHEAD_DAYS * ONE_DAY_MS);

  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, insuranceExpiryDate: { lte: threshold } },
  });

  const created: Alert[] = [];
  for (const vehicle of vehicles) {
    if (await hasUnresolvedAlert(tenantId, "VehicleInsuranceExpiring", vehicle.id)) {
      continue;
    }

    const overdue = vehicle.insuranceExpiryDate!.getTime() <= now.getTime();
    const alert = await createAlert({
      tenantId,
      agencyId: vehicle.agencyId,
      type: "INSURANCE_EXPIRING",
      priority: overdue ? "URGENT" : "HIGH",
      message: `Assurance ${overdue ? "expirée" : "à renouveler"} : ${vehicle.name} (${vehicle.licensePlate}) — ${overdue ? "expirée" : "expire"} le ${vehicle.insuranceExpiryDate!.toLocaleDateString("fr-FR")}.`,
      entityType: "VehicleInsuranceExpiring",
      entityId: vehicle.id,
    });
    created.push(alert);
  }

  return created;
}

/** Vignette (taxe annuelle) expirant dans les DOCUMENT_EXPIRY_LOOKAHEAD_DAYS prochains jours,
 * ou déjà expirée — Vehicle.vignetteExpiryDate. */
export async function checkVignetteExpiring(tenantId: string): Promise<Alert[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() + DOCUMENT_EXPIRY_LOOKAHEAD_DAYS * ONE_DAY_MS);

  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, vignetteExpiryDate: { lte: threshold } },
  });

  const created: Alert[] = [];
  for (const vehicle of vehicles) {
    if (await hasUnresolvedAlert(tenantId, "VehicleVignetteExpiring", vehicle.id)) {
      continue;
    }

    const overdue = vehicle.vignetteExpiryDate!.getTime() <= now.getTime();
    const alert = await createAlert({
      tenantId,
      agencyId: vehicle.agencyId,
      type: "VIGNETTE_EXPIRING",
      priority: overdue ? "URGENT" : "HIGH",
      message: `Vignette ${overdue ? "expirée" : "à renouveler"} : ${vehicle.name} (${vehicle.licensePlate}) — ${overdue ? "expirée" : "expire"} le ${vehicle.vignetteExpiryDate!.toLocaleDateString("fr-FR")}.`,
      entityType: "VehicleVignetteExpiring",
      entityId: vehicle.id,
    });
    created.push(alert);
  }

  return created;
}

/** Visite/contrôle technique arrivant à échéance dans les DOCUMENT_EXPIRY_LOOKAHEAD_DAYS
 * prochains jours, ou déjà dépassée — Vehicle.technicalInspectionExpiryDate. Distinct du type
 * de Maintenance "INSPECTION" (MAINTENANCE_DUE) : ce champ suit l'échéance réglementaire du
 * véhicule lui-même, pas une intervention planifiée manuellement. */
export async function checkTechnicalInspectionDue(tenantId: string): Promise<Alert[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() + DOCUMENT_EXPIRY_LOOKAHEAD_DAYS * ONE_DAY_MS);

  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, technicalInspectionExpiryDate: { lte: threshold } },
  });

  const created: Alert[] = [];
  for (const vehicle of vehicles) {
    if (await hasUnresolvedAlert(tenantId, "VehicleTechnicalInspectionDue", vehicle.id)) {
      continue;
    }

    const overdue = vehicle.technicalInspectionExpiryDate!.getTime() <= now.getTime();
    const alert = await createAlert({
      tenantId,
      agencyId: vehicle.agencyId,
      type: "TECHNICAL_INSPECTION_DUE",
      priority: overdue ? "URGENT" : "HIGH",
      message: `Contrôle technique ${overdue ? "dépassé" : "à prévoir"} : ${vehicle.name} (${vehicle.licensePlate}) — ${overdue ? "échéance dépassée le" : "échéance"} ${vehicle.technicalInspectionExpiryDate!.toLocaleDateString("fr-FR")}.`,
      entityType: "VehicleTechnicalInspectionDue",
      entityId: vehicle.id,
    });
    created.push(alert);
  }

  return created;
}

/** Vidange à prévoir — soit par date (nextOilChangeDate, même fenêtre que les autres échéances
 * documentaires), soit par kilométrage (nextOilChangeKm comparé au dernier kilométrage connu du
 * véhicule, voir getVehicleLastKnownState, src/lib/vehicles.ts — la même donnée que le
 * pré-remplissage des transferts/bons de déplacement, Sprint 19). Un véhicule sans historique de
 * retour (odometer null) n'est jamais évalué sur le critère kilométrage, faute de donnée. */
export async function checkOilChangeDue(tenantId: string): Promise<Alert[]> {
  const now = new Date();
  const dateThreshold = new Date(now.getTime() + DOCUMENT_EXPIRY_LOOKAHEAD_DAYS * ONE_DAY_MS);

  const vehicles = await prisma.vehicle.findMany({
    where: {
      tenantId,
      OR: [{ nextOilChangeDate: { lte: dateThreshold } }, { nextOilChangeKm: { not: null } }],
    },
  });

  const created: Alert[] = [];
  for (const vehicle of vehicles) {
    let detail: string | null = null;

    if (vehicle.nextOilChangeDate && vehicle.nextOilChangeDate.getTime() <= dateThreshold.getTime()) {
      const overdue = vehicle.nextOilChangeDate.getTime() <= now.getTime();
      detail = `échéance ${overdue ? "dépassée" : "prévue"} le ${vehicle.nextOilChangeDate.toLocaleDateString("fr-FR")}`;
    }

    if (!detail && vehicle.nextOilChangeKm !== null) {
      const { odometer } = await getVehicleLastKnownState(tenantId, vehicle.id);
      if (odometer !== null && odometer >= vehicle.nextOilChangeKm - OIL_CHANGE_KM_LOOKAHEAD) {
        detail = `kilométrage actuel ${odometer} km, seuil ${vehicle.nextOilChangeKm} km`;
      }
    }

    if (!detail) {
      continue;
    }
    if (await hasUnresolvedAlert(tenantId, "VehicleOilChangeDue", vehicle.id)) {
      continue;
    }

    const alert = await createAlert({
      tenantId,
      agencyId: vehicle.agencyId,
      type: "OIL_CHANGE_DUE",
      priority: "MEDIUM",
      message: `Vidange à prévoir : ${vehicle.name} (${vehicle.licensePlate}) — ${detail}.`,
      entityType: "VehicleOilChangeDue",
      entityId: vehicle.id,
    });
    created.push(alert);
  }

  return created;
}

/**
 * Sprint 22 : déclenchement automatique des treize vérifications, jusqu'ici seulement
 * accessible via POST /api/tasks/check-alerts (réservé ADMIN) — bug racine trouvé en
 * revue : aucune UI n'appelle jamais cette route (seuls les tests l'exercent), donc les
 * alertes documentaires/d'échéances (assurance, vignette, contrôle technique, vidange,
 * contrats à risque...) ne "réapparaissent" jamais réellement en usage normal, faute d'un
 * déclencheur. Appelée depuis src/app/dashboard/layout.tsx (chargé sur toute page du
 * dashboard, tout rôle confondu), best-effort — une erreur ici ne doit jamais casser le
 * rendu du dashboard.
 *
 * Throttlée via `Tenant.lastAlertCheckAt` (Sprint 23, DOMAINRULES.md section 39 — remplace le
 * verrou en mémoire de process du Sprint 22, dont la limite multi-instance était déjà
 * documentée) : au plus une exécution complète par tenant toutes les ALERT_CHECK_THROTTLE_MS
 * millisecondes, garantie par une seule instruction `UPDATE ... WHERE` atomique côté Postgres
 * (`prisma.tenant.updateMany`, ci-dessous) plutôt qu'un `Map` local — deux instances (ou deux
 * requêtes quasi simultanées sur la même instance) ne peuvent jamais toutes deux obtenir
 * `count === 1` pour la même fenêtre, la seconde sort immédiatement (`count === 0`). Reste un
 * best-effort au sens où les treize vérifications elles-mêmes ne sont pas transactionnelles
 * entre elles une fois la garde acquise — acceptable, chacune est déjà idempotente
 * (`hasUnresolvedAlert` déduplique), même limite déjà documentée pour le verrou de reset de
 * données (`src/lib/data-reset.ts`, DOMAINRULES.md section 31).
 */
const ALERT_CHECK_THROTTLE_MS = 60 * 60 * 1000;

export async function maybeRunScheduledAlertChecks(tenantId: string): Promise<void> {
  const cutoff = new Date(Date.now() - ALERT_CHECK_THROTTLE_MS);
  const claimed = await prisma.tenant.updateMany({
    where: { id: tenantId, OR: [{ lastAlertCheckAt: null }, { lastAlertCheckAt: { lt: cutoff } }] },
    data: { lastAlertCheckAt: new Date() },
  });
  if (claimed.count === 0) {
    return;
  }

  try {
    await Promise.all([
      checkDueMaintenances(tenantId),
      checkReturnsToday(tenantId),
      checkOverdueInvoices(tenantId),
      checkContractsAtRisk(tenantId),
      checkPaymentsDue(tenantId),
      checkVehiclesUnavailable(tenantId),
      checkOverdueReturns(tenantId),
      checkExpiredDocuments(tenantId),
      checkStockInconsistencies(tenantId),
      checkInsuranceExpiring(tenantId),
      checkVignetteExpiring(tenantId),
      checkTechnicalInspectionDue(tenantId),
      checkOilChangeDue(tenantId),
    ]);
  } catch (error) {
    console.error("Erreur lors de la génération automatique des alertes :", error);
  }
}
