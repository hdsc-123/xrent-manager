import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getClientById } from "@/lib/clients";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui";
import { EditClientForm } from "./EditClientForm";

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

export default async function ClientDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  const client = await getClientById(user.tenantId, id);
  if (!client) {
    notFound();
  }

  const locations = await prisma.location.findMany({
    where: { clientId: client.id },
    include: { vehicle: { select: { name: true, licensePlate: true } } },
    orderBy: { startDate: "desc" },
  });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">{client.name}</h1>
        <p className="text-sm text-muted-foreground">
          {client.email ?? "—"} · {client.phone ?? "—"}
        </p>
      </div>

      <EditClientForm
        id={client.id}
        initialName={client.name}
        initialEmail={client.email}
        initialPhone={client.phone}
      />

      <div>
        <h2 className="mb-2 font-heading text-lg font-semibold">Locations associées</h2>
        {locations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune location pour ce client.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Véhicule</th>
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
                        {location.vehicle.name} ({location.vehicle.licensePlate})
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
