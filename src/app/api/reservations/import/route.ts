import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  createReservation,
  parseReservationImportRow,
  getKnownAgencyNames,
  buildAgencyLookupMap,
  RESERVATION_IMPORT_COLUMN_MAP,
  RESERVATION_IMPORT_COLUMNS,
} from "@/lib/reservations";
import { logAction } from "@/lib/audit";

/**
 * Import Excel des réservations (Sprint 12C ; en-têtes en français depuis le Sprint 13B) —
 * .xlsx uniquement, première feuille, première ligne = en-têtes exacts en français (voir
 * RESERVATION_IMPORT_COLUMN_MAP, src/lib/reservations.ts). Chaque ligne est validée
 * indépendamment : les lignes invalides sont rapportées sans bloquer l'import des lignes
 * valides. Une ligne dont le voucherNumber existe déjà pour ce tenant (import précédent ou
 * doublon au sein du même fichier) est comptée comme doublon et non réimportée — pas de
 * fusion, l'énoncé du sprint ne détaille pas de résolution de doublon au niveau réservation
 * (contrairement aux clients, voir DOMAINRULES.md section 9).
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.import"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Corps de requête multipart/form-data invalide." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file est requis." }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "Seuls les fichiers .xlsx sont acceptés." }, { status: 400 });
  }
  // Sprint 16 (audit sécurité) : aucune limite n'existait jusqu'ici — un fichier disproportionné
  // était entièrement bufferisé en mémoire (arrayBuffer) puis parsé (exceljs), consommation
  // CPU/mémoire non bornée. 20 Mo est largement suffisant pour un fichier de réservations broker
  // réaliste (quelques dizaines de milliers de lignes, texte uniquement, pas d'images/macros).
  const MAX_IMPORT_FILE_SIZE = 20 * 1024 * 1024;
  if (file.size > MAX_IMPORT_FILE_SIZE) {
    return NextResponse.json(
      { error: `Le fichier dépasse la taille maximale autorisée (${MAX_IMPORT_FILE_SIZE / (1024 * 1024)} Mo).` },
      { status: 400 }
    );
  }

  // mode=preview : parse/valide sans rien persister (aperçu avant import, voir
  // /dashboard/reservations/import) ; mode=commit (défaut) : persiste réellement.
  const isPreview = formData.get("mode") === "preview";

  const workbook = new ExcelJS.Workbook();
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    // Incompatibilité de type entre le Buffer générique de @types/node (v20+) et la
    // signature non générique attendue par les défs exceljs — même contenu à l'exécution,
    // cast nécessaire (l'API runtime accepte bien un Buffer standard).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch {
    return NextResponse.json({ error: "Fichier .xlsx illisible ou corrompu." }, { status: 400 });
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount < 2) {
    return NextResponse.json({ error: "Le fichier ne contient aucune ligne de données." }, { status: 400 });
  }

  const headerRow = worksheet.getRow(1);
  // Index par nom de CHAMP interne (jamais par en-tête français directement) : ce mapping
  // isole le reste de la route (et parseReservationImportRow) du texte exact des en-têtes.
  const columnIndexByField = new Map<string, number>();
  headerRow.eachCell((cell, colNumber) => {
    const header = String(cell.value ?? "").trim();
    const field = (RESERVATION_IMPORT_COLUMN_MAP as Record<string, string>)[header];
    if (field) {
      columnIndexByField.set(field, colNumber);
    }
  });

  if (columnIndexByField.size === 0) {
    return NextResponse.json(
      { error: `Aucun en-tête reconnu. En-têtes attendus : ${RESERVATION_IMPORT_COLUMNS.join(", ")}.` },
      { status: 400 }
    );
  }

  const existingVouchers = new Set(
    (
      await prisma.reservation.findMany({
        where: { tenantId: user.tenantId },
        select: { voucherNumber: true },
      })
    ).map((r) => r.voucherNumber)
  );

  // Villes/agences connues du tenant (Sprint 14A) — voir parseReservationImportRow, refuse
  // désormais pickupAgency/dropoffAgency qui ne correspond à aucune agence réelle.
  const knownAgencyNames = await getKnownAgencyNames(user.tenantId);
  // Sprint 19 : résolu une seule fois pour tout le fichier plutôt qu'à chaque ligne (voir
  // createReservation, src/lib/reservations.ts).
  const agencyLookup = await buildAgencyLookupMap(user.tenantId);

  const errors: { row: number; error: string }[] = [];
  const duplicates: { row: number; voucherNumber: string }[] = [];
  const preview: { row: number; voucherNumber: string; clientFirstName: string; clientLastName: string; startDate: string; endDate: string }[] = [];
  let imported = 0;
  const PREVIEW_LIMIT = 50;

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    if (row.cellCount === 0 || row.values === undefined) {
      continue;
    }

    const rowObject: Record<string, unknown> = {};
    for (const [field, colIndex] of columnIndexByField) {
      rowObject[field] = row.getCell(colIndex).value;
    }

    if (Object.values(rowObject).every((value) => value === null || value === undefined || value === "")) {
      continue; // ligne vide
    }

    const parsed = parseReservationImportRow(rowObject, knownAgencyNames);
    if ("error" in parsed) {
      errors.push({ row: rowNumber, error: parsed.error });
      continue;
    }

    if (existingVouchers.has(parsed.data.voucherNumber)) {
      duplicates.push({ row: rowNumber, voucherNumber: parsed.data.voucherNumber });
      continue;
    }

    if (isPreview) {
      if (preview.length < PREVIEW_LIMIT) {
        preview.push({
          row: rowNumber,
          voucherNumber: parsed.data.voucherNumber,
          clientFirstName: parsed.data.clientFirstName,
          clientLastName: parsed.data.clientLastName,
          startDate: parsed.data.startDate.toISOString(),
          endDate: parsed.data.endDate.toISOString(),
        });
      }
    } else {
      await createReservation({ tenantId: user.tenantId, ...parsed.data }, agencyLookup);
    }
    existingVouchers.add(parsed.data.voucherNumber);
    imported += 1;
  }

  if (!isPreview) {
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "reservation.imported",
      resource: "Reservation",
      metadata: { fileName: file.name, imported, errorsCount: errors.length, duplicatesCount: duplicates.length },
    });
  }

  return NextResponse.json({ imported, errors, duplicates, preview: isPreview ? preview : undefined });
}
