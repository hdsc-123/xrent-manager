import type { VehicleStatus, LocationStatus, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { canAccessAgency, getAccessibleAgencyIds, type SessionUser } from "@/lib/authz";
import { formatAmountForCsv, formatDateForCsv, formatPercentFromBasisPoints } from "@/lib/csv";
import { MAX_EXPORT_ROWS, VEHICLE_COLUMNS, CLIENT_COLUMNS, LOCATION_COLUMNS, INVOICE_COLUMNS } from "@/lib/export-constants";

export { MAX_EXPORT_ROWS, VEHICLE_COLUMNS, CLIENT_COLUMNS, LOCATION_COLUMNS, INVOICE_COLUMNS };

/**
 * Sprint 13E tâche 3 — registre central de l'export CSV multi-entités. Point de contrôle
 * unique (permission, portée tenant/agence, filtres, plafond de lignes) plutôt que des routes
 * dupliquées par entité, pour ne pas risquer d'oublier un de ces contrôles sur l'une d'elles.
 * Chaque entrée écrit sa propre requête Prisma (aucune des fonctions `getX` existantes
 * — src/lib/vehicles.ts, src/lib/locations.ts, etc. — n'utilise `include`, alors que l'export a
 * besoin de dénormaliser des relations en colonnes CSV ; les modifier aurait un effet de bord sur
 * leurs appelants actuels, hors périmètre de cette tâche).
 */

export class ExportForbiddenError extends Error {
  constructor(message = "Accès refusé.") {
    super(message);
    this.name = "ExportForbiddenError";
  }
}

export class InvalidExportFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExportFilterError";
  }
}

export class ExportTooManyRowsError extends Error {
  constructor() {
    super(
      `Trop de résultats à exporter (plus de ${MAX_EXPORT_ROWS} lignes). Affinez les filtres (période, agence, statut) avant de réessayer.`
    );
    this.name = "ExportTooManyRowsError";
  }
}

export type CsvRow = Record<string, string | number>;

export interface ExportOutcome {
  rows: CsvRow[];
  rowCount: number;
  appliedFilters: Record<string, string>;
}

export interface ExportDefinition {
  label: string;
  /** `AuditLog.resource` utilisé pour journaliser cet export (src/lib/audit.ts). */
  auditResource: string;
  filenamePrefix: string;
  checkAccess: (user: SessionUser) => Promise<boolean>;
  run: (user: SessionUser, searchParams: URLSearchParams) => Promise<ExportOutcome>;
}

/** Uniformise les valeurs nullables en chaîne vide — jamais "null"/"N/A", toujours cohérent. */
function cell(value: string | number | null | undefined): string | number {
  return value === null || value === undefined ? "" : value;
}

function dateCell(value: Date | null | undefined): string {
  return value ? formatDateForCsv(value) : "";
}

function amountCell(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : formatAmountForCsv(value);
}

/**
 * Résout le périmètre agence d'un export, exactement comme les routes GET liste existantes
 * (ex. src/app/api/vehicles/route.ts) : un `agencyId` explicite doit être accessible à
 * l'appelant (403 sinon) et restreint alors la requête à cette seule agence ; à défaut, la
 * requête est restreinte à `getAccessibleAgencyIds()` (`null` = ADMIN, aucune restriction).
 * Appliqué comme clause `where` Prisma réelle (IN-list), pas un post-filtre en mémoire comme
 * certaines routes existantes — équivalent en sécurité, plus correct pour un volume d'export.
 */
async function resolveAgencyScope(
  user: SessionUser,
  explicitAgencyId: string | undefined
): Promise<string[] | null> {
  if (explicitAgencyId) {
    if (!(await canAccessAgency(user, explicitAgencyId))) {
      throw new ExportForbiddenError("Accès refusé à cette agence.");
    }
    return [explicitAgencyId];
  }
  return getAccessibleAgencyIds(user);
}

/**
 * Validation partagée d'un couple de filtres de date optionnels (`from`/`to`), réutilisée par
 * toute entité dont la route GET existante accepte ce couple (locations, factures — mêmes règles
 * qu'ailleurs dans l'application : date invalide refusée, from postérieur à to refusé).
 */
function parseOptionalDateRange(
  fromParam: string | undefined,
  toParam: string | undefined
): { from?: Date; to?: Date } {
  let from: Date | undefined;
  let to: Date | undefined;

  if (fromParam) {
    from = new Date(fromParam);
    if (Number.isNaN(from.getTime())) {
      throw new InvalidExportFilterError("Date de début invalide.");
    }
  }
  if (toParam) {
    to = new Date(toParam);
    if (Number.isNaN(to.getTime())) {
      throw new InvalidExportFilterError("Date de fin invalide.");
    }
  }
  if (from && to && from > to) {
    throw new InvalidExportFilterError("La date de début doit être antérieure ou égale à la date de fin.");
  }

  return { from, to };
}

const VEHICLE_STATUSES: VehicleStatus[] = [
  "AVAILABLE",
  "RENTED",
  "MAINTENANCE",
  "INACTIVE",
  "TRANSFERRING",
  "ON_TRIP",
];

async function runVehiclesExport(user: SessionUser, searchParams: URLSearchParams): Promise<ExportOutcome> {
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const categoryParam = searchParams.get("category") ?? undefined;
  const searchParam = searchParams.get("search") ?? undefined;

  if (statusParam && !VEHICLE_STATUSES.includes(statusParam as VehicleStatus)) {
    throw new InvalidExportFilterError("status invalide.");
  }

  const agencyIds = await resolveAgencyScope(user, agencyIdParam);

  const vehicles = await prisma.vehicle.findMany({
    where: {
      tenantId: user.tenantId,
      ...(agencyIds !== null ? { agencyId: { in: agencyIds } } : {}),
      ...(statusParam ? { status: statusParam as VehicleStatus } : {}),
      ...(categoryParam ? { category: categoryParam } : {}),
      ...(searchParam
        ? {
            OR: [
              { name: { contains: searchParam, mode: "insensitive" as const } },
              { licensePlate: { contains: searchParam, mode: "insensitive" as const } },
              { make: { contains: searchParam, mode: "insensitive" as const } },
              { model: { contains: searchParam, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    include: { agency: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT_ROWS + 1,
  });

  if (vehicles.length > MAX_EXPORT_ROWS) {
    throw new ExportTooManyRowsError();
  }

  const rows: CsvRow[] = vehicles.map((vehicle) => {
    const row: Record<(typeof VEHICLE_COLUMNS)[number], string | number> = {
      agence: vehicle.agency.name,
      nom: vehicle.name,
      immatriculation: vehicle.licensePlate,
      marque: vehicle.make,
      modele: vehicle.model,
      annee: vehicle.year,
      categorie: vehicle.category,
      transmission: cell(vehicle.transmission),
      carburant: cell(vehicle.fuel),
      statut: vehicle.status,
      prixParJour: amountCell(vehicle.pricePerDay),
      devise: vehicle.currency,
      kilometrageActuel: cell(vehicle.currentOdometer),
      niveauCarburantActuel: cell(vehicle.currentFuelLevel),
      assuranceExpiration: dateCell(vehicle.insuranceExpiryDate),
      vignetteExpiration: dateCell(vehicle.vignetteExpiryDate),
      controleTechniqueExpiration: dateCell(vehicle.technicalInspectionExpiryDate),
      prochaineVidangeDate: dateCell(vehicle.nextOilChangeDate),
      prochaineVidangeKm: cell(vehicle.nextOilChangeKm),
      creeLe: formatDateForCsv(vehicle.createdAt),
    };
    return row;
  });

  const appliedFilters: Record<string, string> = {};
  if (agencyIdParam) appliedFilters.agencyId = agencyIdParam;
  if (statusParam) appliedFilters.status = statusParam;
  if (categoryParam) appliedFilters.category = categoryParam;
  if (searchParam) appliedFilters.search = searchParam;

  return { rows, rowCount: rows.length, appliedFilters };
}

/**
 * Clients — src/app/api/clients/route.ts. **Aucune portée agence** : `Client` n'a pas de colonne
 * `agencyId` (décision validée, DOMAINRULES.md section 9 — "un client n'est jamais rattaché à
 * une agence... tout utilisateur du tenant peut consulter... n'importe quel client de son
 * tenant"). N'invente donc pas de filtre `agencyId` ici — le seul filtre réellement supporté par
 * la route existante est `search` (nom/email). `resolveAgencyScope` n'est pas appelé : il
 * n'existe rien à restreindre par agence pour cette entité.
 */
async function runClientsExport(user: SessionUser, searchParams: URLSearchParams): Promise<ExportOutcome> {
  const searchParam = searchParams.get("search") ?? undefined;

  const clients = await prisma.client.findMany({
    where: {
      tenantId: user.tenantId,
      ...(searchParam
        ? {
            OR: [
              { name: { contains: searchParam, mode: "insensitive" as const } },
              { email: { contains: searchParam, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
    take: MAX_EXPORT_ROWS + 1,
  });

  if (clients.length > MAX_EXPORT_ROWS) {
    throw new ExportTooManyRowsError();
  }

  const rows: CsvRow[] = clients.map((client) => {
    const row: Record<(typeof CLIENT_COLUMNS)[number], string | number> = {
      nom: client.name,
      prenom: cell(client.firstName),
      nomFamille: cell(client.lastName),
      email: cell(client.email),
      telephone: cell(client.phone),
      telephoneSecondaire: cell(client.altPhone),
      adresse: cell(client.address),
      ville: cell(client.city),
      pays: cell(client.country),
      typePiece: cell(client.idType),
      numeroPiece: cell(client.idNumber),
      numeroPermis: cell(client.licenseNumber),
      permisExpiration: dateCell(client.licenseExpiryDate),
      dateNaissance: dateCell(client.birthDate),
      creeLe: formatDateForCsv(client.createdAt),
    };
    return row;
  });

  const appliedFilters: Record<string, string> = {};
  if (searchParam) appliedFilters.search = searchParam;

  return { rows, rowCount: rows.length, appliedFilters };
}

const LOCATION_STATUSES: LocationStatus[] = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"];

/**
 * Locations (= "contrats") — src/app/api/locations/route.ts. Portée agence identique à
 * `vehicles` (colonne `agencyId` directe). **Fidélité délibérée** : la route GET liste existante
 * ne restreint la visibilité que par `Location.agencyId` (agence de départ), jamais par
 * `dropoffAgencyId` (agence de retour) — contrairement à `canAccessLocationAgency` (src/lib/
 * authz.ts), utilisée uniquement par les routes de détail/action sur UNE location. Reproduire ce
 * comportement plus large ici serait inventer une visibilité que la liste n'a jamais eue ; ce
 * export reste donc scopé exactement comme `GET /api/locations`.
 */
async function runLocationsExport(user: SessionUser, searchParams: URLSearchParams): Promise<ExportOutcome> {
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const vehicleIdParam = searchParams.get("vehicleId") ?? undefined;
  const clientIdParam = searchParams.get("clientId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !LOCATION_STATUSES.includes(statusParam as LocationStatus)) {
    throw new InvalidExportFilterError("status invalide.");
  }

  const { from, to } = parseOptionalDateRange(fromParam, toParam);
  const agencyIds = await resolveAgencyScope(user, agencyIdParam);

  const locations = await prisma.location.findMany({
    where: {
      tenantId: user.tenantId,
      ...(agencyIds !== null ? { agencyId: { in: agencyIds } } : {}),
      ...(vehicleIdParam ? { vehicleId: vehicleIdParam } : {}),
      ...(clientIdParam ? { clientId: clientIdParam } : {}),
      ...(statusParam ? { status: statusParam as LocationStatus } : {}),
      // Chevauchement de période, identique à getLocations (src/lib/locations.ts).
      ...(from ? { endDate: { gte: from } } : {}),
      ...(to ? { startDate: { lte: to } } : {}),
    },
    include: {
      agency: { select: { name: true } },
      dropoffAgency: { select: { name: true } },
      vehicle: { select: { name: true, licensePlate: true } },
      client: { select: { name: true } },
    },
    orderBy: { startDate: "desc" },
    take: MAX_EXPORT_ROWS + 1,
  });

  if (locations.length > MAX_EXPORT_ROWS) {
    throw new ExportTooManyRowsError();
  }

  const rows: CsvRow[] = locations.map((location) => {
    const row: Record<(typeof LOCATION_COLUMNS)[number], string | number> = {
      numeroContrat: cell(location.contractNumber),
      agence: location.agency.name,
      agenceRetour: location.dropoffAgency?.name ?? "",
      vehicule: location.vehicle.name,
      immatriculationVehicule: location.vehicle.licensePlate,
      client: location.client.name,
      dateDebut: formatDateForCsv(location.startDate),
      dateFin: formatDateForCsv(location.endDate),
      kilometrageDebut: cell(location.startOdometer),
      kilometrageFin: cell(location.endOdometer),
      carburantDebut: cell(location.startFuelLevel),
      carburantFin: cell(location.endFuelLevel),
      statut: location.status,
      prixParJour: amountCell(location.pricePerDay),
      prixTotal: amountCell(location.totalPrice),
      caution: amountCell(location.deposit),
      devise: location.currency,
      dateRetourReelle: dateCell(location.actualReturnAt),
      creeLe: formatDateForCsv(location.createdAt),
    };
    return row;
  });

  const appliedFilters: Record<string, string> = {};
  if (agencyIdParam) appliedFilters.agencyId = agencyIdParam;
  if (vehicleIdParam) appliedFilters.vehicleId = vehicleIdParam;
  if (clientIdParam) appliedFilters.clientId = clientIdParam;
  if (statusParam) appliedFilters.status = statusParam;
  if (fromParam) appliedFilters.from = fromParam;
  if (toParam) appliedFilters.to = toParam;

  return { rows, rowCount: rows.length, appliedFilters };
}

// Sprint 13E tâche 3, sous-phase 2c2-B : CREDIT_NOTE réintégrée à cette liste — obsolète depuis
// 2c1 (createCreditNote, src/lib/invoices.ts), qui rend ce statut réellement atteignable. Filtrer
// un export sur status=CREDIT_NOTE isole désormais les avoirs, sans toucher au comportement par
// défaut (aucun filtre = toutes les factures, inchangé).
const INVOICE_STATUSES: InvoiceStatus[] = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID", "CREDIT_NOTE"];

/**
 * Factures — src/app/api/invoices/route.ts. Portée agence identique à `vehicles`/`locations`
 * (colonne `agencyId` directe sur `Invoice`). `excludeReplaced` existe dans `InvoiceFilters`
 * (src/lib/invoices.ts) mais **n'est jamais exposé comme paramètre de requête par la route
 * existante** — non ajouté ici non plus, pour ne pas exposer un filtre que l'interface actuelle
 * n'applique jamais (règle explicite : ne pas inventer de filtre). Aucune donnée bancaire :
 * `Invoice` ne contient que des montants entiers (centimes) + devise, jamais de numéro de
 * carte/CVV/token (structurellement absent du schéma, SECURITY.md section 9).
 */
async function runInvoicesExport(user: SessionUser, searchParams: URLSearchParams): Promise<ExportOutcome> {
  const statusParam = searchParams.get("status") ?? undefined;
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const clientIdParam = searchParams.get("clientId") ?? undefined;
  const locationIdParam = searchParams.get("locationId") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !INVOICE_STATUSES.includes(statusParam as InvoiceStatus)) {
    throw new InvalidExportFilterError("status invalide.");
  }

  const { from, to } = parseOptionalDateRange(fromParam, toParam);
  const agencyIds = await resolveAgencyScope(user, agencyIdParam);

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: user.tenantId,
      ...(agencyIds !== null ? { agencyId: { in: agencyIds } } : {}),
      ...(statusParam ? { status: statusParam as InvoiceStatus } : {}),
      ...(clientIdParam ? { clientId: clientIdParam } : {}),
      ...(locationIdParam ? { locationId: locationIdParam } : {}),
      // Sur issuedAt, identique à getInvoices (src/lib/invoices.ts).
      ...(from ? { issuedAt: { gte: from } } : {}),
      ...(to ? { issuedAt: { lte: to } } : {}),
    },
    include: {
      agency: { select: { name: true } },
      client: { select: { name: true } },
      location: { select: { contractNumber: true } },
      // Sprint 13E tâche 3, sous-phase 2c2-B : numéro de la facture source d'un avoir (colonne
      // factureOrigine ci-dessous) — null pour toute facture qui n'est pas un CREDIT_NOTE.
      original: { select: { number: true } },
    },
    orderBy: { issuedAt: "desc" },
    take: MAX_EXPORT_ROWS + 1,
  });

  if (invoices.length > MAX_EXPORT_ROWS) {
    throw new ExportTooManyRowsError();
  }

  const rows: CsvRow[] = invoices.map((invoice) => {
    const row: Record<(typeof INVOICE_COLUMNS)[number], string | number> = {
      numero: invoice.number,
      // Sprint 13E tâche 3, sous-phase 2c2-B : type (RENTAL/SUPPLEMENT/EXTENSION/CREDIT_NOTE)
      // rend un avoir identifiable sans ambiguïté — jusqu'ici seul `statut` (CREDIT_NOTE) le
      // distinguait, mélangé sans indication avec les factures ordinaires dans le CSV.
      type: invoice.type,
      statut: invoice.status,
      agence: invoice.agency.name,
      client: invoice.client.name,
      contrat: cell(invoice.location.contractNumber),
      sousTotal: amountCell(invoice.subtotal),
      // taxRate est stocké en points de base (2000 = 20,00 %, TAX_RATE_BASIS dans
      // src/lib/invoices.ts) — converti en pourcentage lisible (2000 -> "20"), jamais la
      // valeur brute (correctif : la première version de cette colonne exportait le point de
      // base tel quel, ce qui aurait affiché "2000" au lieu de "20").
      tauxTVAPourcent: formatPercentFromBasisPoints(invoice.taxRate),
      montantTVA: amountCell(invoice.taxAmount),
      remise: amountCell(invoice.discountAmount),
      montantTotal: amountCell(invoice.totalAmount),
      montantPaye: amountCell(invoice.amountPaid),
      devise: invoice.currency,
      emiseLe: formatDateForCsv(invoice.issuedAt),
      echeance: dateCell(invoice.dueDate),
      version: invoice.versionNumber,
      creeLe: formatDateForCsv(invoice.createdAt),
      // Sprint 13E tâche 3, sous-phase 2c2-B : numéro de facture (jamais l'id technique) de la
      // source d'un avoir — vide pour toute facture qui n'est pas un CREDIT_NOTE.
      factureOrigine: cell(invoice.original?.number),
      motif: cell(invoice.reason),
    };
    return row;
  });

  const appliedFilters: Record<string, string> = {};
  if (agencyIdParam) appliedFilters.agencyId = agencyIdParam;
  if (statusParam) appliedFilters.status = statusParam;
  if (clientIdParam) appliedFilters.clientId = clientIdParam;
  if (locationIdParam) appliedFilters.locationId = locationIdParam;
  if (fromParam) appliedFilters.from = fromParam;
  if (toParam) appliedFilters.to = toParam;

  return { rows, rowCount: rows.length, appliedFilters };
}

export const EXPORT_REGISTRY: Record<string, ExportDefinition> = {
  vehicles: {
    label: "Véhicules",
    auditResource: "Vehicle",
    filenamePrefix: "vehicules",
    checkAccess: (user) => can(user, "vehicles.view"),
    run: runVehiclesExport,
  },
  clients: {
    label: "Clients",
    auditResource: "Client",
    filenamePrefix: "clients",
    checkAccess: (user) => can(user, "clients.view"),
    run: runClientsExport,
  },
  locations: {
    label: "Locations (contrats)",
    auditResource: "Location",
    filenamePrefix: "locations",
    checkAccess: (user) => can(user, "locations.view"),
    run: runLocationsExport,
  },
  invoices: {
    label: "Factures",
    auditResource: "Invoice",
    filenamePrefix: "factures",
    checkAccess: (user) => can(user, "invoices.view"),
    run: runInvoicesExport,
  },
};
