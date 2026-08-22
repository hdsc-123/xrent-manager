import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { logAction } from "@/lib/audit";
import { buildCsvFileContent } from "@/lib/csv";
import { EXPORT_REGISTRY, ExportForbiddenError, InvalidExportFilterError, ExportTooManyRowsError } from "@/lib/exports";

interface RouteParams {
  params: Promise<{ entity: string }>;
}

function todayForFilename(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sprint 13E tâche 3 — point d'entrée unique de l'export CSV, toutes entités confondues (voir
 * src/lib/exports.ts pour le registre). Génération et réponse entièrement synchrones, en
 * mémoire : aucun fichier temporaire, aucun job asynchrone, rien à faire expirer — cohérent
 * avec le reste de l'application (PDF déjà généré ainsi, src/app/api/invoices/[id]/pdf/route.tsx).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { entity } = await params;
  const definition = EXPORT_REGISTRY[entity];
  if (!definition) {
    return NextResponse.json({ error: "Section d'export inconnue." }, { status: 404 });
  }

  if (!(await definition.checkAccess(user))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);

  let outcome;
  try {
    outcome = await definition.run(user, searchParams);
  } catch (error) {
    if (error instanceof InvalidExportFilterError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ExportForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ExportTooManyRowsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Audité uniquement en cas de succès réel (même politique que le reste de l'application —
  // logAction n'est appelé nulle part sur un refus/échec) : jamais le contenu du fichier, jamais
  // de donnée métier brute, seulement ce qui est sorti (entité, filtres, nombre de lignes).
  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "export.csv",
    resource: definition.auditResource,
    metadata: {
      entity,
      filters: outcome.appliedFilters,
      rowCount: outcome.rowCount,
    },
  });

  const csv = buildCsvFileContent(outcome.rows);
  const filename = `${definition.filenamePrefix}-${todayForFilename()}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
