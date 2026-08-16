"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label } from "@/components/ui";
import { FuelLevelSelect } from "@/components/ui/fuel-level-select";
import { DamageStatusBadge } from "@/components/damages/DamageStatusBadge";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — panneau de retour d'un contrat : kilométrage/
 * carburant de retour, date/heure réelle (gérée par locations.return_time.edit), solde du
 * contrat, dégâts (existants + nouveaux). Sprint 33 (DOMAINRULES.md section 48) : le paiement
 * direct d'un dégât (sans facture) a été retiré — tout dégât facturable saisi ici génère
 * automatiquement une DamageInvoice unique regroupant tous les dégâts facturables de cette
 * soumission (returnLocation/createDamageInvoice, src/lib/location-return.ts,
 * src/lib/damage-invoices.ts) ; l'encaissement de son solde se fait soit ici même au moment du
 * retour (un seul paiement, réparti sur l'ensemble des dégâts facturables de ce retour), soit
 * plus tard depuis l'écran dédié /dashboard/damage-invoices/[id]. Toute règle métier reste côté
 * serveur : ce composant ne fait que construire les corps de requête et afficher les réponses/
 * erreurs — jamais de logique métier dupliquée ici, jamais une permission UI traitée comme une
 * preuve d'autorisation (canOverrideReturnTime/canCreateDamages sont calculées côté serveur,
 * page.tsx, et ne font ici que masquer des contrôles qu'un appel direct à l'API resterait de
 * toute façon refusé sans la permission réelle).
 */

const PAYMENT_METHOD_OPTIONS = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
] as const;
type PaymentMethodValue = (typeof PAYMENT_METHOD_OPTIONS)[number]["value"];

function toCentimes(raw: string): number {
  return Math.round(Number(raw.replace(",", ".")) * 100);
}

/** Formate une date ISO pour un <input type="datetime-local">, en heure locale du navigateur —
 * purement pour l'affichage/la saisie : la valeur réellement envoyée au serveur est reconvertie
 * via `new Date(value).toISOString()`, jamais gardée comme simple chaîne locale. */
function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeErrorMessage(err: unknown, fallback: string): string {
  // src/lib/api.ts (ApiError) ne porte jamais que le message { error } déjà renvoyé par la
  // route — jamais de stack/détail interne. Un échec réseau/inattendu retombe sur un message
  // générique, jamais l'erreur brute.
  return err instanceof ApiError ? err.message : fallback;
}

function PaymentMethodSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: PaymentMethodValue;
  onChange: (value: PaymentMethodValue) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as PaymentMethodValue)}
      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
    >
      {PAYMENT_METHOD_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface ExistingDamage {
  id: string;
  nature: string;
  description: string | null;
  billableAmount: number | null;
  currency: string;
  status: "REPORTED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
  /** Sprint 33 — null tant que le dégât n'a pas encore été facturé. */
  damageInvoiceId: string | null;
  damageInvoiceNumber: string | null;
}

function ExistingDamageRow({ damage }: { damage: ExistingDamage }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{damage.nature}</p>
          {damage.description && <p className="text-sm text-muted-foreground">{damage.description}</p>}
        </div>
        <DamageStatusBadge status={damage.status} />
      </div>
      <p className="text-sm">
        Montant facturable du dégât :{" "}
        {damage.billableAmount !== null ? formatMoney(damage.billableAmount, damage.currency) : "non chiffré"}
      </p>
      {damage.damageInvoiceId ? (
        <Link
          href={`/dashboard/damage-invoices/${damage.damageInvoiceId}`}
          className="text-sm font-medium text-primary underline underline-offset-2"
        >
          Voir la facture de dégâts {damage.damageInvoiceNumber} →
        </Link>
      ) : (
        <p className="text-xs text-muted-foreground">
          {damage.billableAmount !== null && damage.billableAmount > 0
            ? "Pas encore facturé."
            : "Aucun montant facturable — jamais facturé."}
        </p>
      )}
    </div>
  );
}

interface NewDamageDraft {
  key: string;
  nature: string;
  description: string;
  billableAmount: string;
}

function emptyDamageDraft(key: string): NewDamageDraft {
  return { key, nature: "", description: "", billableAmount: "" };
}

function NewDamageRow({
  damage,
  currency,
  onChange,
  onRemove,
}: {
  damage: NewDamageDraft;
  currency: string;
  onChange: (patch: Partial<NewDamageDraft>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`new-damage-nature-${damage.key}`}>Nature *</Label>
          <Input
            id={`new-damage-nature-${damage.key}`}
            required
            value={damage.nature}
            onChange={(e) => onChange({ nature: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`new-damage-billable-${damage.key}`}>{`Montant facturable (${currency}, optionnel)`}</Label>
          <Input
            id={`new-damage-billable-${damage.key}`}
            inputMode="decimal"
            value={damage.billableAmount}
            onChange={(e) => onChange({ billableAmount: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Laissé vide = dégât non facturable (pris en charge/gratuit), jamais facturé. Un montant renseigné génère
            automatiquement une facture de dégâts à la clôture du retour.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`new-damage-description-${damage.key}`}>Description (optionnel)</Label>
        <Input
          id={`new-damage-description-${damage.key}`}
          value={damage.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRemove} className="w-full sm:w-auto">
        Retirer ce dégât
      </Button>
    </div>
  );
}

function StandaloneDamageForm({ locationId, currency }: { locationId: string; currency: string }) {
  const router = useRouter();
  const [nature, setNature] = useState("");
  const [description, setDescription] = useState("");
  const [billableAmount, setBillableAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!nature.trim()) {
      setError("La nature du dégât est obligatoire.");
      return;
    }
    setSubmitting(true);
    try {
      await apiPost("/api/damages", {
        locationId,
        nature,
        description: description || undefined,
        billableAmount: billableAmount ? toCentimes(billableAmount) : undefined,
      });
      toast.success(
        billableAmount ? "Dégât déclaré et facturé (voir la facture de dégâts)." : "Dégât déclaré."
      );
      setNature("");
      setDescription("");
      setBillableAmount("");
      router.refresh();
    } catch (err) {
      const message = safeErrorMessage(err, "Erreur lors de la déclaration du dégât.");
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Déclarer un nouveau dégât</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="standalone-damage-nature">Nature *</Label>
              <Input id="standalone-damage-nature" required value={nature} onChange={(e) => setNature(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="standalone-damage-billable">{`Montant facturable (${currency}, optionnel)`}</Label>
              <Input
                id="standalone-damage-billable"
                inputMode="decimal"
                value={billableAmount}
                onChange={(e) => setBillableAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="standalone-damage-description">Description (optionnel)</Label>
            <Input
              id="standalone-damage-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? "Déclaration…" : "Déclarer le dégât"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

interface ReturnLocationPanelProps {
  locationId: string;
  status: string;
  contractNumber: string | null;
  clientName: string;
  vehicleLabel: string;
  startDate: string;
  endDate: string;
  actualReturnAt: string | null;
  startOdometer: number | null;
  startFuelLevel: number | null;
  totalAmount: number | null;
  amountPaid: number | null;
  currency: string;
  serverNowIso: string;
  canOverrideReturnTime: boolean;
  canCreateDamages: boolean;
  damages: ExistingDamage[];
}

export function ReturnLocationPanel(props: ReturnLocationPanelProps) {
  const router = useRouter();
  const isActive = props.status === "ACTIVE";
  const remainingBalance =
    props.totalAmount !== null && props.amountPaid !== null ? props.totalAmount - props.amountPaid : null;

  const [endOdometer, setEndOdometer] = useState("");
  const [endFuelLevel, setEndFuelLevel] = useState("");
  const [actualReturnAtLocal, setActualReturnAtLocal] = useState(toDatetimeLocalValue(props.serverNowIso));
  const [collectPayment, setCollectPayment] = useState(false);
  const [paymentMixed, setPaymentMixed] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodValue>("CASH");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod1, setPaymentMethod1] = useState<PaymentMethodValue>("CASH");
  const [paymentAmount1, setPaymentAmount1] = useState("");
  const [paymentMethod2, setPaymentMethod2] = useState<PaymentMethodValue>("CARD");
  const [paymentAmount2, setPaymentAmount2] = useState("");
  const [newDamages, setNewDamages] = useState<NewDamageDraft[]>([]);
  const [collectDamagePayment, setCollectDamagePayment] = useState(false);
  const [damagePaymentMixed, setDamagePaymentMixed] = useState(false);
  const [damagePaymentMethod, setDamagePaymentMethod] = useState<PaymentMethodValue>("CASH");
  const [damagePaymentAmount, setDamagePaymentAmount] = useState("");
  const [damagePaymentMethod1, setDamagePaymentMethod1] = useState<PaymentMethodValue>("CASH");
  const [damagePaymentAmount1, setDamagePaymentAmount1] = useState("");
  const [damagePaymentMethod2, setDamagePaymentMethod2] = useState<PaymentMethodValue>("CARD");
  const [damagePaymentAmount2, setDamagePaymentAmount2] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasBillableNewDamage = newDamages.some((damage) => damage.billableAmount && toCentimes(damage.billableAmount) > 0);

  function addDamageDraft() {
    setNewDamages((prev) => [...prev, emptyDamageDraft(`${Date.now()}-${prev.length}`)]);
  }
  function removeDamageDraft(key: string) {
    setNewDamages((prev) => prev.filter((damage) => damage.key !== key));
  }
  function updateDamageDraft(key: string, patch: Partial<NewDamageDraft>) {
    setNewDamages((prev) => prev.map((damage) => (damage.key === key ? { ...damage, ...patch } : damage)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Garde synchrone côté interface uniquement, contre un double-clic — la protection réelle
    // contre un double retour est le verrou de ligne posé côté serveur (returnLocation,
    // src/lib/location-return.ts), jamais cette seule vérification côté client.
    if (submitting) return;
    setError(null);

    const odometerValue = Number(endOdometer);
    if (!endOdometer || !Number.isInteger(odometerValue)) {
      setError("Le kilométrage de retour est obligatoire.");
      return;
    }
    if (props.startOdometer !== null && odometerValue <= props.startOdometer) {
      setError(
        `Le kilométrage de retour doit être strictement supérieur au kilométrage de départ (${props.startOdometer} km).`
      );
      return;
    }
    if (!endFuelLevel) {
      setError("Le niveau de carburant de retour est obligatoire.");
      return;
    }
    for (const damage of newDamages) {
      if (!damage.nature.trim()) {
        setError("La nature de chaque dégât ajouté est obligatoire.");
        return;
      }
    }

    const body: Record<string, unknown> = {
      endOdometer: odometerValue,
      endFuelLevel: Number(endFuelLevel),
    };

    // canOverrideReturnTime est calculée côté serveur (page.tsx) — envoyer actualReturnAt sans
    // cette permission serait de toute façon ignoré par le serveur (voir
    // src/lib/location-return.ts, resolveActualReturnAt) : ce test ne fait qu'éviter un appel
    // inutile, jamais une garantie de sécurité côté client.
    if (props.canOverrideReturnTime) {
      body.actualReturnAt = new Date(actualReturnAtLocal).toISOString();
    }

    if (collectPayment) {
      if (paymentMixed) {
        const lines = [
          { method: paymentMethod1, amount: paymentAmount1 ? toCentimes(paymentAmount1) : 0 },
          { method: paymentMethod2, amount: paymentAmount2 ? toCentimes(paymentAmount2) : 0 },
        ].filter((line) => line.amount > 0);
        if (lines.length === 0) {
          setError("Le paiement mixte du solde locatif nécessite au moins un montant renseigné.");
          return;
        }
        body.paymentLines = lines;
      } else {
        if (!paymentAmount) {
          setError("Le montant encaissé pour le solde locatif est requis.");
          return;
        }
        body.paymentLines = [{ method: paymentMethod, amount: toCentimes(paymentAmount) }];
      }
    }

    if (newDamages.length > 0) {
      body.damages = newDamages.map((damage) => ({
        nature: damage.nature,
        description: damage.description || undefined,
        billableAmount: damage.billableAmount ? toCentimes(damage.billableAmount) : undefined,
      }));
    }

    // Sprint 33 : un seul paiement, réparti sur l'ensemble des dégâts facturables de cette
    // soumission (regroupés dans une unique DamageInvoice, voir src/lib/location-return.ts) —
    // jamais un paiement par dégât individuel.
    if (hasBillableNewDamage && collectDamagePayment) {
      if (damagePaymentMixed) {
        const lines = [
          { method: damagePaymentMethod1, amount: damagePaymentAmount1 ? toCentimes(damagePaymentAmount1) : 0 },
          { method: damagePaymentMethod2, amount: damagePaymentAmount2 ? toCentimes(damagePaymentAmount2) : 0 },
        ].filter((line) => line.amount > 0);
        if (lines.length === 0) {
          setError("Le paiement mixte des dégâts nécessite au moins un montant renseigné.");
          return;
        }
        body.damageInvoicePaymentLines = lines;
      } else {
        if (!damagePaymentAmount) {
          setError("Le montant encaissé pour les dégâts est requis.");
          return;
        }
        body.damageInvoicePaymentLines = [{ method: damagePaymentMethod, amount: toCentimes(damagePaymentAmount) }];
      }
    }

    setSubmitting(true);
    try {
      await apiPost(`/api/locations/${props.locationId}/return`, body);
      toast.success("Contrat clôturé.");
      router.push(`/dashboard/locations/${props.locationId}`);
      router.refresh();
    } catch (err) {
      const message = safeErrorMessage(err, "Erreur lors du retour du contrat.");
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">
        Retour — {props.contractNumber ?? `Contrat #${props.locationId.slice(-8)}`}
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>Récapitulatif</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">N° contrat</p>
            <p className="font-medium">{props.contractNumber ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Client</p>
            <p>{props.clientName}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Véhicule</p>
            <p>{props.vehicleLabel}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Départ prévu</p>
            <p>{new Date(props.startDate).toLocaleString("fr-FR")}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Retour prévu</p>
            <p>{new Date(props.endDate).toLocaleString("fr-FR")}</p>
          </div>
          {props.actualReturnAt && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Retour réel</p>
              <p>{new Date(props.actualReturnAt).toLocaleString("fr-FR")}</p>
            </div>
          )}
          {props.totalAmount !== null && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Total du contrat</p>
              <p className="font-medium">{formatMoney(props.totalAmount, props.currency)}</p>
            </div>
          )}
          {props.amountPaid !== null && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Déjà payé</p>
              <p>{formatMoney(props.amountPaid, props.currency)}</p>
            </div>
          )}
          {remainingBalance !== null && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Reste à payer (solde locatif)</p>
              <p className="font-medium">{formatMoney(remainingBalance, props.currency)}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Kilométrage départ</p>
            <p>{props.startOdometer ?? "—"} km</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Carburant départ</p>
            <p>{props.startFuelLevel !== null ? `${props.startFuelLevel}%` : "—"}</p>
          </div>
        </CardContent>
      </Card>

      {props.damages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Dégâts déjà déclarés sur ce contrat</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {props.damages.map((damage) => (
              <ExistingDamageRow key={damage.id} damage={damage} />
            ))}
          </CardContent>
        </Card>
      )}

      {isActive ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Kilométrage et carburant de retour</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endOdometer">Kilométrage de retour *</Label>
                <Input
                  id="endOdometer"
                  type="number"
                  inputMode="numeric"
                  required
                  min={props.startOdometer !== null ? props.startOdometer + 1 : 0}
                  value={endOdometer}
                  onChange={(e) => setEndOdometer(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endFuelLevel">Carburant de retour *</Label>
                <FuelLevelSelect id="endFuelLevel" required value={endFuelLevel} onChange={setEndFuelLevel} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Date et heure de retour réelles</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {props.canOverrideReturnTime ? (
                <>
                  <Label htmlFor="actualReturnAt">Date/heure de retour</Label>
                  <Input
                    id="actualReturnAt"
                    type="datetime-local"
                    value={actualReturnAtLocal}
                    onChange={(e) => setActualReturnAtLocal(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Préremplie avec l&apos;heure serveur, modifiable (permission accordée) — doit rester entre le
                    départ du contrat et l&apos;heure actuelle, revérifié par le serveur.
                  </p>
                </>
              ) : (
                <>
                  <Label htmlFor="actualReturnAtReadonly">Date/heure de retour</Label>
                  <Input id="actualReturnAtReadonly" type="datetime-local" value={actualReturnAtLocal} disabled readOnly />
                  <p className="text-xs text-muted-foreground">
                    Heure du serveur, non modifiable (permission requise pour la corriger).
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Solde du contrat</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {remainingBalance !== null && (
                <p className="text-sm">
                  Reste à payer (solde locatif) :{" "}
                  <span className="font-medium">{formatMoney(remainingBalance, props.currency)}</span>
                </p>
              )}
              <label className="flex min-h-[48px] items-center gap-2 text-sm">
                <Checkbox checked={collectPayment} onCheckedChange={(checked) => setCollectPayment(checked === true)} />
                Encaisser un paiement du solde locatif maintenant
              </label>
              {collectPayment && (
                <>
                  <label className="flex min-h-[48px] items-center gap-2 text-sm">
                    <Checkbox checked={paymentMixed} onCheckedChange={(checked) => setPaymentMixed(checked === true)} />
                    Paiement mixte (deux modes de règlement)
                  </label>
                  {paymentMixed ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentMethod1">Mode 1</Label>
                        <PaymentMethodSelect id="paymentMethod1" value={paymentMethod1} onChange={setPaymentMethod1} />
                        <Input
                          inputMode="decimal"
                          placeholder={`Montant 1 (${props.currency})`}
                          value={paymentAmount1}
                          onChange={(e) => setPaymentAmount1(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentMethod2">Mode 2</Label>
                        <PaymentMethodSelect id="paymentMethod2" value={paymentMethod2} onChange={setPaymentMethod2} />
                        <Input
                          inputMode="decimal"
                          placeholder={`Montant 2 (${props.currency})`}
                          value={paymentAmount2}
                          onChange={(e) => setPaymentAmount2(e.target.value)}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentMethod">Mode de paiement</Label>
                        <PaymentMethodSelect id="paymentMethod" value={paymentMethod} onChange={setPaymentMethod} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentAmount">{`Montant (${props.currency})`}</Label>
                        <Input
                          id="paymentAmount"
                          inputMode="decimal"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {props.canCreateDamages && (
            <Card>
              <CardHeader>
                <CardTitle>Dégâts constatés au retour</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {newDamages.map((damage) => (
                  <NewDamageRow
                    key={damage.key}
                    damage={damage}
                    currency={props.currency}
                    onChange={(patch) => updateDamageDraft(damage.key, patch)}
                    onRemove={() => removeDamageDraft(damage.key)}
                  />
                ))}
                <Button type="button" variant="outline" onClick={addDamageDraft} className="w-full sm:w-auto">
                  Ajouter un dégât
                </Button>

                {hasBillableNewDamage && (
                  <div className="flex flex-col gap-3 border-t border-border pt-3">
                    <p className="text-sm text-muted-foreground">
                      Les dégâts facturables ci-dessus génèreront automatiquement une facture de dégâts distincte à
                      la clôture du retour (jamais mêlée au solde locatif).
                    </p>
                    <label className="flex min-h-[48px] items-center gap-2 text-sm">
                      <Checkbox
                        checked={collectDamagePayment}
                        onCheckedChange={(checked) => setCollectDamagePayment(checked === true)}
                      />
                      Encaisser un paiement pour cette facture de dégâts maintenant
                    </label>
                    {collectDamagePayment && (
                      <>
                        <label className="flex min-h-[48px] items-center gap-2 text-sm">
                          <Checkbox
                            checked={damagePaymentMixed}
                            onCheckedChange={(checked) => setDamagePaymentMixed(checked === true)}
                          />
                          Paiement mixte (deux modes de règlement)
                        </label>
                        {damagePaymentMixed ? (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="damagePaymentMethod1">Mode 1</Label>
                              <PaymentMethodSelect
                                id="damagePaymentMethod1"
                                value={damagePaymentMethod1}
                                onChange={setDamagePaymentMethod1}
                              />
                              <Input
                                inputMode="decimal"
                                placeholder={`Montant 1 (${props.currency})`}
                                value={damagePaymentAmount1}
                                onChange={(e) => setDamagePaymentAmount1(e.target.value)}
                              />
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="damagePaymentMethod2">Mode 2</Label>
                              <PaymentMethodSelect
                                id="damagePaymentMethod2"
                                value={damagePaymentMethod2}
                                onChange={setDamagePaymentMethod2}
                              />
                              <Input
                                inputMode="decimal"
                                placeholder={`Montant 2 (${props.currency})`}
                                value={damagePaymentAmount2}
                                onChange={(e) => setDamagePaymentAmount2(e.target.value)}
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="damagePaymentMethod">Mode de paiement</Label>
                              <PaymentMethodSelect
                                id="damagePaymentMethod"
                                value={damagePaymentMethod}
                                onChange={setDamagePaymentMethod}
                              />
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="damagePaymentAmount">{`Montant (${props.currency})`}</Label>
                              <Input
                                id="damagePaymentAmount"
                                inputMode="decimal"
                                value={damagePaymentAmount}
                                onChange={(e) => setDamagePaymentAmount(e.target.value)}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? "Retour en cours…" : "Clôturer le retour"}
          </Button>
        </form>
      ) : (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            {props.status === "COMPLETED"
              ? "Ce contrat est déjà clôturé."
              : "Ce contrat n'est pas en cours (ACTIVE) : le retour n'est pas disponible."}
          </CardContent>
        </Card>
      )}

      {!isActive && props.canCreateDamages && (
        <StandaloneDamageForm locationId={props.locationId} currency={props.currency} />
      )}
    </div>
  );
}
