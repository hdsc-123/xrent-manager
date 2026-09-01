"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FuelLevelSelect,
  Input,
  Label,
} from "@/components/ui";

// Statut opérationnel entièrement calculé côté serveur (sprint "statut opérationnel
// automatique", 2026-08-28) — affiché en lecture seule ici, jamais modifiable depuis ce
// formulaire. Voir src/lib/vehicle-status.ts.
const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Disponible",
  RENTED: "Loué",
  MAINTENANCE: "Maintenance",
  TRANSFERRING: "En transfert",
  ON_TRIP: "En déplacement",
};

const TRANSMISSION_OPTIONS = [
  { value: "MANUELLE", label: "Manuelle" },
  { value: "AUTOMATIQUE", label: "Automatique" },
];

const FUEL_OPTIONS = [
  { value: "ESSENCE", label: "Essence" },
  { value: "DIESEL", label: "Diesel" },
  { value: "HYBRIDE", label: "Hybride" },
  { value: "ELECTRIQUE", label: "Électrique" },
];

interface EditVehicleFormProps {
  id: string;
  initialName: string;
  initialCategory: string;
  initialStatus: string;
  initialPricePerDay: number | null;
  licensePlate: string;
  initialWw: string | null;
  initialChassisNumber: string | null;
  initialColor: string | null;
  initialDoors: number | null;
  initialSeats: number | null;
  initialTransmission: string | null;
  initialFuel: string | null;
  initialHorsepower: number | null;
  initialPowerKW: number | null;
  initialEngineSize: number | null;
  initialAc: boolean;
  initialGps: boolean;
  initialImageUrl: string | null;
  /** Sprint 24-1 — kilométrage/carburant actuels, désormais modifiables après création. */
  initialCurrentOdometer: number | null;
  initialCurrentFuelLevel: number | null;
  /** Sprint 19 (DOMAINRULES.md section 37) — alertes proactives, tous optionnels. */
  initialInsuranceExpiryDate: string | null;
  initialVignetteExpiryDate: string | null;
  initialTechnicalInspectionExpiryDate: string | null;
  initialNextOilChangeDate: string | null;
  initialNextOilChangeKm: number | null;
  /** État administratif (sprint "statut opérationnel automatique", 2026-08-28) — remplace
   * l'ancien VehicleStatus.INACTIVE, orthogonal au statut opérationnel calculé ci-dessus. */
  initialDeactivatedAt: string | null;
  initialDeactivatedReason: string | null;
  /** Désactivation/réactivation réservée ADMIN (contrôle de rôle strict côté route) — calculé
   * côté serveur par la page appelante. */
  canDeactivate: boolean;
}

export function EditVehicleForm({
  id,
  initialName,
  initialCategory,
  initialStatus,
  initialPricePerDay,
  licensePlate,
  initialWw,
  initialChassisNumber,
  initialColor,
  initialDoors,
  initialSeats,
  initialTransmission,
  initialFuel,
  initialHorsepower,
  initialPowerKW,
  initialEngineSize,
  initialAc,
  initialGps,
  initialImageUrl,
  initialCurrentOdometer,
  initialCurrentFuelLevel,
  initialInsuranceExpiryDate,
  initialVignetteExpiryDate,
  initialTechnicalInspectionExpiryDate,
  initialNextOilChangeDate,
  initialNextOilChangeKm,
  initialDeactivatedAt,
  initialDeactivatedReason,
  canDeactivate,
}: EditVehicleFormProps) {
  const router = useRouter();
  const [deactivatedAt, setDeactivatedAt] = useState(initialDeactivatedAt);
  const [deactivatedReason, setDeactivatedReason] = useState(initialDeactivatedReason);
  const [showDeactivateDialog, setShowDeactivateDialog] = useState(false);
  const [showReactivateDialog, setShowReactivateDialog] = useState(false);
  const [deactivateReasonInput, setDeactivateReasonInput] = useState("");
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [isReactivating, setIsReactivating] = useState(false);
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(initialCategory);
  const [pricePerDay, setPricePerDay] = useState(
    initialPricePerDay !== null ? (initialPricePerDay / 100).toFixed(2) : ""
  );
  const [ww, setWw] = useState(initialWw ?? "");
  const [chassisNumber, setChassisNumber] = useState(initialChassisNumber ?? "");
  const [color, setColor] = useState(initialColor ?? "");
  const [doors, setDoors] = useState(initialDoors !== null ? String(initialDoors) : "");
  const [seats, setSeats] = useState(initialSeats !== null ? String(initialSeats) : "");
  const [transmission, setTransmission] = useState(initialTransmission ?? "MANUELLE");
  const [fuel, setFuel] = useState(initialFuel ?? "ESSENCE");
  const [horsepower, setHorsepower] = useState(
    initialHorsepower !== null ? String(initialHorsepower) : ""
  );
  const [powerKW, setPowerKW] = useState(initialPowerKW !== null ? String(initialPowerKW) : "");
  const [engineSize, setEngineSize] = useState(
    initialEngineSize !== null ? String(initialEngineSize) : ""
  );
  const [ac, setAc] = useState(initialAc);
  const [gps, setGps] = useState(initialGps);
  const [imageUrl, setImageUrl] = useState(initialImageUrl ?? "");
  const [currentOdometer, setCurrentOdometer] = useState(
    initialCurrentOdometer !== null ? String(initialCurrentOdometer) : ""
  );
  const [currentFuelLevel, setCurrentFuelLevel] = useState(
    initialCurrentFuelLevel !== null ? String(initialCurrentFuelLevel) : ""
  );
  const [insuranceExpiryDate, setInsuranceExpiryDate] = useState(initialInsuranceExpiryDate ?? "");
  const [vignetteExpiryDate, setVignetteExpiryDate] = useState(initialVignetteExpiryDate ?? "");
  const [technicalInspectionExpiryDate, setTechnicalInspectionExpiryDate] = useState(
    initialTechnicalInspectionExpiryDate ?? ""
  );
  const [nextOilChangeDate, setNextOilChangeDate] = useState(initialNextOilChangeDate ?? "");
  const [nextOilChangeKm, setNextOilChangeKm] = useState(
    initialNextOilChangeKm !== null ? String(initialNextOilChangeKm) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Sprint 24-1 : même garde que NewVehicleForm.tsx (Sprint 18) — jusqu'ici cette page
    // n'imposait ces 7 champs ni côté client ni côté serveur, contrairement au formulaire de
    // création : une modification via ce formulaire pouvait donc effacer silencieusement une
    // fiche technique saisie à la création. Bloqué ici, côté client. **Décision délibérée** :
    // pas de rejet serveur strict sur un effacement (PATCH /api/vehicles/[id]/route.ts) — ces
    // champs restent nullables à l'API par design (Sprint 12A, DOMAINRULES.md section 5,
    // rétrocompatibilité), requis seulement au niveau de ce formulaire.
    // Revue message de validation véhicule (2026-09-01) : n'indique que les champs
    // effectivement manquants — jusqu'ici un message statique listait toujours les 7 champs,
    // même quand un seul était vide.
    const missingFields: string[] = [];
    if (!chassisNumber) missingFields.push("Numéro de châssis");
    if (!color) missingFields.push("Couleur");
    if (!doors) missingFields.push("Portes");
    if (!seats) missingFields.push("Places");
    if (!horsepower) missingFields.push("Chevaux fiscaux");
    if (!powerKW) missingFields.push("Puissance (kW)");
    if (!engineSize) missingFields.push("Cylindrée");
    if (missingFields.length > 0) {
      setError(`Champ${missingFields.length > 1 ? "s" : ""} requis manquant${missingFields.length > 1 ? "s" : ""} : ${missingFields.join(", ")}.`);
      return;
    }

    let pricePerDayCentimes: number | null = null;
    if (pricePerDay.trim()) {
      const priceMad = Number(pricePerDay.replace(",", "."));
      if (!Number.isFinite(priceMad) || priceMad <= 0) {
        setError("Le prix par jour doit être un nombre positif.");
        return;
      }
      pricePerDayCentimes = Math.round(priceMad * 100);
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicles/${id}`, {
        name,
        category,
        pricePerDay: pricePerDayCentimes,
        ww: ww || null,
        chassisNumber: chassisNumber || null,
        color: color || null,
        doors: doors ? Number(doors) : null,
        seats: seats ? Number(seats) : null,
        transmission,
        fuel,
        horsepower: horsepower ? Number(horsepower) : null,
        powerKW: powerKW ? Number(powerKW) : null,
        engineSize: engineSize ? Number(engineSize.replace(",", ".")) : null,
        ac,
        gps,
        currentOdometer: currentOdometer ? Number(currentOdometer) : null,
        currentFuelLevel: currentFuelLevel ? Number(currentFuelLevel) : null,
        imageUrl: imageUrl || null,
        insuranceExpiryDate: insuranceExpiryDate || null,
        vignetteExpiryDate: vignetteExpiryDate || null,
        technicalInspectionExpiryDate: technicalInspectionExpiryDate || null,
        nextOilChangeDate: nextOilChangeDate || null,
        nextOilChangeKm: nextOilChangeKm ? Number(nextOilChangeKm) : null,
      });
      toast.success("Véhicule mis à jour.");
      router.push("/dashboard/vehicles");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeactivate() {
    if (!deactivateReasonInput.trim()) return;
    setIsDeactivating(true);
    try {
      const { vehicle } = await apiPost<{ vehicle: { deactivatedAt: string; deactivatedReason: string | null } }>(
        `/api/vehicles/${id}/deactivate`,
        { reason: deactivateReasonInput.trim() }
      );
      setDeactivatedAt(vehicle.deactivatedAt);
      setDeactivatedReason(vehicle.deactivatedReason);
      setShowDeactivateDialog(false);
      setDeactivateReasonInput("");
      toast.success("Véhicule désactivé.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la désactivation.");
    } finally {
      setIsDeactivating(false);
    }
  }

  async function handleReactivate() {
    setIsReactivating(true);
    try {
      await apiPost(`/api/vehicles/${id}/reactivate`, {});
      setDeactivatedAt(null);
      setDeactivatedReason(null);
      setShowReactivateDialog(false);
      toast.success("Véhicule réactivé.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la réactivation.");
    } finally {
      setIsReactivating(false);
    }
  }

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle>Modifier le véhicule</CardTitle>
        <CardDescription>
          L&apos;immatriculation (« {licensePlate} ») n&apos;est pas modifiable depuis cette page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name" required>Nom</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category" required>Catégorie</Label>
            <Input
              id="category"
              required
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ww">
                N° WW <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="ww" value={ww} onChange={(e) => setWw(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="chassisNumber" required>Numéro de châssis</Label>
              <Input
                id="chassisNumber"
                required
                value={chassisNumber}
                onChange={(e) => setChassisNumber(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="color" required>Couleur</Label>
              <Input id="color" required value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="doors" required>Portes</Label>
              <Input id="doors" type="number" required value={doors} onChange={(e) => setDoors(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="seats" required>Places</Label>
              <Input id="seats" type="number" required value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transmission">Boîte</Label>
              <select
                id="transmission"
                value={transmission}
                onChange={(e) => setTransmission(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {TRANSMISSION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fuel">Carburant</Label>
              <select
                id="fuel"
                value={fuel}
                onChange={(e) => setFuel(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {FUEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="horsepower" required>Chevaux fiscaux</Label>
              <Input
                id="horsepower"
                type="number"
                required
                value={horsepower}
                onChange={(e) => setHorsepower(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="powerKW" required>Puissance (kW)</Label>
              <Input
                id="powerKW"
                type="number"
                required
                value={powerKW}
                onChange={(e) => setPowerKW(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="engineSize" required>Cylindrée (L)</Label>
              <Input
                id="engineSize"
                inputMode="decimal"
                required
                value={engineSize}
                onChange={(e) => setEngineSize(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ac} onChange={(e) => setAc(e.target.checked)} />
              Climatisé
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={gps} onChange={(e) => setGps(e.target.checked)} />
              GPS intégré
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currentOdometer">
                Kilométrage actuel <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input
                id="currentOdometer"
                inputMode="numeric"
                value={currentOdometer}
                onChange={(e) => setCurrentOdometer(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currentFuelLevel">
                Carburant actuel <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <FuelLevelSelect id="currentFuelLevel" value={currentFuelLevel} onChange={setCurrentFuelLevel} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="status">Statut opérationnel</Label>
              <p id="status" className="flex h-9 items-center text-sm">
                {STATUS_LABELS[initialStatus] ?? initialStatus}
              </p>
              <p className="text-xs text-muted-foreground">
                Calculé automatiquement — jamais modifiable directement.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pricePerDay">Prix / jour (MAD)</Label>
              <Input
                id="pricePerDay"
                inputMode="decimal"
                value={pricePerDay}
                onChange={(e) => setPricePerDay(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Indicatif — le prix réel se définit à la réservation ou au contrat.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">État administratif</span>
                <Badge variant={deactivatedAt ? "destructive" : "outline"}>
                  {deactivatedAt ? "Désactivé" : "Actif"}
                </Badge>
              </div>
              {canDeactivate &&
                (deactivatedAt ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setShowReactivateDialog(true)}>
                    Réactiver
                  </Button>
                ) : (
                  <Button type="button" variant="destructive" size="sm" onClick={() => setShowDeactivateDialog(true)}>
                    Désactiver
                  </Button>
                ))}
            </div>
            {deactivatedAt && (
              <p className="text-xs text-muted-foreground">
                Motif : {deactivatedReason ?? "sans motif enregistré"}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Décision administrative distincte du statut opérationnel — un véhicule désactivé
              bloque toute nouvelle location, maintenance, transfert ou déplacement.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="imageUrl">
              URL de la photo <span className="text-muted-foreground">— optionnel</span>
            </Label>
            <Input
              id="imageUrl"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <span className="text-sm font-medium">Alertes proactives</span>
            <p className="text-xs text-muted-foreground">
              Toutes optionnelles — génèrent une alerte à l&apos;approche de l&apos;échéance
              (voir /dashboard/alerts). Laissez vide si non suivi.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="insuranceExpiryDate">Expiration assurance</Label>
                <Input
                  id="insuranceExpiryDate"
                  type="date"
                  value={insuranceExpiryDate}
                  onChange={(e) => setInsuranceExpiryDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vignetteExpiryDate">Expiration vignette</Label>
                <Input
                  id="vignetteExpiryDate"
                  type="date"
                  value={vignetteExpiryDate}
                  onChange={(e) => setVignetteExpiryDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="technicalInspectionExpiryDate">Expiration contrôle technique</Label>
                <Input
                  id="technicalInspectionExpiryDate"
                  type="date"
                  value={technicalInspectionExpiryDate}
                  onChange={(e) => setTechnicalInspectionExpiryDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nextOilChangeDate">Prochaine vidange (date)</Label>
                <Input
                  id="nextOilChangeDate"
                  type="date"
                  value={nextOilChangeDate}
                  onChange={(e) => setNextOilChangeDate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nextOilChangeKm">Prochaine vidange (km)</Label>
              <Input
                id="nextOilChangeKm"
                type="number"
                className="max-w-40"
                value={nextOilChangeKm}
                onChange={(e) => setNextOilChangeKm(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting} className="w-fit">
            {isSubmitting ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </form>
      </CardContent>
    </Card>

    <Dialog
      open={showDeactivateDialog}
      onOpenChange={(open) => {
        setShowDeactivateDialog(open);
        if (!open) setDeactivateReasonInput("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Désactiver le véhicule ?</DialogTitle>
          <DialogDescription>
            Il ne pourra plus recevoir de nouvelle location, maintenance, transfert ou
            déplacement tant qu&apos;il n&apos;aura pas été réactivé. Un motif est obligatoire.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deactivateReasonInput">Motif</Label>
          <Input
            id="deactivateReasonInput"
            value={deactivateReasonInput}
            onChange={(e) => setDeactivateReasonInput(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDeactivateDialog(false)}>
            Annuler
          </Button>
          <Button
            variant="destructive"
            onClick={handleDeactivate}
            disabled={isDeactivating || !deactivateReasonInput.trim()}
          >
            {isDeactivating ? "Désactivation..." : "Désactiver"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showReactivateDialog} onOpenChange={setShowReactivateDialog}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Réactiver le véhicule ?</DialogTitle>
          <DialogDescription>Il redeviendra utilisable pour de nouvelles opérations.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowReactivateDialog(false)}>
            Annuler
          </Button>
          <Button onClick={handleReactivate} disabled={isReactivating}>
            {isReactivating ? "Réactivation..." : "Réactiver"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
