import { NextResponse } from "next/server";
import type { IdType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSessionUser, canAccessAgency, canAccessReservationAgencies, canEditReservationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById } from "@/lib/vehicles";
import {
  getClientById,
  createClient,
  updateClient,
  findDuplicateClient,
  assertValidLicenseDates,
  InvalidLicenseDatesError,
  type ClientDuplicateMatch,
} from "@/lib/clients";
import {
  getReservationById,
  claimReservationConversion,
  markReservationConverted,
  canTransition,
  InvalidReservationStatusTransitionError,
  ReservationNotFoundError,
} from "@/lib/reservations";
import {
  createLocation,
  InvalidDateRangeError,
  VehicleNotFoundError,
  ClientNotFoundError,
  VehicleNotAvailableError,
  VehicleUnavailableForLocationError,
  VehicleMaintenanceConflictError,
  MissingPriceError,
  MissingDriverLicenseExpiryError,
  DriverLicenseExpiredError,
  MissingDriverBirthDateError,
  InvalidDriverBirthDateError,
  DriverUnderMinimumAgeError,
  InvalidFuelLevelError,
} from "@/lib/locations";
import { createInvoice } from "@/lib/invoices";
import { processLocationPayment, validatePaymentInput, type PaymentInput } from "@/lib/location-payment";
import { logAction } from "@/lib/audit";
import {
  resolveLocationUpgrade,
  InvalidUpgradeTypeError,
  UpgradeNotNeededError,
  UpgradeDeclarationRequiredError,
  UpgradeReasonRequiredError,
  UpgradeConsentRequiredError,
  UpgradeSupplementInvalidError,
  UpgradeCategoryStillAvailableError,
  type UpgradeInput,
} from "@/lib/location-upgrades";

const ID_TYPES: IdType[] = ["CIN", "PASSEPORT", "CARTE_SEJOUR"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ConvertClientInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  idNumber?: string;
  idType?: IdType;
  licenseNumber?: string;
  licenseIssueDate?: string;
  licenseExpiryDate?: string;
  /** Sprint 30 (DOMAINRULES.md section 45, point 7) — âge réel, requis pour générer un contrat
   * (même statut que licenseExpiryDate ci-dessus), voir le contrôle missingRequiredField. */
  birthDate?: string;
}

interface ConvertSecondDriverInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
  idNumber?: string;
  licenseNumber?: string;
  /** Sprint 30 — âge réel du second conducteur, requis dès que secondDriver est fourni (même
   * contrôle que le client principal, voir assertClientMeetsMinimumAge). */
  birthDate?: string;
}

interface ConvertBody {
  vehicleId?: string;
  startDate?: string;
  endDate?: string;
  deposit?: number;
  /** Prix/jour réel (centimes) — voir DOMAINRULES.md section 5/7. Optionnel : retombe sur le
   * prix informatif du véhicule choisi s'il en a un ; sinon 400 (voir MissingPriceError). */
  pricePerDay?: number;
  /** Correctif (validation manuelle 2026-08-25, finding F-3) : kilométrage/carburant de départ
   * du contrat — jusqu'ici jamais collectés par ce parcours (contrairement à POST /api/locations,
   * la création directe), laissant `Location.startOdometer` toujours `null` pour tout contrat
   * issu d'une conversion, ce qui désactivait silencieusement le contrôle du kilométrage de
   * retour (`assertValidOdometer`, src/lib/location-return.ts).
   *
   * Re-correctif (validation manuelle 2026-08-25, second passage finding F-3) : rendu
   * OBLIGATOIRE spécifiquement sur ce parcours — décision explicite du propriétaire du projet
   * qui révise la parité voulue avec la création directe (DOMAINRULES.md section 40 point 2,
   * toujours optionnel là-bas) : aucun nouveau contrat issu d'une conversion ne doit pouvoir
   * exister avec un kilométrage de départ absent, pour que le contrôle de retour
   * (`assertValidOdometer`) reste systématiquement effectif sur tout contrat converti à partir de
   * ce correctif. Le formulaire (`ConvertReservationForm.tsx`) le préremplit automatiquement
   * depuis le dernier état connu du véhicule (`GET /api/vehicles/[id]/last-known-state`) et exige
   * désormais une valeur avant soumission ; si le véhicule n'a aucun kilométrage exploitable
   * connu, l'utilisateur autorisé doit le saisir manuellement — la conversion est refusée (400)
   * tant qu'aucune valeur valide n'est fournie. Les contrats convertis avant ce correctif
   * conservent `startOdometer: null` en base, non corrigés rétroactivement (voir DOMAINRULES.md
   * section 68, "limite historique assumée"). `startFuelLevel` reste optionnel (règle de domaine
   * inchangée), seulement validé s'il est fourni. */
  startOdometer?: number;
  startFuelLevel?: number;
  /** Sprint 19 : montant total explicite (centimes), prioritaire sur pricePerDay × jours —
   * voir CreateLocationInput.totalPrice, src/lib/locations.ts. */
  totalPrice?: number;
  notes?: string;
  client?: ConvertClientInput;
  useExistingClientId?: string;
  forceCreateClient?: boolean;
  /** Sprint 19 — second conducteur (voir Location.secondDriverId), toujours créé comme un
   * nouveau Client (pas de détection de doublon, moindre enjeu qu'un client principal). */
  secondDriver?: ConvertSecondDriverInput;
  payment?: PaymentInput;
  /** Campagne QA (2026-08-27, passe de correction obligatoire) — surclassement, requis dès
   * que le véhicule choisi a une catégorie différente de `Reservation.vehicleCategory` (voir
   * src/lib/location-upgrades.ts, resolveLocationUpgrade). `dailySupplement` n'est qu'indicatif
   * pour CUSTOMER_REQUEST/COMMERCIAL_GESTURE : le serveur le valide puis recalcule
   * intégralement le montant total, jamais accepté tel quel au-delà de ce contrôle. */
  upgrade?: UpgradeInput;
}

/**
 * Sprint 26A (Finding A) : un doublon client détecté pendant la conversion (sans
 * `forceCreateClient`) doit interrompre toute la transaction — y compris la réservation déjà
 * réclamée par `claimReservationConversion` juste avant, qui doit redevenir son statut
 * d'origine — pour renvoyer exactement la même réponse `409 { duplicate }` qu'avant ce
 * sprint, sans jamais avoir écrit quoi que ce soit entre-temps.
 */
class ConversionClientDuplicateError extends Error {
  duplicate: ClientDuplicateMatch;
  constructor(duplicate: ClientDuplicateMatch) {
    super("Un client correspondant existe déjà.");
    this.name = "ConversionClientDuplicateError";
    this.duplicate = duplicate;
  }
}

/**
 * Sprint 26A (Finding A) : `processLocationPayment` reste résiliente par construction (ne
 * lève jamais, comportement partagé et inchangé avec POST /api/locations — voir
 * src/lib/location-payment.ts) ; c'est cette route, spécifiquement, qui transforme un
 * `paymentError` non nul en échec de la transaction, pour ne jamais laisser un contrat/une
 * facture créés sans le paiement demandé par l'agent (atomicité complète du flux de
 * conversion, DOMAINRULES.md — décision validée explicitement pour ce flux uniquement).
 */
class ConversionPaymentError extends Error {}

/**
 * Convertit une réservation en contrat (Location + Invoice + Payment(s)) — Sprint 13D,
 * refonte complète du flux (voir DOMAINRULES.md section 26). Le formulaire de conversion
 * (`/dashboard/reservations/[id]/convert`) pré-remplit ses champs depuis la réservation, mais
 * l'utilisateur vérifie/complète les infos client, choisit le véhicule et l'agence réels
 * (dérivée du véhicule, jamais fournie séparément par le client — voir plus bas) et renseigne
 * le paiement, exactement comme le formulaire de création directe de location (Sprint 13A,
 * src/lib/location-payment.ts, réutilisé tel quel).
 *
 * Sprint 26A (Finding A, DOMAINRULES.md — plan d'implémentation validé) : les étapes 5 à 11
 * (résolution/création du client principal et du second conducteur, Location, rattachement
 * Reservation.convertedLocationId, Invoice, Payment(s), CashEntry) s'exécutent désormais
 * toutes dans une seule transaction Prisma partagée, dont le tout premier écrit est
 * `claimReservationConversion` — une réservation atomique de la conversion, conditionnée sur
 * le statut courant, avant toute création dépendante. Une conversion concurrente perdante
 * n'écrit donc plus jamais rien (ni client, ni location, ni facture, ni paiement, ni écriture
 * de caisse) ; un échec à n'importe quelle étape ultérieure (véhicule indisponible, doublon
 * client, facture, paiement) fait rollback de toute la transaction, y compris la réservation
 * déjà réclamée. Comportement inchangé pour POST /api/locations (non touché par ce sprint).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.convert"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const reservation = await getReservationById(user.tenantId, id);
  if (!reservation || !(await canAccessReservationAgencies(user, reservation))) {
    return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
  }
  // Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut convertir une
  // réservation en contrat — même restriction que PATCH /api/reservations/[id].
  if (!(await canEditReservationAgency(user, reservation))) {
    return NextResponse.json({ error: "Seule l'agence de départ peut convertir cette réservation." }, { status: 403 });
  }

  // Contrôle rapide non transactionnel (fast-fail, avant toute validation du corps de
  // requête) : l'enforcement réel et atomique reste claimReservationConversion, exécuté à
  // l'intérieur de la transaction ci-dessous — celui-ci évite seulement d'ouvrir une
  // transaction et de valider tout le corps de requête pour une réservation déjà
  // manifestement CONVERTED/CANCELLED/NO_SHOW.
  if (!canTransition(reservation.status, "CONVERTED")) {
    return NextResponse.json(
      { error: `Transition de statut invalide : ${reservation.status} → CONVERTED.` },
      { status: 409 }
    );
  }

  let body: ConvertBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.vehicleId) {
    return NextResponse.json({ error: "vehicleId est requis." }, { status: 400 });
  }
  if (!body.startDate || !body.endDate) {
    return NextResponse.json({ error: "startDate et endDate sont requis." }, { status: 400 });
  }
  const startDate = new Date(body.startDate);
  const endDate = new Date(body.endDate);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return NextResponse.json({ error: "startDate et endDate doivent être des dates ISO valides." }, { status: 400 });
  }

  if (body.deposit !== undefined && (!Number.isInteger(body.deposit) || body.deposit < 0)) {
    return NextResponse.json({ error: "deposit doit être un entier positif ou nul." }, { status: 400 });
  }

  if (body.pricePerDay !== undefined && (!Number.isInteger(body.pricePerDay) || body.pricePerDay <= 0)) {
    return NextResponse.json({ error: "pricePerDay doit être un entier positif (centimes)." }, { status: 400 });
  }
  if (body.totalPrice !== undefined && (!Number.isInteger(body.totalPrice) || body.totalPrice <= 0)) {
    return NextResponse.json({ error: "totalPrice doit être un entier positif (centimes)." }, { status: 400 });
  }
  // Re-correctif (finding F-3, second passage) : startOdometer est désormais OBLIGATOIRE sur ce
  // parcours (voir le commentaire de ConvertBody.startOdometer plus haut) — même contrôle de
  // type/plage que "endOdometer"/"deposit" sur POST /api/locations
  // (src/app/api/locations/route.ts), mais l'absence de valeur est ici explicitement refusée
  // plutôt que silencieusement acceptée comme `undefined`. startFuelLevel reste optionnel,
  // validé par createLocation lui-même (validateFuelLevel, InvalidFuelLevelError), pas ici.
  if (body.startOdometer === undefined || !Number.isInteger(body.startOdometer) || body.startOdometer < 0) {
    return NextResponse.json(
      { error: "startOdometer est requis et doit être un entier positif ou nul pour convertir une réservation." },
      { status: 400 }
    );
  }

  const clientInput = body.client ?? {};
  // .trim() sur chaque champ texte (campagne QA 2026-08-26, partie 1, trouvé en revue) : une
  // chaîne composée uniquement d'espaces est truthy en JavaScript et passerait sinon un simple
  // contrôle `!champ`, permettant de générer un contrat avec une identité client incohérente
  // (ex. firstName réel mais lastName = "   ") en appelant l'API directement, hors interface.
  if (!body.useExistingClientId && (!clientInput.firstName?.trim() || !clientInput.lastName?.trim())) {
    return NextResponse.json({ error: "client.firstName et client.lastName sont requis." }, { status: 400 });
  }
  // Sprint 19 (DOMAINRULES.md section 37) : obligatoires pour générer un contrat — ces champs
  // restent optionnels sur Reservation elle-même (import broker), voir le commentaire du
  // modèle Reservation. Un useExistingClientId retombe sur l'identité déjà connue du client.
  if (!body.useExistingClientId) {
    const missingRequiredField =
      !clientInput.address?.trim() ||
      !clientInput.city?.trim() ||
      !clientInput.country?.trim() ||
      !clientInput.idNumber?.trim() ||
      !clientInput.licenseNumber?.trim() ||
      !clientInput.licenseIssueDate ||
      !clientInput.licenseExpiryDate ||
      !clientInput.birthDate;
    if (missingRequiredField) {
      return NextResponse.json(
        {
          error:
            "client.address, city, country, idNumber, licenseNumber, licenseIssueDate, licenseExpiryDate et birthDate sont requis pour générer un contrat.",
        },
        { status: 400 }
      );
    }
  }
  if (clientInput.idType && !ID_TYPES.includes(clientInput.idType)) {
    return NextResponse.json({ error: "client.idType invalide." }, { status: 400 });
  }
  if (!body.useExistingClientId) {
    // Validation de format uniquement (date ISO parseable) — voir POST /api/clients pour la
    // justification complète (trouvé en revue, campagne QA 2026-08-26, partie 1). La présence
    // des deux dates est déjà garantie par missingRequiredField ci-dessus.
    if (Number.isNaN(new Date(clientInput.licenseIssueDate!).getTime())) {
      return NextResponse.json({ error: "client.licenseIssueDate doit être une date ISO valide." }, { status: 400 });
    }
    if (Number.isNaN(new Date(clientInput.licenseExpiryDate!).getTime())) {
      return NextResponse.json({ error: "client.licenseExpiryDate doit être une date ISO valide." }, { status: 400 });
    }
    try {
      assertValidLicenseDates(
        clientInput.licenseIssueDate ? new Date(clientInput.licenseIssueDate) : undefined,
        clientInput.licenseExpiryDate ? new Date(clientInput.licenseExpiryDate) : undefined
      );
    } catch (error) {
      if (error instanceof InvalidLicenseDatesError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }
  if (body.secondDriver && (!body.secondDriver.firstName?.trim() || !body.secondDriver.lastName?.trim())) {
    return NextResponse.json(
      { error: "secondDriver.firstName et secondDriver.lastName sont requis si secondDriver est fourni." },
      { status: 400 }
    );
  }
  // Sprint 30 (DOMAINRULES.md section 45, point 7) : birthDate requise dès qu'un second
  // conducteur est fourni (firstName/lastName déjà garantis présents par le contrôle
  // précédent) — même contrôle que le client principal ci-dessus.
  if (body.secondDriver && !body.secondDriver.birthDate) {
    return NextResponse.json(
      { error: "secondDriver.birthDate est requise si secondDriver est fourni." },
      { status: 400 }
    );
  }

  const paymentError = validatePaymentInput(body.payment);
  if (paymentError) {
    return NextResponse.json({ error: paymentError }, { status: 400 });
  }

  const vehicle = await getVehicleById(user.tenantId, body.vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }
  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }
  // Contrôle rapide non transactionnel (fast-fail, même principe que le contrôle de statut de
  // réservation plus haut) : un geste commercial est une décision financière discrétionnaire,
  // permission dédiée requise (locations.upgrade.commercial_gesture, voir src/lib/permissions.ts)
  // — les deux autres types de surclassement restent couverts par reservations.convert, déjà
  // vérifié en tout début de route.
  if (body.upgrade?.type === "COMMERCIAL_GESTURE" && !(await can(user, "locations.upgrade.commercial_gesture"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Étape 4 : réservation atomique de la conversion, avant toute écriture dépendante
      // (Sprint 26A, Finding A) — une conversion concurrente perdante échoue ici, avant
      // d'avoir rien créé.
      await claimReservationConversion(user.tenantId, reservation.id, tx);

      // Étape 5 : résolution du client (même logique de doublons que POST /api/clients, voir
      // DOMAINRULES.md section 9) — sur les valeurs saisies/vérifiées dans le formulaire de
      // conversion, pas sur les champs bruts (possiblement incomplets) de la réservation
      // importée. Toujours dans la transaction : une création/mise à jour de client qui ne
      // serait pas suivie d'une Location réussie ne doit jamais rester orpheline.
      // Correctif (campagne QA, 2026-08-27, passe de correction obligatoire) : `createClient`
      // ne journalise jamais lui-même (voir src/lib/clients.ts) — POST /api/clients journalise
      // "client.created" après coup, mais ce parcours de conversion ne l'a jamais fait, ni pour
      // le client principal ni pour le second conducteur. C'est précisément ce qui a rendu
      // l'origine du doublon "Omar Fictif-SecondCondValide" introuvable dans AuditLog lors de
      // l'investigation (voir INCIDENTS.md INC-13) : un client créé par ce parcours n'y laissait
      // aucune trace. `newlyCreatedClients` capture les clients réellement créés (jamais
      // réutilisés) pour journalisation après le commit, étape 12.
      const newlyCreatedClients: { id: string; name: string }[] = [];

      let clientId: string;
      if (body.useExistingClientId) {
        const existingClient = await getClientById(user.tenantId, body.useExistingClientId, tx);
        if (!existingClient) {
          throw new ClientNotFoundError();
        }

        const derivedName =
          clientInput.firstName || clientInput.lastName
            ? [clientInput.firstName ?? existingClient.firstName, clientInput.lastName ?? existingClient.lastName]
                .filter(Boolean)
                .join(" ")
                .trim() || undefined
            : undefined;

        await updateClient(
          user.tenantId,
          existingClient.id,
          {
            ...(derivedName ? { name: derivedName } : {}),
            ...(clientInput.firstName !== undefined ? { firstName: clientInput.firstName } : {}),
            ...(clientInput.lastName !== undefined ? { lastName: clientInput.lastName } : {}),
            ...(clientInput.email !== undefined ? { email: clientInput.email } : {}),
            ...(clientInput.phone !== undefined ? { phone: clientInput.phone } : {}),
            ...(clientInput.address !== undefined ? { address: clientInput.address } : {}),
            ...(clientInput.city !== undefined ? { city: clientInput.city } : {}),
            ...(clientInput.country !== undefined ? { country: clientInput.country } : {}),
            ...(clientInput.idNumber !== undefined ? { idNumber: clientInput.idNumber } : {}),
            ...(clientInput.idType !== undefined ? { idType: clientInput.idType } : {}),
            ...(clientInput.licenseNumber !== undefined ? { licenseNumber: clientInput.licenseNumber } : {}),
            ...(clientInput.licenseIssueDate !== undefined
              ? { licenseIssueDate: new Date(clientInput.licenseIssueDate) }
              : {}),
            ...(clientInput.licenseExpiryDate !== undefined
              ? { licenseExpiryDate: new Date(clientInput.licenseExpiryDate) }
              : {}),
            ...(clientInput.birthDate !== undefined ? { birthDate: new Date(clientInput.birthDate) } : {}),
          },
          tx
        );
        clientId = existingClient.id;
      } else {
        const duplicate = await findDuplicateClient(
          user.tenantId,
          {
            email: clientInput.email,
            phone: clientInput.phone,
            idNumber: clientInput.idNumber,
            licenseNumber: clientInput.licenseNumber,
            firstName: clientInput.firstName,
            lastName: clientInput.lastName,
          },
          tx
        );

        if (duplicate && !body.forceCreateClient) {
          throw new ConversionClientDuplicateError(duplicate);
        }

        const name = `${clientInput.firstName} ${clientInput.lastName}`.trim();
        const notes = duplicate
          ? `Créé malgré une correspondance possible avec ${duplicate.client.name} (conversion de la réservation ${reservation.voucherNumber}).`
          : undefined;

        const newClient = await createClient(
          {
            tenantId: user.tenantId,
            name,
            firstName: clientInput.firstName,
            lastName: clientInput.lastName,
            email: clientInput.email,
            phone: clientInput.phone,
            address: clientInput.address,
            city: clientInput.city,
            country: clientInput.country,
            idNumber: clientInput.idNumber,
            idType: clientInput.idType,
            licenseNumber: clientInput.licenseNumber,
            licenseIssueDate: clientInput.licenseIssueDate ? new Date(clientInput.licenseIssueDate) : undefined,
            licenseExpiryDate: clientInput.licenseExpiryDate ? new Date(clientInput.licenseExpiryDate) : undefined,
            birthDate: clientInput.birthDate ? new Date(clientInput.birthDate) : undefined,
            notes,
          },
          tx
        );
        clientId = newClient.id;
        newlyCreatedClients.push({ id: newClient.id, name: newClient.name });
      }

      // Étape 6 — second conducteur : reste "moindre enjeu" qu'un client principal (aucun flux
      // interactif de résolution de doublon comme à l'étape 5) — mais une correspondance
      // certaine (email/téléphone/idNumber/licenseNumber, jamais une correspondance floue sur
      // le nom) est désormais automatiquement réutilisée plutôt que de créer un doublon.
      // Correctif (campagne QA, 2026-08-27) : c'est exactement l'absence de ce contrôle qui a
      // produit un doublon réel de "Omar Fictif-SecondCondValide" pendant la campagne (le
      // second conducteur saisi correspondait déjà, champ pour champ, à un client existant) —
      // voir INCIDENTS.md. Une correspondance floue (nom seul) reste ignorée ici : trop
      // ambiguë pour une fusion automatique sans confirmation, et le second conducteur n'a de
      // toute façon pas de flux d'interface pour trancher un doublon probable.
      let secondDriverId: string | undefined;
      if (body.secondDriver?.firstName && body.secondDriver?.lastName) {
        const secondDriverDuplicate = await findDuplicateClient(
          user.tenantId,
          {
            phone: body.secondDriver.phone,
            idNumber: body.secondDriver.idNumber,
            licenseNumber: body.secondDriver.licenseNumber,
          },
          tx
        );

        if (secondDriverDuplicate?.matchType === "exact") {
          secondDriverId = secondDriverDuplicate.client.id;
        } else {
          const secondDriverClient = await createClient(
            {
              tenantId: user.tenantId,
              name: `${body.secondDriver.firstName} ${body.secondDriver.lastName}`.trim(),
              firstName: body.secondDriver.firstName,
              lastName: body.secondDriver.lastName,
              phone: body.secondDriver.phone,
              idNumber: body.secondDriver.idNumber,
              licenseNumber: body.secondDriver.licenseNumber,
              birthDate: body.secondDriver.birthDate ? new Date(body.secondDriver.birthDate) : undefined,
              notes: `Second conducteur (conversion de la réservation ${reservation.voucherNumber}).`,
            },
            tx
          );
          secondDriverId = secondDriverClient.id;
          newlyCreatedClients.push({ id: secondDriverClient.id, name: secondDriverClient.name });
        }
      }

      // Étape 6bis — surclassement (campagne QA, 2026-08-27) : résolu/validé avant la création
      // du contrat (fast-fail à l'intérieur même de la transaction) — voir
      // src/lib/location-upgrades.ts pour le détail complet des règles par type. `null` si le
      // véhicule choisi correspond à la catégorie réservée (aucun surclassement).
      const upgradeResolution = await resolveLocationUpgrade(
        {
          tenantId: user.tenantId,
          vehicle,
          reservedCategory: reservation.vehicleCategory ?? "",
          startDate,
          endDate,
          validatedByUserId: user.id,
          upgrade: body.upgrade,
        },
        tx
      );

      // Étape 7 : l'agence du contrat est dérivée du véhicule choisi côté serveur, jamais
      // d'un champ agencyId fourni par le client — même règle que POST /api/locations
      // (SECURITY.md section 4) : le sélecteur d'agence du formulaire de conversion ne sert
      // qu'à filtrer la liste de véhicules proposée, pas à fixer l'agence indépendamment du
      // véhicule choisi.
      const location = await createLocation(
        {
          tenantId: user.tenantId,
          agencyId: vehicle.agencyId,
          secondDriverId,
          totalPrice: body.totalPrice,
          // Sprint 19 : reprend l'agence de retour résolue de la réservation
          // (dropoffAgencyId, voir src/lib/reservations.ts) — ignorée par createLocation si
          // égale à agencyId, voir DOMAINRULES.md section 37.
          dropoffAgencyId: reservation.dropoffAgencyId,
          vehicleId: vehicle.id,
          clientId,
          startDate,
          endDate,
          notes: body.notes ?? reservation.notes ?? undefined,
          deposit: body.deposit,
          pricePerDay: body.pricePerDay,
          // Correctif (finding F-3) : voir le commentaire de ConvertBody.startOdometer plus haut.
          startOdometer: body.startOdometer,
          startFuelLevel: body.startFuelLevel,
        },
        tx
      );

      // Étape 7bis — surclassement (suite) : le supplément (recalculé côté serveur, jamais la
      // valeur cliente) s'ajoute au prix de base du contrat déjà calculé par createLocation
      // ci-dessus (pricePerDay/totalPrice de la Location = tarif du véhicule réellement choisi,
      // le supplément de surclassement est un montant strictement additionnel). Toujours dans
      // la même transaction que la création du contrat : createInvoice (étape 9) lira ensuite
      // Location.totalPrice déjà à jour, jamais l'ancien montant.
      let locationForInvoice = location;
      let createdUpgrade: Awaited<ReturnType<typeof tx.locationUpgrade.create>> | null = null;
      if (upgradeResolution.data) {
        createdUpgrade = await tx.locationUpgrade.create({
          data: {
            ...upgradeResolution.data,
            tenantId: user.tenantId,
            locationId: location.id,
            reservationId: reservation.id,
            vehicleId: vehicle.id,
            currency: location.currency,
          },
        });
        locationForInvoice = await tx.location.update({
          where: { id: location.id },
          data: { totalPrice: location.totalPrice + upgradeResolution.data.totalSupplement },
        });
      }

      // Étape 8 : rattachement Reservation.convertedLocationId (la réservation est déjà
      // CONVERTED depuis l'étape 4, dans cette même transaction non commitée).
      const updatedReservation = await markReservationConverted(user.tenantId, reservation.id, location.id, tx);

      // Étape 9 — génération de facture : plus de résilience dans ce flux précis (Sprint 26A,
      // Finding A) — un échec fait désormais rollback de toute la conversion, contrairement à
      // POST /api/locations (Sprint 12B, non touché par ce sprint, toujours résilient).
      const invoice = await createInvoice({ tenantId: user.tenantId, locationId: location.id }, tx);

      // Étape 10-11 — paiement intégré éventuel (même logique que POST /api/locations,
      // Sprint 13A — src/lib/location-payment.ts, comportement interne inchangé). Un
      // paymentError (ex. solde dépassé) est ici transformé en échec de la transaction —
      // aucun contrat/facture créés sans le paiement demandé par l'agent, sans jamais avoir
      // modifié processLocationPayment/createPayment eux-mêmes (voir ConversionPaymentError
      // ci-dessus).
      let payments: Awaited<ReturnType<typeof processLocationPayment>>["payments"] = [];
      let finalInvoice = invoice;
      if (body.payment && !body.payment.deferred) {
        const paymentResult = await processLocationPayment(
          { tenantId: user.tenantId, userId: user.id, invoice, payment: body.payment },
          tx
        );
        if (paymentResult.paymentError) {
          throw new ConversionPaymentError(paymentResult.paymentError);
        }
        finalInvoice = paymentResult.invoice;
        payments = paymentResult.payments;
      }

      return {
        reservation: updatedReservation,
        location: locationForInvoice,
        invoice: finalInvoice,
        payments,
        upgrade: createdUpgrade,
        newlyCreatedClients,
      };
    });

    // Étape 12 : la transaction a commité avec succès — journalisation après coup uniquement
    // (jamais avant l'ouverture/pendant la transaction), pour ne jamais journaliser une
    // entité qui aurait été annulée par un rollback. payment.created reste journalisé à
    // l'intérieur de processLocationPayment (best-effort, non transactionnel, inchangé).
    // Correctif (campagne QA, 2026-08-27, passe de correction obligatoire, INC-13) : journalise
    // désormais tout client (principal et/ou second conducteur) réellement créé par cette
    // conversion — même action/forme que POST /api/clients ("client.created"), jamais
    // journalisée jusqu'ici sur ce parcours (voir le commentaire de newlyCreatedClients
    // ci-dessus). Un client réutilisé (useExistingClientId ou correspondance exacte du second
    // conducteur) n'est jamais journalisé ici : aucune écriture Client ne s'est produite.
    for (const created of result.newlyCreatedClients) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "client.created",
        resource: "Client",
        resourceId: created.id,
        metadata: { name: created.name, fromReservationId: reservation.id },
      });
    }
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "reservation.converted",
      resource: "Reservation",
      resourceId: reservation.id,
      metadata: { locationId: result.location.id, clientId: result.location.clientId },
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "location.created",
      resource: "Location",
      resourceId: result.location.id,
      metadata: {
        vehicleId: result.location.vehicleId,
        clientId: result.location.clientId,
        fromReservationId: reservation.id,
      },
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "invoice.created",
      resource: "Invoice",
      resourceId: result.invoice.id,
      metadata: { number: result.invoice.number, locationId: result.invoice.locationId, auto: true },
    });
    // Campagne QA (2026-08-27, passe de correction obligatoire) : audit dédié du surclassement
    // (Partie G) — utilisateur/tenant déjà portés par logAction, agence dérivée du contrat,
    // date/heure = AuditLog.createdAt. Aucune donnée bancaire, uniquement les champs métier du
    // surclassement lui-même.
    if (result.upgrade) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "location.upgraded",
        resource: "Location",
        resourceId: result.location.id,
        metadata: {
          agencyId: result.location.agencyId,
          reservationId: reservation.id,
          vehicleId: result.location.vehicleId,
          upgradeType: result.upgrade.type,
          reservedCategory: result.upgrade.reservedCategory,
          assignedCategory: result.upgrade.assignedCategory,
          dailySupplement: result.upgrade.dailySupplement,
          daysCount: result.upgrade.daysCount,
          totalSupplement: result.upgrade.totalSupplement,
          currency: result.upgrade.currency,
          customerConsent: result.upgrade.customerConsent,
          operationalReason: result.upgrade.operationalReason,
        },
      });
    }

    return NextResponse.json(
      {
        reservation: result.reservation,
        location: result.location,
        invoice: result.invoice,
        payments: result.payments,
        upgrade: result.upgrade,
        paymentError: null,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ConversionClientDuplicateError) {
      return NextResponse.json(
        {
          duplicate: {
            client: error.duplicate.client,
            matchType: error.duplicate.matchType,
            field: error.duplicate.field,
          },
        },
        { status: 409 }
      );
    }
    if (error instanceof InvalidDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof VehicleNotFoundError || error instanceof ClientNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VehicleNotAvailableError) {
      return NextResponse.json(
        { error: error.message, conflictingLocations: error.conflictingLocations },
        { status: 409 }
      );
    }
    // Sprint 28 (Finding E) : la conversion réutilise createLocation (Finding A/C) — même
    // garde véhicule MAINTENANCE/TRANSFERRING/ON_TRIP, aucune exception pour cette route.
    if (error instanceof VehicleUnavailableForLocationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 1/2/7) : la conversion réutilise
    // createLocation — même garde chevauchement maintenance qu'une création directe, aucune
    // exception pour cette route (une réservation convertie est toujours une nouvelle Location).
    if (error instanceof VehicleMaintenanceConflictError) {
      return NextResponse.json(
        { error: error.message, conflictingMaintenances: error.conflictingMaintenances },
        { status: 409 }
      );
    }
    if (error instanceof InvalidReservationStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ReservationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof MissingPriceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Campagne QA (2026-08-27, passe de correction obligatoire) : surclassement, voir
    // src/lib/location-upgrades.ts — toutes ces erreurs sont levées avant toute écriture
    // dépendante (client/second conducteur déjà créés dans la même transaction, annulés par
    // le rollback), même garantie que le reste des erreurs de ce bloc.
    if (
      error instanceof InvalidUpgradeTypeError ||
      error instanceof UpgradeNotNeededError ||
      error instanceof UpgradeDeclarationRequiredError ||
      error instanceof UpgradeReasonRequiredError ||
      error instanceof UpgradeConsentRequiredError ||
      error instanceof UpgradeSupplementInvalidError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UpgradeCategoryStillAvailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Correctif (finding F-3) : startFuelLevel validé par createLocation (validateFuelLevel),
    // même statut/forme de réponse que sur POST /api/locations.
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Sprint 29 (DOMAINRULES.md section 44, point 16) : la conversion réutilise createLocation
    // (via la transaction partagée) — même garde permis du client principal, aucune exception
    // pour cette route ; le rollback de la transaction (client/second conducteur/réservation
    // réclamée) est garanti par Prisma, comme pour toute autre erreur levée ici.
    if (error instanceof MissingDriverLicenseExpiryError || error instanceof DriverLicenseExpiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Sprint 30 (DOMAINRULES.md section 45, point 7) : âge réel du client principal et/ou du
    // second conducteur (créé à l'étape 6 ci-dessus, transaction partagée) — même rollback
    // complet garanti par Prisma que pour MissingDriverLicenseExpiryError.
    if (
      error instanceof MissingDriverBirthDateError ||
      error instanceof InvalidDriverBirthDateError ||
      error instanceof DriverUnderMinimumAgeError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ConversionPaymentError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la conversion de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
