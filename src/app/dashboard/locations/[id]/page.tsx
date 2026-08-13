import { notFound } from "next/navigation";
import Link from "next/link";
import { FileText, Download } from "lucide-react";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getLocationById } from "@/lib/locations";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { LocationActions } from "./LocationActions";

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

export default async function LocationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  const location = await getLocationById(user.tenantId, id);
  if (!location || !(await canAccessAgency(user, location.agencyId))) {
    notFound();
  }

  const [vehicle, client, agency, invoice] = await Promise.all([
    prisma.vehicle.findUnique({ where: { id: location.vehicleId } }),
    prisma.client.findUnique({ where: { id: location.clientId } }),
    prisma.agency.findUnique({ where: { id: location.agencyId }, select: { name: true } }),
    prisma.invoice.findFirst({ where: { locationId: location.id }, orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            {location.contractNumber ?? `Location #${location.id.slice(-8)}`}
          </h1>
          <p className="text-sm text-muted-foreground">Agence : {agency?.name ?? "—"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{STATUS_LABELS[location.status] ?? location.status}</Badge>
          {location.contractNumber && (
            <Button
              render={<a href={`/api/locations/${location.id}/pdf`} target="_blank" rel="noreferrer" />}
              variant="outline"
              size="sm"
            >
              <Download className="size-4" />
              Contrat PDF
            </Button>
          )}
          {invoice && (
            <Button render={<Link href={`/dashboard/invoices/${invoice.id}`} />} variant="outline" size="sm">
              <FileText className="size-4" />
              Voir facture
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Détails</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          {location.contractNumber && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">N° contrat</p>
              <p className="font-medium">{location.contractNumber}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Client</p>
            <p>{client?.name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Véhicule</p>
            <p>
              {vehicle ? (
                <Link href={`/dashboard/vehicles/${vehicle.id}`} className="text-primary hover:underline">
                  {vehicle.name} ({vehicle.licensePlate})
                </Link>
              ) : (
                "—"
              )}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Période</p>
            <p>
              {location.startDate.toLocaleString("fr-FR")} → {location.endDate.toLocaleString("fr-FR")}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Prix / jour</p>
            <p>{formatMoney(location.pricePerDay, location.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Total</p>
            <p className="font-medium">{formatMoney(location.totalPrice, location.currency)}</p>
          </div>
          {location.deposit !== null && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Caution</p>
              <p>{formatMoney(location.deposit, location.currency)}</p>
            </div>
          )}
          {(location.startOdometer !== null || location.endOdometer !== null) && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Kilométrage</p>
              <p>
                {location.startOdometer ?? "—"} km → {location.endOdometer ?? "—"} km
              </p>
            </div>
          )}
          {location.notes && (
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Notes</p>
              <p>{location.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <LocationActions
        id={location.id}
        status={location.status}
        notes={location.notes}
        endOdometer={location.endOdometer}
      />
    </div>
  );
}
