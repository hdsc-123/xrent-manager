import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { formatMoney } from "@/lib/format";

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Disponible",
  RENTED: "Loué",
  MAINTENANCE: "Maintenance",
  INACTIVE: "Inactif",
  TRANSFERRING: "En transfert",
  ON_TRIP: "En déplacement",
};

const TRANSMISSION_LABELS: Record<string, string> = {
  MANUELLE: "Manuelle",
  AUTOMATIQUE: "Automatique",
};

const FUEL_LABELS: Record<string, string> = {
  ESSENCE: "Essence",
  DIESEL: "Diesel",
  HYBRIDE: "Hybride",
  ELECTRIQUE: "Électrique",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR");
}

interface VehicleReadOnlyDetailsProps {
  category: string;
  status: string;
  pricePerDay: number | null;
  currency: string;
  licensePlate: string;
  ww: string | null;
  chassisNumber: string | null;
  color: string | null;
  doors: number | null;
  seats: number | null;
  transmission: string | null;
  fuel: string | null;
  horsepower: number | null;
  powerKW: number | null;
  engineSize: number | null;
  ac: boolean;
  gps: boolean;
  imageUrl: string | null;
  insuranceExpiryDate: string | null;
  vignetteExpiryDate: string | null;
  technicalInspectionExpiryDate: string | null;
  nextOilChangeDate: string | null;
  nextOilChangeKm: number | null;
}

/**
 * Sprint 22 : fiche véhicule en lecture seule pour un user ayant vehicles.view sans
 * vehicles.edit — auparavant la page affichait uniquement un message de refus à la place du
 * formulaire d'édition, masquant l'intégralité de la fiche technique (châssis, moteur,
 * échéances documents...) à un rôle pourtant explicitement autorisé à consulter les véhicules.
 * Même champs qu'EditVehicleForm.tsx, purement affichés (aucun input).
 */
export function VehicleReadOnlyDetails({
  category,
  status,
  pricePerDay,
  currency,
  licensePlate,
  ww,
  chassisNumber,
  color,
  doors,
  seats,
  transmission,
  fuel,
  horsepower,
  powerKW,
  engineSize,
  ac,
  gps,
  imageUrl,
  insuranceExpiryDate,
  vignetteExpiryDate,
  technicalInspectionExpiryDate,
  nextOilChangeDate,
  nextOilChangeKm,
}: VehicleReadOnlyDetailsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fiche véhicule</CardTitle>
        <CardDescription>
          Vous n&apos;avez pas la permission de modifier ce véhicule — vue en lecture seule.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">Immatriculation</span>
        <span>{licensePlate}</span>

        <span className="text-muted-foreground">Catégorie</span>
        <span>{category}</span>

        <span className="text-muted-foreground">Statut</span>
        <span>{STATUS_LABELS[status] ?? status}</span>

        <span className="text-muted-foreground">N° WW</span>
        <span>{ww ?? "—"}</span>

        <span className="text-muted-foreground">Numéro de châssis</span>
        <span>{chassisNumber ?? "—"}</span>

        <span className="text-muted-foreground">Couleur</span>
        <span>{color ?? "—"}</span>

        <span className="text-muted-foreground">Portes</span>
        <span>{doors ?? "—"}</span>

        <span className="text-muted-foreground">Places</span>
        <span>{seats ?? "—"}</span>

        <span className="text-muted-foreground">Boîte</span>
        <span>{transmission ? (TRANSMISSION_LABELS[transmission] ?? transmission) : "—"}</span>

        <span className="text-muted-foreground">Carburant</span>
        <span>{fuel ? (FUEL_LABELS[fuel] ?? fuel) : "—"}</span>

        <span className="text-muted-foreground">Chevaux fiscaux</span>
        <span>{horsepower ?? "—"}</span>

        <span className="text-muted-foreground">Puissance (kW)</span>
        <span>{powerKW ?? "—"}</span>

        <span className="text-muted-foreground">Cylindrée (L)</span>
        <span>{engineSize ?? "—"}</span>

        <span className="text-muted-foreground">Climatisé</span>
        <span>{ac ? "Oui" : "Non"}</span>

        <span className="text-muted-foreground">GPS intégré</span>
        <span>{gps ? "Oui" : "Non"}</span>

        <span className="text-muted-foreground">Prix / jour</span>
        <span>{pricePerDay !== null ? formatMoney(pricePerDay, currency) : "—"}</span>

        <span className="text-muted-foreground">Photo</span>
        <span>{imageUrl ?? "—"}</span>

        <span className="text-muted-foreground">Expiration assurance</span>
        <span>{formatDate(insuranceExpiryDate)}</span>

        <span className="text-muted-foreground">Expiration vignette</span>
        <span>{formatDate(vignetteExpiryDate)}</span>

        <span className="text-muted-foreground">Expiration contrôle technique</span>
        <span>{formatDate(technicalInspectionExpiryDate)}</span>

        <span className="text-muted-foreground">Prochaine vidange (date)</span>
        <span>{formatDate(nextOilChangeDate)}</span>

        <span className="text-muted-foreground">Prochaine vidange (km)</span>
        <span>{nextOilChangeKm ?? "—"}</span>
      </CardContent>
    </Card>
  );
}
