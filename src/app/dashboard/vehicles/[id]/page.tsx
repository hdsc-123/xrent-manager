import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getVehicleById } from "@/lib/vehicles";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui";
import { EditVehicleForm } from "./EditVehicleForm";

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

export default async function VehicleDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  const vehicle = await getVehicleById(user.tenantId, id);
  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    notFound();
  }

  const [agency, locations] = await Promise.all([
    prisma.agency.findUnique({ where: { id: vehicle.agencyId }, select: { name: true } }),
    prisma.location.findMany({
      where: { vehicleId: vehicle.id },
      include: { client: { select: { name: true } } },
      orderBy: { startDate: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">{vehicle.name}</h1>
        <p className="text-sm text-muted-foreground">
          {vehicle.make} {vehicle.model} ({vehicle.year}) — Agence : {agency?.name ?? "—"}
        </p>
      </div>

      <EditVehicleForm
        id={vehicle.id}
        initialName={vehicle.name}
        initialCategory={vehicle.category}
        initialStatus={vehicle.status}
        initialPricePerDay={vehicle.pricePerDay}
        licensePlate={vehicle.licensePlate}
      />

      <div>
        <h2 className="mb-2 font-heading text-lg font-semibold">Locations associées</h2>
        {locations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune location pour ce véhicule.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Période</th>
                  <th className="px-3 py-2 font-medium">Statut</th>
                  <th className="px-3 py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <tr key={location.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/locations/${location.id}`}
                        className="text-primary hover:underline"
                      >
                        {location.client.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {location.startDate.toLocaleDateString("fr-FR")} →{" "}
                      {location.endDate.toLocaleDateString("fr-FR")}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline">{STATUS_LABELS[location.status] ?? location.status}</Badge>
                    </td>
                    <td className="px-3 py-2">{formatMoney(location.totalPrice, location.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
