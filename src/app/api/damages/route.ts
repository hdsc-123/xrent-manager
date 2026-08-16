import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { prisma } from "@/lib/prisma";
import { createDamage, getDamages, InvalidDamageAmountError, InvalidDamageNatureError } from "@/lib/damages";
import {
  createDamageInvoice,
  DamageAlreadyInvoicedError,
  DamageLocationMismatchError,
  DamageNotBillableError,
} from "@/lib/damage-invoices";
import { logAction } from "@/lib/audit";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — consultation/déclaration de dégâts hors du flux de
 * retour (voir POST /api/locations/[id]/return pour la création intégrée au retour). Toute la
 * logique métier reste dans src/lib/damages.ts (createDamage/getDamages) — cette route ne fait
 * que l'authentification/les permissions/la portée agence et le typage du corps de requête.
 *
 * Sprint 33 (DOMAINRULES.md section 48) : un dégât facturable (billableAmount > 0) déclaré ici
 * génère désormais automatiquement sa propre DamageInvoice (une ligne) dans la même transaction
 * — cohérent avec la règle "un dégât facturable ne doit jamais être payable sans DamageInvoice",
 * qui s'applique aussi bien au flux de retour qu'à une déclaration hors retour.
 */

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damages.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const vehicleId = searchParams.get("vehicleId") ?? undefined;
  const locationId = searchParams.get("locationId") ?? undefined;

  // Un dégât n'a pas d'agencyId propre (voir prisma/schema.prisma, model Damage) : la portée
  // agence est toujours vérifiée via le véhicule ou le contrat explicitement demandé — jamais
  // un listing global non scopé, qui exigerait de dériver l'agence de chaque dégât un par un.
  if (!vehicleId && !locationId) {
    return NextResponse.json({ error: "vehicleId ou locationId est requis." }, { status: 400 });
  }

  if (vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, tenantId: user.tenantId } });
    if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
      return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
    }
  }

  if (locationId) {
    const location = await getLocationById(user.tenantId, locationId);
    if (!location || !(await canAccessLocationAgency(user, location))) {
      return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
    }
  }

  const damages = await getDamages(user.tenantId, { vehicleId, locationId });
  return NextResponse.json({ damages });
}

interface CreateDamageBody {
  locationId?: string;
  nature?: string;
  description?: string;
  billableAmount?: number | null;
}

/**
 * locationId est le seul identifiant de contrat accepté ici — vehicleId n'est jamais un champ
 * de corps de requête (toujours dérivé côté serveur de la Location, même principe que
 * POST /api/locations/[id]/return : "le véhicule correspond au contrat" par construction).
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damages.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateDamageBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.locationId) {
    return NextResponse.json({ error: "locationId est requis." }, { status: 400 });
  }
  if (typeof body.nature !== "string") {
    return NextResponse.json({ error: "nature est requise." }, { status: 400 });
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    return NextResponse.json({ error: "description doit être une chaîne." }, { status: 400 });
  }
  if (
    body.billableAmount !== undefined &&
    body.billableAmount !== null &&
    typeof body.billableAmount !== "number"
  ) {
    return NextResponse.json({ error: "billableAmount doit être un nombre." }, { status: 400 });
  }

  const location = await getLocationById(user.tenantId, body.locationId);
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
  }

  // Sprint 33 : un dégât facturable déclaré ici est immédiatement facturé (DamageInvoice à une
  // seule ligne) dans la même transaction que sa création — jamais un Damage facturable orphelin
  // sans facture, cohérent avec le flux de retour (createDamageInvoice bundling, voir
  // src/lib/location-return.ts). damage_invoices.create vérifiée en plus de damages.create
  // uniquement dans ce cas (un dégât non facturable ne crée aucune facture, aucune vérification
  // supplémentaire nécessaire).
  const isBillable = typeof body.billableAmount === "number" && body.billableAmount > 0;
  if (isBillable && !(await can(user, "damage_invoices.create"))) {
    return NextResponse.json({ error: "Accès refusé (facturation du dégât)." }, { status: 403 });
  }

  try {
    const { damage, invoice } = await prisma.$transaction(async (tx) => {
      const createdDamage = await createDamage(
        {
          tenantId: user.tenantId,
          vehicleId: location.vehicleId,
          locationId: location.id,
          createdByUserId: user.id,
          nature: body.nature as string,
          description: body.description,
          billableAmount: body.billableAmount,
          currency: location.currency,
        },
        tx
      );

      if (!isBillable) {
        return { damage: createdDamage, invoice: null };
      }

      const result = await createDamageInvoice(
        { tenantId: user.tenantId, locationId: location.id, damageIds: [createdDamage.id] },
        tx
      );
      return { damage: result.damages[0], invoice: result.invoice };
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "damage.created",
      resource: "Damage",
      resourceId: damage.id,
      metadata: {
        locationId: damage.locationId,
        vehicleId: damage.vehicleId,
        nature: damage.nature,
        billableAmount: damage.billableAmount,
      },
    });
    if (invoice) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "damage_invoice.created",
        resource: "DamageInvoice",
        resourceId: invoice.id,
        metadata: { number: invoice.number, locationId: invoice.locationId, totalAmount: invoice.totalAmount },
      });
    }

    return NextResponse.json({ damage, damageInvoice: invoice }, { status: 201 });
  } catch (error) {
    if (
      error instanceof InvalidDamageNatureError ||
      error instanceof InvalidDamageAmountError ||
      error instanceof DamageNotBillableError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DamageAlreadyInvoicedError || error instanceof DamageLocationMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la création du dégât :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
