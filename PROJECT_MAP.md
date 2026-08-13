# PROJECT_MAP.md — Cartographie du projet

Ce document décrit la structure **réelle** actuelle du dépôt, puis une structure **cible indicative** pour les futurs domaines métier. La structure cible n'est **pas** implémentée : elle sert de repère, pas d'inventaire de fichiers existants.

## 1. Structure actuelle des dossiers (existante)

```
xrent-manager/
├── public/                  # Assets statiques par défaut (SVG de démo create-next-app)
│   ├── file.svg
│   ├── globe.svg
│   ├── next.svg
│   ├── vercel.svg
│   └── window.svg
├── prisma/
│   ├── schema.prisma        # Tenant (Sprint 14B : contractNumberPrefix/lastContractNumber), Agency (Sprint 12A : coordonnées pro), User (passwordHash, role ; Sprint 12C : phone/avatar/permissionGroupId), UserAgency, Client (Sprint 12A : identité/permis), Vehicle (Sprint 12A : fiche technique ; Sprint 14A : pricePerDay optionnel/informatif ; Sprint 14C : VehicleStatus +TRANSFERRING/ON_TRIP), Location (Sprint 12A : kilométrage/caution ; Sprint 14B : contractNumber unique par tenant), Invoice, Payment, Maintenance, Alert (Sprint 14C : +6 AlertType), Invitation, AuditLog, Reservation (Sprint 12C), PermissionGroup/GroupPermission/UserPermission (Sprint 12C), CashRegister/CashEntry (Sprint 13A ; Sprint 14B : CashEntry.contractNumber)/ExpenseCategory (Sprint 13A), VehicleTransfer/VehicleTrip (Sprint 14C, nouveaux), Account, Session, VerificationToken
│   └── migrations/
│       ├── migration_lock.toml
│       ├── 20260811133155_init_tenant_agency_user/
│       │   └── migration.sql
│       ├── 20260811141912_add_nextauth_models_and_user_auth_fields/
│       │   └── migration.sql
│       ├── 20260811201341_add_vehicle_and_location_models/
│       │   └── migration.sql
│       ├── 20260811203931_change_default_currency_to_mad/
│       │   └── migration.sql
│       ├── 20260811205048_add_invoice_and_payment_models/
│       │   └── migration.sql
│       ├── 20260812090456_add_maintenance_and_alert_models/
│       │   └── migration.sql
│       ├── 20260812101414_add_invitation_and_audit_log_models/
│       │   └── migration.sql
│       ├── 20260812170214_add_sprint12a_professional_fields/
│       │   └── migration.sql
│       ├── 20260812181105_add_sprint12c_reservations_and_permissions/
│       │   └── migration.sql
│       ├── 20260813001505_add_sprint13a_cash_register/
│       │   └── migration.sql
│       ├── 20260813112824_add_sprint14a_vehicle_price_optional/
│       │   └── migration.sql
│       ├── 20260813150025_add_sprint14b_contract_numbering/
│       │   └── migration.sql
│       └── 20260813143449_add_sprint14c_transfers_trips/
│           └── migration.sql
├── components.json          # Config shadcn/ui (style base-nova, alias @/components, @/lib, @/hooks)
├── src/
│   ├── app/                 # App Router Next.js
│   │   ├── favicon.ico
│   │   ├── globals.css      # Styles Tailwind + tokens shadcn/ui (générés par `shadcn init`)
│   │   ├── layout.tsx       # Layout racine (police Inter — Geist jusqu'au Sprint 13E —, <Toaster /> global sonner) — page d'accueil / toujours celle par défaut create-next-app
│   │   ├── page.tsx         # Page d'accueil par défaut (démo create-next-app, non modifiée)
│   │   ├── (auth)/          # Groupe de routes auth (URLs /login, /register — pas de préfixe)
│   │   │   ├── layout.tsx          # Layout centré, sans sidebar
│   │   │   ├── login/
│   │   │   │   ├── page.tsx        # Server wrapper + <Suspense> (callbackUrl via useSearchParams)
│   │   │   │   └── LoginForm.tsx   # Client Component : signIn("credentials", …) de next-auth/react
│   │   │   └── register/page.tsx   # Client Component : POST /api/auth/register
│   │   ├── invitations/            # (Sprint 9) Route publique, hors (auth)/dashboard — pas de session requise
│   │   │   ├── layout.tsx          # Layout centré minimal (même style que (auth)/layout.tsx)
│   │   │   └── [id]/
│   │   │       ├── page.tsx        # Server Component : lit l'invitation, affiche AcceptInvitationForm ou un statut terminal
│   │   │       └── AcceptInvitationForm.tsx  # Client Component : POST accept/decline
│   │   ├── dashboard/
│   │   │   ├── layout.tsx          # Server Component : session+tenant, redirige /login si non authentifié ; (Sprint 11) enveloppe dans <SessionProvider>
│   │   │   ├── page.tsx            # Stats (agences/users), actions rapides
│   │   │   ├── loading.tsx         # Skeleton
│   │   │   ├── tenants/            # (Sprint 11) plus de new/ — création de tenant exclusive à /api/auth/register, voir HANDOFF.md point 36
│   │   │   │   ├── page.tsx, TenantsTable.tsx, loading.tsx
│   │   │   │   └── [id]/page.tsx, EditTenantForm.tsx
│   │   │   ├── agencies/
│   │   │   │   ├── page.tsx, AgenciesTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, EditAgencyForm.tsx
│   │   │   ├── users/              # (Sprint 9) CRUD rôle/suppression, garde "dernier ADMIN"
│   │   │   │   ├── page.tsx, UsersTable.tsx, loading.tsx
│   │   │   │   └── [id]/page.tsx, EditUserForm.tsx
│   │   │   │       └── permissions/page.tsx, UserPermissionsForm.tsx  # (Sprint 12C) groupe + permissions individuelles
│   │   │   ├── invitations/        # (Sprint 9) Liste ADMIN + création + lien partageable + révocation
│   │   │   │   └── page.tsx, InvitationsPanel.tsx
│   │   │   ├── permissions/        # (Sprint 12C) Catalogue des permissions en lecture seule — ADMIN uniquement
│   │   │   │   └── page.tsx
│   │   │   ├── permission-groups/  # (Sprint 12C) CRUD des groupes de permissions — ADMIN uniquement
│   │   │   │   ├── page.tsx, PermissionGroupsPanel.tsx, PermissionCheckboxGrid.tsx
│   │   │   │   └── [id]/page.tsx, EditPermissionGroupForm.tsx
│   │   │   ├── audit/              # (Sprint 9) Journal d'audit — ADMIN uniquement ; (Sprint 10) exhaustif + filtres ; (Sprint 12C) icônes/couleurs par action, filtre par date, export CSV
│   │   │   │   └── page.tsx
│   │   │   ├── vehicles/           # (Sprint 5) CRUD complet, scopé agence
│   │   │   │   ├── page.tsx, VehiclesTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, EditVehicleForm.tsx
│   │   │   ├── locations/          # (Sprint 5) CRUD complet, machine à états, scopé agence
│   │   │   │   ├── page.tsx, LocationsTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, LocationActions.tsx
│   │   │   ├── reservations/       # (Sprint 12C) CRUD, machine à états, import Excel, conversion en contrat — permissions.view/create/edit/delete/import/convert ; (Sprint 13B) affichage complet (16 colonnes) + filtres date/recherche étendue, import Excel en-têtes français ; (Sprint 13D) refonte du flux réservation → contrat : boutons d'action explicites (Confirmer/Convertir en contrat/Annuler/Voir le contrat/Télécharger PDF), formulaire de conversion dédié ; (Sprint 14A) sélection multiple + suppression en masse dans `ReservationsTable.tsx`, colonnes redimensionnées/en-têtes multi-lignes, filtres `pickupAgency`/`dropoffAgency`/`vehicleCategory`, villes de départ/retour en listes déroulantes (`/new`) dérivées des agences réelles
│   │   │   │   ├── page.tsx, ReservationsTable.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   ├── import/page.tsx, columns.ts
│   │   │   │   └── [id]/page.tsx, ReservationActions.tsx  # (Sprint 13D) ConvertReservationCard.tsx supprimé — remplacé par convert/page.tsx, ConvertReservationForm.tsx
│   │   │   │       └── convert/page.tsx, ConvertReservationForm.tsx  # (Sprint 13D) formulaire de conversion pré-rempli — véhicule/agence réels, identité client, paiement
│   │   │   ├── clients/            # (Sprint 8) CRUD complet, tenant-scopé sans notion d'agence ; (Sprint 12C) détection de doublons
│   │   │   │   ├── page.tsx, ClientsTable.tsx, loading.tsx, DuplicateCheck.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, EditClientForm.tsx
│   │   │   ├── vehicle-transfers/  # (Sprint 14C, nouveau) Transfert d'un véhicule entre agences — création lance (IN_TRANSIT), validation reçoit et met à jour l'agence
│   │   │   │   ├── page.tsx, VehicleTransfersTable.tsx
│   │   │   │   └── new/page.tsx
│   │   │   ├── vehicle-trips/      # (Sprint 14C, nouveau) Bon de déplacement interne — départ auto, retour exige kilométrage > départ
│   │   │   │   ├── page.tsx, VehicleTripsTable.tsx
│   │   │   │   └── new/page.tsx
│   │   │   ├── maintenances/       # (Sprint 7) CRUD, machine à états, historique conservé ; (Sprint 14C) vue "État des véhicules" (VehicleStatusOverviewTable.tsx, nouveau) en plus de l'historique — immatriculation/état réel/date de retour si loué/disponibilité, filtres en en-têtes
│   │   │   │   ├── page.tsx, MaintenancesTable.tsx, VehicleStatusOverviewTable.tsx, loading.tsx
│   │   │   │   └── new/page.tsx
│   │   │   ├── alerts/             # (Sprint 7) Liste triée priorité+date, acknowledge/resolve ; (Sprint 14C) 6 nouveaux types (CONTRACT_AT_RISK/PAYMENT_DUE/VEHICLE_UNAVAILABLE/RETURN_OVERDUE/DOCUMENT_EXPIRED/STOCK_INCONSISTENCY)
│   │   │   │   ├── page.tsx, AlertsList.tsx, loading.tsx
│   │   │   ├── invoices/           # (Sprint 6) CRUD, machine à états, PDF, paiements
│   │   │   │   ├── page.tsx, InvoicesTable.tsx, loading.tsx
│   │   │   │   ├── new/page.tsx
│   │   │   │   └── [id]/page.tsx, InvoiceActions.tsx
│   │   │   ├── payments/           # (Sprint 6) Liste + filtres (lecture seule, création via facture)
│   │   │   │   ├── page.tsx, PaymentsTable.tsx, loading.tsx
│   │   │   ├── cash-register/      # (Sprint 13A) Caisse — solde recalculé depuis les écritures réelles
│   │   │   │   ├── page.tsx, CashRegisterCharts.tsx, loading.tsx
│   │   │   │   ├── entries/page.tsx, EntriesTable.tsx, NewEntryForm.tsx
│   │   │   │   └── expenses/page.tsx, ExpensesTable.tsx, NewExpenseForm.tsx
│   │   │   ├── reports/            # (Sprint 6) KPIs, graphiques (recharts), export CSV — ADMIN uniquement
│   │   │   │   ├── page.tsx, ReportsCharts.tsx, ExportCsvButton.tsx, loading.tsx
│   │   │   └── settings/            # Nom du tenant (éditable, ADMIN) ; (Sprint 10) profil user éditable ; (Sprint 14D) reset de données
│   │   │       └── page.tsx, EditProfileForm.tsx, DataResetCard.tsx  # (Sprint 11) EditProfileForm appelle useSession().update() après un PATCH réussi (nom/email) ; (Sprint 14D, nouveau) DataResetCard.tsx — carte « Zone dangereuse », ADMIN uniquement
│   │   └── api/
│   │       ├── auth/
│   │       │   ├── [...nextauth]/route.ts  # Handler NextAuth (GET/POST)
│   │       │   ├── register/route.ts       # POST — crée un tenant + son premier user (ADMIN)
│   │       │   ├── login/route.ts          # POST — connexion email/password
│   │       │   ├── logout/route.ts         # POST — déconnexion
│   │       │   └── me/route.ts             # GET — user connecté (401 sinon)
│   │       ├── tenants/
│   │       │   ├── route.ts                # GET (liste, ADMIN, son propre tenant uniquement)/POST (ADMIN)
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE — scopé au tenant de l'ADMIN connecté
│   │       ├── agencies/
│   │       │   ├── route.ts                # GET (liste du tenant connecté)/POST (ADMIN)
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE — scopé tenant + agence (UserAgency)
│   │       ├── users/
│   │       │   ├── route.ts                # GET — liste du tenant, ADMIN uniquement (Sprint 4)
│   │       │   ├── directory/route.ts      # (Sprint 14C, nouveau) GET — annuaire minimal (id+name), ouvert à tout user du tenant (choix d'un responsable/employé transfert/déplacement)
│   │       │   ├── [id]/
│   │       │   │   ├── route.ts            # (Sprint 9) GET/PATCH (rôle, réinitialisation mot de passe)/DELETE — ADMIN uniquement, garde "dernier ADMIN"
│   │       │   │   └── permissions/route.ts # (Sprint 12C) GET/PATCH — groupe + permissions individuelles, ADMIN uniquement
│   │       │   └── me/route.ts             # (Sprint 10) GET/PATCH — profil de l'user connecté (nom/email/mot de passe, vérifie l'ancien) ; (Sprint 12C) phone/avatar, jamais un autre user
│   │       ├── invitations/                # (Sprint 9)
│   │       │   ├── route.ts                # GET (liste, ADMIN)/POST (création, ADMIN)
│   │       │   └── [id]/
│   │       │       ├── route.ts            # GET (public, champs non sensibles)/DELETE (révocation, ADMIN)
│   │       │       ├── accept/route.ts     # POST — public, crée le user (email/rôle toujours dérivés de l'invitation)
│   │       │       └── decline/route.ts    # POST — public
│   │       ├── permission-groups/          # (Sprint 12C)
│   │       │   ├── route.ts                # GET (liste, backfill ensureDefaultGroups)/POST — ADMIN uniquement
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE — bloqué si des users sont encore rattachés
│   │       ├── audit/route.ts              # (Sprint 9) GET — journal d'audit du tenant, ADMIN uniquement ; (Sprint 10) filtre action ajouté ; (Sprint 12C) filtres from/to
│   │       ├── vehicles/                   # (Sprint 5)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — scopé tenant + agence
│   │       │   └── [id]/
│   │       │       ├── route.ts            # GET/PATCH/DELETE (bloqué si locations existantes)
│   │       │       └── availability/route.ts  # GET — disponibilité sur une période
│   │       ├── locations/                  # (Sprint 5)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — vérifie disponibilité, calcule totalPrice
│   │       │   └── [id]/route.ts           # GET/PATCH (statut/dates/notes)/DELETE (si PENDING/CANCELLED)
│   │       ├── clients/                    # (Sprint 5 : route.ts ; Sprint 8 : [id]/route.ts + page dédiée)
│   │       │   ├── route.ts                # GET (liste, filtre search)/POST — tenant-scopé, pas d'agencyId
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE (bloqué si locations existantes)
│   │       ├── maintenances/               # (Sprint 7)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — agencyId/currency dérivés du véhicule
│   │       │   └── [id]/route.ts           # GET/PATCH (statut/dates/coût/notes)/DELETE (si SCHEDULED)
│   │       ├── vehicle-transfers/          # (Sprint 14C, nouveau)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — lance le transfert (IN_TRANSIT), fromAgencyId dérivé du véhicule, véhicule → TRANSFERRING
│   │       │   └── [id]/
│   │       │       ├── route.ts            # GET
│   │       │       ├── validate/route.ts   # PATCH — réception à l'agence d'arrivée : véhicule rattaché + AVAILABLE
│   │       │       └── cancel/route.ts     # PATCH — annulation, véhicule → AVAILABLE (reste à l'agence de départ)
│   │       ├── vehicle-trips/              # (Sprint 14C, nouveau)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — départ auto (ON_TRIP), agencyId dérivé du véhicule
│   │       │   └── [id]/
│   │       │       ├── route.ts            # GET
│   │       │       ├── return/route.ts     # PATCH — retour, exige endOdometer > startOdometer, véhicule → AVAILABLE
│   │       │       └── cancel/route.ts     # PATCH — annulation, véhicule → AVAILABLE
│   │       ├── alerts/                     # (Sprint 7)
│   │       │   ├── route.ts                # GET (liste, filtres type/priority/status) ; (Sprint 14C) 6 nouveaux AlertType
│   │       │   └── [id]/
│   │       │       ├── acknowledge/route.ts   # PATCH — PENDING → ACKNOWLEDGED
│   │       │       └── resolve/route.ts       # PATCH — PENDING|ACKNOWLEDGED → RESOLVED
│   │       ├── tasks/
│   │       │   └── check-alerts/route.ts   # (Sprint 7) POST — déclenche les vérifications, réservé ADMIN, scopé au tenant connecté ; (Sprint 14C) 6 vérifications supplémentaires (9 au total)
│   │       ├── invoices/                   # (Sprint 6)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — dérive agencyId/clientId/currency de la Location
│   │       │   └── [id]/
│   │       │       ├── route.ts            # GET/PATCH (statut/TVA/remise/notes)/DELETE (si DRAFT sans paiement)
│   │       │       └── pdf/route.tsx       # GET — PDF (@react-pdf/renderer), extension .tsx (JSX dans un route handler)
│   │       ├── payments/                   # (Sprint 6)
│   │       │   ├── route.ts                # GET (liste, filtres)/POST — valide amount ≤ solde restant, recalcule la facture
│   │       │   └── [id]/route.ts           # GET/PATCH/DELETE — recalcule systématiquement amountPaid/status de la facture
│   │       ├── cash-register/              # (Sprint 13A)
│   │       │   ├── route.ts                # GET (solde recalculé + répartition/jour + 10 dernières opérations)/POST (crée une écriture ENTRY/EXPENSE)
│   │       │   ├── entries/route.ts        # GET — écritures ENTRY, filtres catégorie/dates
│   │       │   ├── expenses/route.ts       # GET — écritures EXPENSE, filtres catégorie/dates
│   │       │   └── categories/route.ts     # GET (liste)/POST (création) — ExpenseCategory, pas de PATCH/DELETE
│   │       ├── reports/                    # (Sprint 6) GET, réservées ADMIN
│   │       │   ├── revenue/route.ts        # Revenu encaissé (Payment), par mois, sur une période
│   │       │   └── vehicles/route.ts       # Utilisation véhicule + classement par revenu facturé
│   │       └── reservations/               # (Sprint 12C)
│   │           ├── route.ts                # GET (liste, filtres)/POST — permissions.view/create
│   │           ├── [id]/
│   │           │   ├── route.ts            # GET/PATCH/DELETE — permissions.view/edit/delete
│   │           │   └── convert/route.ts    # POST — crée Client(résolu/créé)+Location+Invoice+Payment(s), permissions.convert ; (Sprint 13D) nouveau contrat de corps de requête (véhicule+dates+identité client complète+paiement), voir DOMAINRULES.md section 26
│   │           └── import/route.ts         # POST — .xlsx (exceljs), mode preview/commit, permissions.import ; (Sprint 13B) en-têtes français, mapping vers champ interne avant parsing
│   ├── proxy.ts              # Redirige vers /login sur /dashboard*, /settings* si non authentifié (middleware.ts est déprécié dans cette version de Next.js)
│   ├── components/
│   │   ├── ui/               # Composants shadcn/ui (générés) + index.ts (ré-export) ; (Sprint 12A) phone-input.tsx — composant interne (pas de dépendance npm), indicatif pays + numéro ; (Sprint 12C) checkbox.tsx (grille de permissions) ; (Sprint 13B) StatusBadge.tsx — badge de statut coloré partagé Reservation/Location ; (Sprint 13C) phone-input.tsx étendu — 20 indicatifs (Maroc en tête), recherche, dernier pays mémorisé en localStorage via useSyncExternalStore ; (Sprint 13E) button.tsx/card.tsx étendus (animations de clic/survol, `rounded-2xl`/`border-slate-100`, prop `hoverable` sur Card) — pas de nouveaux composants, voir HANDOFF.md ; (Sprint 14A) label.tsx étendu — prop `required` (astérisque rouge décoratif)
│   │   ├── layout/            # Sidebar.tsx, Header.tsx (Sprint 12B : DropdownMenuLabel enveloppé dans DropdownMenuGroup, correctif bug déconnexion Base UI), DashboardLayout.tsx, DataTable.tsx (TanStack Table v9) ; (Sprint 13E) BottomNav.tsx — navigation rapide mobile (4 entrées, `md:hidden`), complète Sidebar.tsx (tiroir hamburger, 18 entrées) sans le remplacer ; Sidebar.tsx/Header.tsx : cibles tactiles mobiles ≥48px ; (Sprint 14A) Sidebar.tsx — entrées alignées sur la vérification réellement appliquée par leur page/route cible (`adminOnly` pour les modules role-only, `permission` réservé à Réservations, seul module réellement gated par `can()`), correctif d'un sur/sous-masquage ; (Sprint 14C) Sidebar.tsx — entrées « Transferts »/« Déplacements » ajoutées (aucune restriction, comme Maintenances/Alertes/Caisse) ; DataTable.tsx — retour à la ligne des en-têtes + largeur de colonne optionnelle (`columnDef.size`, `columnSizingFeature` enregistrée), réutilisable par toute table ; (Sprint 14E) `defaultColumn: { size: undefined }` ajouté à `useTable()` — corrige un bug où `columnSizingFeature` fusionnait silencieusement `size: 150` dans **toute** colonne (y compris sans `size` déclaré), provoquant un wrap anarchique des en-têtes ; `align-bottom` → `align-middle`, wrap sans `break-words` (coupure aux espaces uniquement)
│   │   ├── invoices/          # (Sprint 6) InvoicePdf.tsx — template @react-pdf/renderer (pas de logo, aucun asset de marque) ; (Sprint 14B) InvoicePdfPage extraite (contenu de la page sans <Document>, réutilisable dans un PDF de lot), affiche désormais le numéro de contrat
│   │   └── contracts/         # (Sprint 14B, nouveau) ContractPdf.tsx/ContractPdfPage — template PDF du contrat (même style qu'InvoicePdf, pas de logo)
│   ├── hooks/
│   │   ├── useUser.ts        # Lecture client de GET /api/auth/me
│   │   └── useTenant.ts      # Lecture client de GET /api/tenants
│   ├── lib/
│   │   ├── prisma.ts        # Singleton PrismaClient (gère le hot reload Next.js)
│   │   ├── db.ts            # getTenantById, getAgencyById, getUserById — scopés tenantId
│   │   ├── auth.ts          # Config NextAuth (CredentialsProvider, sessions JWT, callbacks jwt/session/signIn)
│   │   ├── authz.ts         # getSessionUser(), canAccessAgency(), getAccessibleAgencyIds() — session + autorisation agence ; (Sprint 14A) getSessionUser() relit `role` frais en base à chaque appel (JWT figé au login sinon) — un changement de rôle s'applique immédiatement sans reconnexion, referme une fenêtre de sécurité
│   │   ├── api.ts           # Wrapper fetch pour /api/* (normalise les erreurs { error })
│   │   ├── format.ts        # (Sprint 5) formatMoney() — formatage des montants entiers + devise ; (Sprint 13B) combineDateAndTime()/calculateDaysCount() — fonctions pures (pas d'import Prisma), utilisables depuis un composant client, réexportées par reservations.ts
│   │   ├── clients.ts       # (Sprint 5 : getClients/getClientById/createClient ; Sprint 8 : updateClient/deleteClient ; Sprint 12C : findDuplicateClient — exact email/téléphone/CIN/permis + fuzzy nom Levenshtein) — tenant-scopé
│   │   ├── vehicles.ts      # (Sprint 5) CRUD + checkAvailability — tenant/agence-scopé ; (Sprint 14A) pricePerDay optionnel (informatif)
│   │   ├── locations.ts     # (Sprint 5) CRUD + calculateTotalPrice + machine à états (canTransition) ; (Sprint 14A) createLocation accepte un pricePerDay explicite (retombe sur celui du véhicule, sinon MissingPriceError) — le véhicule n'est plus jamais la seule source du prix ; (Sprint 14B) generateContractNumber (compteur Tenant.lastContractNumber, réessai sur collision) ; updateLocation refuse startDate/endDate hors PENDING (LocationLockedError)
│   │   ├── invoices.ts      # (Sprint 6) CRUD + génération numéro (INV-{année}-{5 chiffres}) + calcul TVA/remise/total + machine à états
│   │   ├── payments.ts      # (Sprint 6) CRUD + recomputeInvoiceStatus (recalcule toujours amountPaid/status de la facture depuis les paiements réels) ; (Sprint 14B) PaymentExceedsRemainingBalanceError toujours formatée en devise (jamais un entier brut de centimes)
│   │   ├── reports.ts       # (Sprint 6) getRevenueReport, getVehicleUtilizationReport, getTopVehicles ; (Sprint 12C) getLocationsByMonth, getRevenueByAgency, getOverallOccupancyRate, getReservationsByStatus — tenant-scopé
│   │   ├── maintenances.ts  # (Sprint 7) CRUD + machine à états + getDueMaintenances + createMaintenanceFromSchedule
│   │   ├── vehicle-transfers.ts # (Sprint 14C, nouveau) createVehicleTransfer/validateVehicleTransfer/cancelVehicleTransfer — machine à états IN_TRANSIT→COMPLETED|CANCELLED, met à jour Vehicle.status/agencyId en transaction
│   │   ├── vehicle-trips.ts     # (Sprint 14C, nouveau) createVehicleTrip/returnVehicleTrip/cancelVehicleTrip — machine à états IN_PROGRESS→COMPLETED|CANCELLED, retour exige endOdometer > startOdometer
│   │   ├── alerts.ts        # (Sprint 7) CRUD (sans delete) + machine à états (acknowledge/resolve) + getPendingAlerts
│   │   ├── scheduled-tasks.ts # (Sprint 7) checkDueMaintenances/checkReturnsToday/checkOverdueInvoices — génération idempotente d'alertes ; (Sprint 14C) +checkContractsAtRisk/checkPaymentsDue/checkVehiclesUnavailable/checkOverdueReturns/checkExpiredDocuments/checkStockInconsistencies
│   │   ├── users.ts         # (Sprint 9) updateUserRole/resetUserPassword/deleteUser — garde "dernier ADMIN", nettoyage UserAgency/Alert ; (Sprint 10) updateUserProfile (nom/email/mot de passe, vérifie l'ancien) ; (Sprint 12C) + phone/avatar ; (Sprint 13C) getUserAgencyIds/setUserAgencies — corrige le bug MEMBER sans véhicules visibles (aucun code ne créait jamais de UserAgency avant ce sprint)
│   │   ├── invitations.ts   # (Sprint 9) createInvitation/acceptInvitation/declineInvitation/revokeInvitation — email/rôle toujours dérivés de l'invitation
│   │   ├── audit.ts         # (Sprint 9) logAction/getAuditLogs — n'échoue jamais l'action métier appelante ; (Sprint 10) filtre action, câblé sur tout le CRUD métier (vehicles/locations/clients/invoices/payments/maintenances/alerts, voir routes API correspondantes) ; (Sprint 12C) filtres from/to
│   │   ├── password-policy.ts # (Sprint 9) validatePassword() — min 8 caractères + majuscule + chiffre + spécial
│   │   ├── reservations.ts  # (Sprint 12C) CRUD + machine à états + parsing d'import Excel (parseReservationImportRow) + combineDateAndTime ; (Sprint 13B) en-têtes d'import en français (RESERVATION_IMPORT_COLUMN_MAP), erreurs de colonne obligatoire précises par champ ; (Sprint 13C) generateDirectVoucherNumber — Dir-0001, Dir-0002... pour une réservation source DIRECT sans voucherNumber fourni ; (Sprint 14A) cellToDate gère les numéros de série Excel et les dates DD/MM/YYYY, nouvelle cellToTime (corrige les heures stockées comme cellule Date), erreurs distinguant date manquante/invalide, getKnownAgencyNames + validation pickupAgency/dropoffAgency contre les agences réelles (import et création manuelle), filtres pickupAgency/dropoffAgency/vehicleCategory sur getReservations
│   │   ├── permissions.ts   # (Sprint 12C) catalogue PERMISSIONS (code, pas de table) + groupes par défaut + can()/getEffectivePermissions() + CRUD PermissionGroup + assignation par user
│   │   ├── cash-register.ts # (Sprint 13A) CashRegister (singleton par tenant)/CashEntry (append-only)/ExpenseCategory — recomputeCashRegisterBalance recalcule toujours previousBalance/currentMonth/currentBalance depuis les CashEntry réels (jamais un compteur incrémenté), même principe que recomputeInvoiceStatus
│   │   ├── location-payment.ts # (Sprint 13D, nouveau) validatePaymentInput/processLocationPayment — logique de paiement intégré extraite de POST /api/locations (Sprint 13A) pour être réutilisée telle quelle par POST /api/reservations/[id]/convert, sans duplication ; (Sprint 14B) le total d'un paiement mixte est validé contre le solde restant avant toute écriture (plus jamais de Payment partiel en cas de dépassement), message toujours formaté en devise
│   │   └── utils.ts         # cn() — généré par shadcn init
│   └── __tests__/
│       ├── db.test.ts        # Tests d'isolation multi-tenant (Vitest) sur src/lib/db.ts
│       ├── auth.test.ts      # Tests d'intégration HTTP : register/login/logout/me, résolution du tenant à la connexion (Sprint 9)
│       ├── tenants.test.ts   # Tests GET/PATCH/DELETE tenants + isolation multi-tenant ; (Sprint 11) garde 405 sur POST /api/tenants (retiré)
│       ├── agencies.test.ts  # Tests CRUD agencies + isolation multi-tenant/multi-agence
│       ├── ui.test.tsx       # Tests d'intégration HTTP sur le rendu des pages (login/register/dashboard/users)
│       ├── vehicles.test.ts   # (Sprint 5) CRUD, disponibilité/conflits, isolation multi-tenant/multi-agence
│       ├── locations.test.ts  # (Sprint 5) CRUD, pricing, conflits, machine à états, isolation multi-tenant/multi-agence
│       ├── invoices.test.ts   # (Sprint 6) CRUD, numérotation, calcul TVA/remise, machine à états, isolation multi-tenant/multi-agence
│       ├── payments.test.ts   # (Sprint 6) CRUD, validation solde restant, recalcul automatique du statut de la facture
│       ├── reports.test.ts    # (Sprint 6) getRevenueReport/getVehicleUtilizationReport/getTopVehicles, isolation tenant
│       ├── maintenances.test.ts # (Sprint 7) CRUD, machine à états, historique conservé, génération d'alertes (check-alerts)
│       ├── alerts.test.ts     # (Sprint 7) CRUD (lib direct), acknowledge/resolve, filtrage priorité/status
│       ├── clients.test.ts    # (Sprint 8) CRUD, isolation multi-tenant, recherche, suppression bloquée si location associée
│       ├── password-policy.test.ts # (Sprint 9) Tests unitaires de validatePassword
│       ├── users.test.ts      # (Sprint 9) Changement de rôle, garde "dernier ADMIN", suppression, réinitialisation mot de passe ; (Sprint 10) GET/PATCH /api/users/me ; (Sprint 11) rafraîchissement de session JWT via trigger update (GET/POST /api/auth/session)
│       ├── invitations.test.ts # (Sprint 9) Création, acceptation, déclin, expiration, révocation
│       ├── audit.test.ts      # (Sprint 9) logAction, GET /api/audit ADMIN-only et tenant-scopé ; (Sprint 10) traçabilité de chaque ressource métier instrumentée (vehicles/locations/clients/invoices/payments/maintenances/alerts)
│       ├── e2e.test.ts        # (Sprint 9) Scénario complet inscription→facturation→rapport + sécurité ciblée sur les nouvelles surfaces
│       ├── e2e-full.test.ts   # (Sprint 10) Scénario complet inscription→sélection de tenant (Option B)→CRUD complet (dont maintenances/alertes)→facturation→rapports→édition profil→vérification finale du journal d'audit
│       ├── reservations.test.ts # (Sprint 12C) CRUD, machine à états, import Excel (fichier généré via exceljs), conversion en contrat + détection de doublon client à la conversion ; (Sprint 13B) lignes de test construites via le mapping en-tête français → champ interne
│       ├── permissions.test.ts  # (Sprint 12C) CRUD groupes de permissions, assignation par user, application réelle sur une route gated (reservations.*)
│       ├── cash-register.test.ts    # (Sprint 13A) CRUD écritures/catégories, recalcul du solde (previousBalance/monthEntries/monthExpenses/finalBalance), isolation multi-tenant
│       ├── location-payment.test.ts # (Sprint 13A) Paiement intégré à POST /api/locations : simple/partiel/mixte/au retour, impact sur le statut de facture et sur le solde de caisse
│       ├── vehicle-transfers.test.ts # (Sprint 14C, nouveau) Lancement, dérivation fromAgencyId, exclusion des sélecteurs AVAILABLE, blocage transfert incohérent/concurrent, validation + mise à jour agence, blocage kilométrage/date incohérents, annulation, isolation multi-tenant
│       ├── vehicle-trips.test.ts     # (Sprint 14C, nouveau) Départ automatique, exclusion des sélecteurs AVAILABLE, blocage déplacement concurrent, retour (blocage kilométrage ≤ départ, retour valide), annulation, isolation multi-tenant
│       ├── vehicle-mobility-alerts.test.ts # (Sprint 14C, nouveau) Génération STOCK_INCONSISTENCY/RETURN_OVERDUE + consultation/traitement ; rendu de la vue "État des véhicules" (/dashboard/maintenances)
│       ├── data-reset.test.ts       # (Sprint 14D, nouveau) Autorisation ADMIN-only, aperçu des comptages, confirmation par nom de tenant, reset complet vérifié modèle par modèle + isolation inter-tenant, option includeAuditLog, verrou de double-exécution, garde de production
│       └── helpers/          # testServer.ts (port/URL), http.ts (fetch + cookies), fixtures.ts (register/login de test)
├── vitest.global-setup.ts    # Démarre/arrête un vrai serveur `next dev` de test (requis par NextAuth, voir TESTREPORT.md)
├── AGENTS.md                # Règles agent Next.js, régénéré automatiquement par `next dev`
├── CLAUDE.md                # Règles pour assistants IA / développeurs (importe AGENTS.md)
├── README.md                # Point d'entrée du projet
├── HANDOFF.md                # Transmission d'état du projet
├── PROJECT_MAP.md            # Ce document
├── ARCHITECTURE.md           # Architecture générale
├── DOMAINRULES.md            # Règles métier
├── SECURITY.md                # Règles de sécurité
├── TESTREPORT.md              # Suivi des tests
├── INCIDENTS.md                # Suivi des incidents
├── eslint.config.mjs          # Configuration ESLint (eslint-config-next) ; (Sprint 14D) scripts/** ajouté aux ignores — outil CLI Node autonome, require() intentionnel
├── next.config.ts             # Configuration Next.js (par défaut, non personnalisée)
├── postcss.config.mjs         # Configuration PostCSS pour Tailwind
├── tsconfig.json               # Configuration TypeScript (alias @/* -> ./src/*)
├── vitest.config.mts           # Configuration Vitest (alias @/*, setup dotenv, globalSetup)
├── vitest.setup.ts             # Charge .env avant les tests (dotenv/config)
├── package.json                 # Dépendances et scripts npm
├── package-lock.json
└── scripts/
    └── reset-dev-data.js       # (présent sur la copie de travail, non commis dans Git jusqu'ici) Outil CLI de reset global (tous tenants) d'un environnement xrent_dev/xrent_test local, garde-fouté par nom de base — distinct du reset SaaS tenant-scopé du Sprint 14D (GET/POST /api/data-reset), voir HANDOFF.md section 1 et DOMAINRULES.md section 31
```

`.env` et `.env.test` (non versionnés, exclus par `.gitignore`) contiennent `DATABASE_URL` (`xrent_dev`/`xrent_test`) et `AUTH_SECRET` (secret de signature/chiffrement des sessions JWT NextAuth, généré localement).

`src/components` (Sprint 4) accueille l'UI : `ui/` (shadcn/ui), `layout/` (coquille dashboard) et désormais `invoices/` (Sprint 6, template PDF). Aucun dossier `server/`, `data/`, `tests/`, etc. n'existe à ce jour. `src/lib` accueille la couche d'accès aux données technique, la configuration d'authentification, le wrapper `fetch` pour l'UI (`api.ts`) et désormais la logique **métier** (`vehicles.ts`, `locations.ts`, `clients.ts` depuis le Sprint 5, complété Sprint 8 ; `invoices.ts`, `payments.ts`, `reports.ts` depuis le Sprint 6 ; `users.ts`, `invitations.ts`, `audit.ts`, `password-policy.ts` depuis le Sprint 9) — ce choix (rester dans `src/lib` plutôt que créer un dossier `server/`/`data/` dédié) prolonge le pattern déjà en place pour `db.ts`/`authz.ts`, mais reste révisable si le volume de logique métier croît (voir section 3). Les pages d'interface `/login`, `/register`, `/dashboard/*` (dont `/dashboard/vehicles*` et `/dashboard/locations*` depuis le Sprint 5, `/dashboard/invoices*`/`/dashboard/payments`/`/dashboard/reports` depuis le Sprint 6, `/dashboard/clients*` depuis le Sprint 8, `/dashboard/users/[id]`/`/dashboard/invitations`/`/dashboard/audit` et la page publique `/invitations/[id]` depuis le Sprint 9) existent désormais ; les domaines contrats et cautions restent entièrement à construire, l'audit reste volontairement limité aux actions Sprint 9 (voir section 4).

## 2. Rôle des principaux fichiers existants

| Fichier | Rôle |
|---|---|
| `src/app/layout.tsx` | Layout racine de l'application (métadonnées, polices, structure HTML de base). Actuellement le layout par défaut de `create-next-app`. |
| `src/app/page.tsx` | Page d'accueil actuelle. Actuellement la page de démonstration par défaut de `create-next-app`, sans lien avec le métier XRent. |
| `src/app/globals.css` | Styles globaux et directives Tailwind CSS. |
| `next.config.ts` | Configuration Next.js. Actuellement vide (options par défaut). |
| `tsconfig.json` | Configuration TypeScript, avec alias d'import `@/*` pointant vers `src/*`. |
| `eslint.config.mjs` | Configuration ESLint basée sur `eslint-config-next` (core-web-vitals + typescript). |
| `AGENTS.md` | Fichier régénéré automatiquement par `next dev` ; contient les règles spécifiques à cette version de Next.js pour les agents IA. Ne pas éditer manuellement son contenu généré. |
| `CLAUDE.md` | Règles impératives pour les assistants IA et développeurs sur ce projet ; importe `AGENTS.md`. |
| `prisma/schema.prisma` | Schéma de données : `Tenant`, `Agency`, `User` (`passwordHash`, `role`), `UserAgency`, `Client`, `Vehicle`, `Location` (Sprint 5), `Invoice`, `Payment` (Sprint 6), `Invitation`, `AuditLog` (Sprint 9), isolation par `tenantId`/`agencyId` ; `Account`/`Session`/`VerificationToken` pour l'adaptateur NextAuth (OAuth futur, non utilisés pour les sessions actuelles). |
| `src/lib/prisma.ts` | Singleton `PrismaClient`, réutilisé en développement pour éviter l'épuisement de connexions au hot reload Next.js. |
| `src/lib/db.ts` | Couche d'accès aux données minimale : `getTenantById`, `getAgencyById`, `getUserById`, chacune filtrée par `tenantId` côté serveur. |
| `src/lib/auth.ts` | Configuration NextAuth v5 : `CredentialsProvider` (email/password, `bcryptjs`, `tenantId`/`rememberMe` optionnels — Sprint 9), sessions JWT (`maxAge` 30 jours, ajusté par `rememberMe` dans le callback `jwt`), exporte `handlers`/`auth`/`signIn`/`signOut`/`resolveLoginTenants` (Sprint 9 — résolution du tenant à la connexion, vérifie le mot de passe avant de révéler la liste des tenants). (Sprint 11) Callback `jwt()` gère `trigger === "update"` : relit `name`/`email` en base par `token.id` (jamais depuis le payload client), pour le rafraîchissement de session après édition de profil. |
| `src/lib/authz.ts` | `getSessionUser()` — récupère l'utilisateur de la session courante ; (Sprint 14A) relit désormais `role` frais en base à chaque appel plutôt que de faire confiance au JWT figé au login (un changement de rôle s'applique immédiatement, sans reconnexion). `canAccessAgency()` (Sprint 5) — vérifie qu'une agence appartient au tenant de l'utilisateur *et* (ADMIN, ou MEMBER rattaché via `UserAgency`) ; centralise une vérification auparavant dupliquée dans les routes/pages agencies. `getAccessibleAgencyIds()` (Sprint 5) — liste des agences accessibles (`null` = toutes, pour un ADMIN). |
| `src/lib/users.ts` | (Sprint 9) `updateUserRole`/`resetUserPassword`/`deleteUser`, garde `LastAdminError` (409) empêchant de retirer le dernier `ADMIN` d'un tenant (self ou non-self) ; `deleteUser` nettoie `UserAgency`/`Alert.userId` avant suppression (pas de cascade DB sur ces relations). (Sprint 13C) `getUserAgencyIds`/`setUserAgencies` — première écriture jamais faite sur `UserAgency` en dehors des tests, corrige le bug où un `MEMBER` ne voyait aucun véhicule/location. |
| `src/lib/invitations.ts` | (Sprint 9) `createInvitation`/`acceptInvitation`/`declineInvitation`/`revokeInvitation` ; `id` (cuid) sert d'identifiant non-devinable dans le lien partageable, pas de colonne `token` séparée ; `acceptInvitation` dérive toujours `email`/`role` de l'invitation, jamais du client. |
| `src/lib/audit.ts` | (Sprint 9) `logAction`/`getAuditLogs`, scopés tenant ; `logAction` n'échoue jamais l'action métier appelante (catch + log console). Câblé uniquement sur les actions Sprint 9 (rôle/suppression user, invitations) — voir section 4. |
| `src/lib/data-reset.ts` | (Sprint 14D, nouveau) `getDataResetSummary`/`resetTenantData` — reset des données métier/test d'un tenant (voir DOMAINRULES.md section 31) : garde de production (`NODE_ENV`, SECURITY.md section 17), verrou anti-double-exécution en mémoire de process, confirmation par nom de tenant, journalisation systématique via `logAction` (action `"data.reset"`) même si l'option « réinitialisation complète » vide `AuditLog` lui-même. |
| `src/lib/password-policy.ts` | (Sprint 9) `validatePassword()` — 8 caractères minimum, majuscule, chiffre, caractère spécial ; utilisée par `/api/auth/register`, l'acceptation d'invitation et la réinitialisation de mot de passe par un ADMIN. |
| `src/proxy.ts` | Redirection optimiste vers `/login` pour `/dashboard*`/`/settings*` si non authentifié (lecture du JWT côté cookie uniquement, pas de requête base de données). N'intercepte pas `/invitations/*` (route publique, Sprint 9). |
| `src/app/api/auth/register/route.ts` | Crée un `Tenant` et son premier `User` (`role: "ADMIN"`), mot de passe haché avec `bcryptjs`, validé par `validatePassword` (Sprint 9). |
| `src/app/api/auth/login/route.ts` | Authentifie via `signIn("credentials", …)`, retourne le même message d'erreur pour mot de passe incorrect et compte inexistant. Depuis le Sprint 9 : résout d'abord les tenants candidats (`resolveLoginTenants`) — 0 résultat → 401, >1 → `{ requiresTenantSelection: true, tenants }` sans créer de session, 1 seul → connexion directe. |
| `src/app/api/tenants/route.ts`, `[id]/route.ts` | `GET`/`PATCH`/`DELETE`, réservés `ADMIN`, strictement scopés au tenant de l'utilisateur connecté (jamais de liste globale). **Pas de `POST`** (Sprint 11) : créait des tenants orphelins, jamais rattachés à un `User` — retiré, voir HANDOFF.md point 36 ; création de tenant exclusive à `/api/auth/register`. (Sprint 14B) `PATCH` accepte aussi `contractNumberPrefix`/`lastContractNumber` (paramètres de numérotation des contrats). |
| `src/app/api/documents/batch-pdf/route.tsx` | (Sprint 14B, nouveau) `POST` — PDF de lot (plusieurs contrats ou factures dans un seul document), sélection par identifiants, plage de dates, ou plage de numéros de contrat (exactement un mode à la fois), scopé tenant + agences accessibles, voir DOMAINRULES.md section 29. |
| `src/app/api/agencies/route.ts`, `[id]/route.ts` | CRUD `Agency`, scopé tenant ; lecture ouverte aux `MEMBER` explicitement rattachés via `UserAgency`, écriture réservée aux `ADMIN`. |
| `src/app/api/users/route.ts`, `[id]/route.ts` | `GET` liste (Sprint 4, réservé ADMIN, ne sélectionne jamais `passwordHash`) ; `[id]/route.ts` (Sprint 9) `GET`/`PATCH` (`role`, `password`)/`DELETE`, réservés ADMIN, garde "dernier ADMIN", chaque mutation de rôle/suppression journalisée (`logAction`). |
| `src/app/api/invitations/route.ts`, `[id]/route.ts`, `[id]/accept/route.ts`, `[id]/decline/route.ts` | (Sprint 9) `GET`/`POST /api/invitations` réservés ADMIN ; `GET /[id]` public (champs non sensibles) ; `DELETE /[id]` révocation, ADMIN ; `accept`/`decline` publics (l'invité n'a pas encore de session dans ce tenant), `email`/`role` toujours dérivés de l'invitation. |
| `src/app/api/audit/route.ts` | (Sprint 9) `GET`, réservé ADMIN, tenant-scopé, filtrable par `resource`/`userId`. |
| `src/app/api/vehicles/route.ts`, `[id]/route.ts`, `[id]/availability/route.ts` | (Sprint 5) CRUD `Vehicle` + disponibilité, scopé tenant + agence (`canAccessAgency`), immatriculation unique par tenant, suppression bloquée si des locations existent. (Sprint 14A) `pricePerDay` n'est plus requis à la création, validé uniquement s'il est fourni. |
| `src/app/api/locations/route.ts`, `[id]/route.ts`, `[id]/pdf/route.tsx` | (Sprint 5) CRUD `Location`, `agencyId` toujours dérivé du véhicule côté serveur (jamais du client), vérification de disponibilité et calcul de `totalPrice` à la création, machine à états sur `PATCH`, suppression restreinte aux statuts `PENDING`/`CANCELLED`. (Sprint 12B) `POST` génère automatiquement une `Invoice` `DRAFT` après la location (résilient : un échec de génération n'empêche pas la création de la location) ; `deleteLocation` (`src/lib/locations.ts`) nettoie désormais aussi la facture associée si elle est encore `DRAFT` sans paiement, sinon bloque la suppression (409). (Sprint 13D) La section paiement de `POST` délègue désormais à `processLocationPayment` (`src/lib/location-payment.ts`), extraite pour être partagée avec `POST /api/reservations/[id]/convert` — comportement inchangé. (Sprint 14A) `POST` accepte un `pricePerDay` explicite (centimes) — retombe sur le prix informatif du véhicule s'il existe, sinon 400 (`MissingPriceError`). (Sprint 14B) `POST` génère systématiquement un `contractNumber` séquentiel (`generateContractNumber`) ; `PATCH` refuse désormais de modifier `startDate`/`endDate` dès que le statut quitte `PENDING` (409, `LocationLockedError` — voir DOMAINRULES.md section 29) ; nouvelle route `GET [id]/pdf` (`@react-pdf/renderer`, `src/components/contracts/ContractPdf.tsx`) — PDF du contrat, 404 si la location n'a pas de `contractNumber`. |
| `src/app/api/clients/route.ts`, `[id]/route.ts` | `GET`/`POST` (Sprint 5) + `GET`/`PATCH`/`DELETE /[id]` (Sprint 8) — CRUD `Client`, tenant-scopé sans `agencyId`, suppression bloquée si des locations existent (voir DOMAINRULES.md section 9). |
| `src/app/api/invoices/route.ts`, `[id]/route.ts`, `[id]/pdf/route.tsx` | (Sprint 6) CRUD `Invoice`, `agencyId`/`clientId`/`currency`/`subtotal` toujours dérivés de la `Location` côté serveur, numérotation par tenant, machine à états sur `PATCH` (transitions manuelles uniquement, `PARTIALLY_PAID`/`PAID` réservés à `recomputeInvoiceStatus`), suppression restreinte à `DRAFT` sans paiement, PDF via `@react-pdf/renderer`. |
| `src/app/api/payments/route.ts`, `[id]/route.ts` | (Sprint 6) CRUD `Payment`, `currency` toujours dérivée de l'`Invoice`, montant validé contre le solde restant dû, chaque mutation recalcule `Invoice.amountPaid`/`status` depuis la somme réelle des paiements. |
| `src/app/api/reports/revenue/route.ts`, `vehicles/route.ts` | (Sprint 6) `GET`, réservées `ADMIN` — revenu encaissé par mois (`Payment`), utilisation véhicule et classement par revenu facturé (`Location`). |
| `src/app/api/maintenances/route.ts`, `[id]/route.ts` | (Sprint 7) CRUD `Maintenance`, `agencyId`/`currency` toujours dérivés du `Vehicle` côté serveur, machine à états sur `PATCH`, suppression restreinte à `SCHEDULED`. |
| `src/app/api/alerts/route.ts`, `[id]/acknowledge/route.ts`, `[id]/resolve/route.ts` | (Sprint 7) `GET` (liste filtrable) + `PATCH` acknowledge/resolve — aucune route `POST`/`DELETE` (alertes créées par le système uniquement, jamais supprimables). |
| `src/app/api/tasks/check-alerts/route.ts` | (Sprint 7) `POST`, réservé `ADMIN` — déclenche `checkDueMaintenances`/`checkReturnsToday`/`checkOverdueInvoices` pour le tenant connecté. |
| `src/app/api/data-reset/route.ts` | (Sprint 14D, nouveau) `GET` (aperçu des comptages) / `POST` (exécution), réservés `ADMIN`, toujours scopés au tenant connecté (aucun `tenantId` accepté en entrée) — voir `src/lib/data-reset.ts`. |
| `src/app/dashboard/layout.tsx` | (Sprint 4) Server Component : résout la session et le tenant courant, redirige vers `/login` si non authentifié, fournit `DashboardLayout`. (Sprint 11) Enveloppe la sortie dans `<SessionProvider>` (`next-auth/react`), nécessaire pour `useSession().update()` (voir `EditProfileForm.tsx`) — première introduction de ce provider, scopée à `/dashboard`. |
| `src/components/layout/DataTable.tsx` | (Sprint 4) Table générique (TanStack Table **v9** — API `useTable`/`tableFeatures`, pas `useReactTable` — voir `node_modules/@tanstack/react-table/skills/migrate-v8-to-v9/`), tri par colonne et pagination, réutilisée par les pages tenants/agencies/users. (Sprint 14A) En-têtes en retour à la ligne automatique ; largeur de colonne optionnelle lue depuis `columnDef.size` (jamais imposée par défaut) — n'affecte que les tables qui déclarent explicitement `size` sur leurs colonnes. (Sprint 14D) Nouveau champ `meta.align` (`"left"`/`"center"`/`"right"`, typé via `metaHelper`) appliqué à l'en-tête et à la cellule d'une colonne — la colonne `id: "actions"` est alignée à droite automatiquement partout ; voir DOMAINRULES.md section 27 (addendum). (Sprint 14E) Correctif d'un bug racine : `columnSizingFeature` fusionnait `size: 150` par défaut dans **toute** colonne y compris sans `size` déclaré (`header.column.columnDef.size` n'était jamais réellement `undefined`) — `defaultColumn: { size: undefined }` ajouté à `useTable()` pour restaurer le comportement voulu depuis le Sprint 14A ; en-tête `whitespace-nowrap` par défaut, `whitespace-normal` (jamais `break-words`) seulement si `size` explicite, `align-bottom` → `align-middle` pour une barre d'en-têtes visuellement alignée ; voir DOMAINRULES.md section 32 (nouvelle). |
| `src/app/dashboard/audit/page.tsx` | (Sprint 9) Journal d'audit — voir description complète plus haut dans ce document. (Sprint 14E) En-tête du tableau (`<thead>` natif, hors `DataTable.tsx`) harmonisé sur la même convention de hauteur/padding/`whitespace-nowrap` que `DataTable.tsx` — libellés déjà courts (un mot), risque de wrap faible mais barre non alignée sur la même convention avant ce sprint. |
| `src/app/dashboard/maintenances/VehicleStatusOverviewTable.tsx` | (Sprint 14C) Vue « État des véhicules » — table HTML native (hors `DataTable.tsx`), en-têtes avec filtres intégrés (recherche/select). (Sprint 14E) Padding/hauteur/`whitespace-nowrap` harmonisés sur la même convention que `DataTable.tsx`. |
| `src/lib/api.ts` | (Sprint 4) Wrapper `fetch` pour les appels `/api/*` côté client ; lève `ApiError` avec le message `{ error }` renvoyé par la route. |
| `src/__tests__/db.test.ts` | Tests Vitest vérifiant qu'`getAgencyById`/`getUserById` ne retournent jamais une ressource d'un autre tenant ; crée puis nettoie ses propres données dans `xrent_test`. |
| `src/__tests__/auth.test.ts`, `tenants.test.ts`, `agencies.test.ts` | Tests d'intégration HTTP contre un vrai serveur `next dev` de test (voir `vitest.global-setup.ts`) : authentification, CRUD, isolation multi-tenant/multi-agence. |
| `src/__tests__/vehicles.test.ts`, `locations.test.ts` | (Sprint 5) Tests d'intégration HTTP : CRUD, disponibilité/conflits de réservation, calcul de `totalPrice`, machine à états des locations, isolation multi-tenant/multi-agence. |
| `src/__tests__/invoices.test.ts`, `payments.test.ts` | (Sprint 6) Tests d'intégration HTTP : CRUD, numérotation, calcul TVA/remise, machine à états, validation solde restant, recalcul automatique du statut de la facture, isolation multi-tenant/multi-agence. |
| `src/__tests__/reports.test.ts` | (Sprint 6) Tests directs de `src/lib/reports.ts` (`getRevenueReport`/`getVehicleUtilizationReport`/`getTopVehicles`), isolation par tenant. |
| `src/__tests__/maintenances.test.ts`, `alerts.test.ts` | (Sprint 7) Tests CRUD/machine à états/historique conservé, génération idempotente d'alertes, acknowledge/resolve. |
| `src/__tests__/clients.test.ts` | (Sprint 8) Tests CRUD `Client`, isolation multi-tenant, recherche, suppression bloquée si location associée. |
| `src/__tests__/ui.test.tsx` | (Sprint 4) Tests d'intégration HTTP sur le rendu des pages `/login`, `/register`, `/dashboard*` ; voir [TESTREPORT.md](./TESTREPORT.md) pour la note sur `redirect()` en contexte de streaming. |
| `src/__tests__/{password-policy,users,invitations,audit,e2e}.test.ts` | (Sprint 9) Politique de mot de passe (unitaire), rôle/suppression/garde "dernier ADMIN", invitations (création/acceptation/déclin/expiration/révocation), journal d'audit, scénario complet + sécurité ciblée sur les nouvelles surfaces. Voir [TESTREPORT.md](./TESTREPORT.md). |

## 3. Structure cible indicative (non existante à ce jour)

Cette section décrit une organisation **envisagée** pour accueillir les futurs domaines métier, à titre indicatif seulement. Rien ci-dessous n'est créé. Le détail exact (noms, découpage) reste **À DÉCIDER** au moment de l'implémentation, en cohérence avec [ARCHITECTURE.md](./ARCHITECTURE.md).

```
src/
├── app/                      # App Router : routes, pages, layouts (interface + orchestration)
│   ├── (dashboard)/          # Groupe de routes pour le dashboard-admin (À DÉCIDER)
│   └── ...
├── components/                # Composants d'interface réutilisables (Client/Server Components)
├── server/                     # Logique serveur : server actions, validation, autorisation
│   └── <domaine>/               # Un sous-dossier par domaine métier (voir section 4)
├── lib/                          # Utilitaires partagés (formatage, dates, montants, etc.)
├── data/ ou db/                    # Future couche d'accès aux données (requêtes, ORM) — À DÉCIDER
└── types/                           # Types partagés
```

Cette arborescence est une hypothèse de travail, pas une décision figée.

**Décision validée (Sprint 1)**, indépendante du nom exact des dossiers ci-dessus : la future couche d'accès aux données (`data/`, `db/`, ou autre nom — À DÉCIDER) devra centraliser tous les accès à la base de données et y appliquer une garde tenant/agence obligatoire, conformément à [ARCHITECTURE.md](./ARCHITECTURE.md) section 7.

## 4. Futurs domaines métier (envisagés, non implémentés)

D'après les principes produit de démarrage :

- Tenants (CRUD + UI implémentés, Sprint 3–4)
- Agences (CRUD + UI implémentés, Sprint 3–4 ; coordonnées professionnelles — ville/adresse/téléphone/email/responsable — ajoutées Sprint 12A)
- Utilisateurs et rôles (inscription + rôles `ADMIN`/`MEMBER` implémentés Sprint 3 ; liste en lecture seule Sprint 4 ; modification de rôle, suppression, invitation implémentées Sprint 9, avec garde "dernier ADMIN" ; édition du profil par l'user lui-même implémentée Sprint 10 (`/api/users/me`) ; granularité fine des permissions au-delà de `ADMIN`/`MEMBER` reste À DÉCIDER ; **Sprint 14A** : un changement de rôle s'applique désormais immédiatement à toute session déjà émise, sans reconnexion, voir DOMAINRULES.md section 3)
- Véhicules (CRUD + UI + disponibilité implémentés, Sprint 5 ; catégorie = champ texte libre sur `Vehicle`, pas de modèle `Category` dédié — voir DOMAINRULES.md section 6 ; fiche technique professionnelle — châssis/couleur/portes/places/boîte/carburant/puissance/cylindrée/climatisation/GPS/photo — ajoutée Sprint 12A ; **Sprint 14A** : `pricePerDay` devient optionnel/informatif, le prix réel se saisit désormais à la location/au contrat, voir DOMAINRULES.md section 5)
- Réservations et contrats (`Location` fusionne toujours réservation confirmée et contrat, Sprint 5, inchangé ; kilométrage départ/retour et caution ajoutés Sprint 12A ; **Sprint 12C** ajoute un modèle `Reservation` distinct et amont — réservation brute reçue par broker/direct, avant attribution d'un véhicule réel — avec import Excel et conversion explicite vers `Location`, voir DOMAINRULES.md section 21 ; **Sprint 13B** passe l'import Excel en en-têtes français, complète `ReservationsTable` (16 colonnes, filtres date) et introduit `StatusBadge` (badge de statut coloré partagé avec `Location`), voir DOMAINRULES.md section 24 ; **Sprint 14A** : import Excel robuste (dates/heures Excel mixtes, villes validées contre les agences réelles), sélection multiple + suppression en masse, filtres villes/catégorie, colonnes redimensionnées, voir DOMAINRULES.md sections 21/24 ; **Sprint 14B** : `Location.contractNumber` séquentiel généré à la création (compteur `Tenant.lastContractNumber`, configurable dans les paramètres), dates verrouillées dès que le statut quitte `PENDING`, PDF contrat, lots PDF (contrats et factures), voir DOMAINRULES.md section 29)
- Permissions granulaires (modèle `PermissionGroup`/`GroupPermission`/`UserPermission` implémenté Sprint 12C, catalogue de clés en code — voir DOMAINRULES.md section 22 ; appliqué au module Réservations et à la sidebar uniquement, modules existants toujours sur rôle `ADMIN`/`MEMBER` + `canAccessAgency()`)
- Clients (modèle `Client` minimal implémenté Sprint 5 — nom/email/téléphone ; module dédié complet implémenté Sprint 8 — CRUD, page `/dashboard/clients*`, en plus de la sélection/création inline déjà disponible depuis le formulaire de location ; prénom/nom séparés, téléphone secondaire, adresse, pièce d'identité et permis de conduire ajoutés Sprint 12A)
- Facturation (modèle `Invoice` implémenté Sprint 6 — liée à une `Location`, numérotation par tenant, TVA/remise/total, machine à états, export PDF)
- Paiements (modèle `Payment` implémenté Sprint 6 — enregistrement manuel uniquement, pas d'intégration Stripe/PayPal ; voir HANDOFF.md section 8 pour les points encore ouverts ; **Sprint 13A** intègre l'enregistrement du paiement directement dans le formulaire de création de location — simple/partiel/mixte/au retour)
- Caisse (modèles `CashRegister`/`CashEntry`/`ExpenseCategory` implémentés Sprint 13A — solde toujours recalculé depuis les écritures réelles, jamais un compteur incrémenté ; `/dashboard/cash-register*` ; chaque paiement encaissé à la création d'une location alimente automatiquement une entrée de caisse)
- Rapports (implémentés Sprint 6 — revenu par mois, utilisation véhicule, classement véhicules, export CSV ; réservés ADMIN)
- Maintenance véhicules (modèle `Maintenance` implémenté Sprint 7 — CRUD, machine à états, historique conservé, `/dashboard/maintenances` ; **Sprint 14C** : la page gagne une vue "État des véhicules" — immatriculation/état réel/date de retour/disponibilité, filtres en en-têtes, voir DOMAINRULES.md section 30)
- Alertes / notifications (modèle `Alert` implémenté Sprint 7 — in-app uniquement, pas d'email ; badge header, `/dashboard/alerts`, génération automatique via `src/lib/scheduled-tasks.ts`/`POST /api/tasks/check-alerts` ; **Sprint 14C** : 6 nouveaux types — contrat à risque, paiement restant dû, véhicule indisponible, retour en retard, document expiré, incohérence de stock, voir DOMAINRULES.md section 30)
- Transferts entre agences et bons de déplacement interne (modèles `VehicleTransfer`/`VehicleTrip` implémentés Sprint 14C — flux distincts de `Location`/`Reservation`, sans client ni facturation ; `/dashboard/vehicle-transfers`, `/dashboard/vehicle-trips`, voir DOMAINRULES.md section 30)
- Cautions
- Incidents (véhicule/location)
- Audit (modèle `AuditLog` implémenté Sprint 9 — `/dashboard/audit`, réservé ADMIN ; étendu Sprint 10 à tout le CRUD métier — véhicules, locations, clients, factures, paiements, maintenances, alertes — en plus des actions Sprint 9, avec filtres ressource/action/utilisateur)
- Export / Import (CSV disponible pour les rapports depuis le Sprint 6 ; pas d'import, pas d'export pour les autres modules)
- Dashboard-admin (coquille + pages de base implémentées, Sprint 4 ; module métier véhicules/locations depuis Sprint 5 ; facturation/paiements/rapports depuis Sprint 6 ; maintenance/alertes depuis Sprint 7 ; gestion utilisateurs/invitations/audit depuis Sprint 9)

Le détail des règles associées à chaque domaine est en cours de définition dans [DOMAINRULES.md](./DOMAINRULES.md) ; beaucoup de points y sont marqués **À DÉCIDER**.

## 5. Séparation entre interface, logique serveur, accès aux données et sécurité

Principe cible (non encore implémenté, détaillé dans [ARCHITECTURE.md](./ARCHITECTURE.md)) :

- **Interface** (`src/app`, `src/components`) : présentation, ne doit contenir aucune logique d'autorisation ni aucun secret.
- **Logique serveur** (server actions / routes serveur) : validation des entrées, application des règles métier, vérification systématique de l'identité, du rôle, du tenant, de l'agence et de l'appartenance de la ressource.
- **Accès aux données** (`src/lib`, nom définitif toujours **À DÉCIDER**) : `src/lib/db.ts` centralise les lectures scopées `tenantId` réutilisées par `/api/agencies*` ; les routes `/api/tenants*` interrogent Prisma directement avec filtrage explicite (pas encore consolidé dans `db.ts`).
- **Sécurité** (transverse) : authentification, autorisation, audit — ne doit jamais être contournable depuis la couche interface. **Authentification et autorisation implémentées (Sprint 3)** : `src/lib/auth.ts`, `src/lib/authz.ts`, vérifications explicites dans chaque route API. Les pages `/dashboard/*` (Sprint 4) revérifient elles-mêmes la session/le rôle côté serveur (`getSessionUser()`) plutôt que de faire confiance à `src/proxy.ts` seul. **Audit implémenté depuis le Sprint 9** (`src/lib/audit.ts`, `/dashboard/audit`), mais volontairement limité aux actions sensibles introduites ce sprint — voir [HANDOFF.md](./HANDOFF.md) section 3.

Cette séparation existe désormais en grande partie en code (accès aux données, authentification, autorisation serveur, UI dashboard de base) ; la logique **métier** (véhicules, réservations…) reste entièrement à construire.

## 6. Fichiers qui ne doivent jamais contenir de secrets

- Tout fichier suivi par git en clair : `next.config.ts`, `package.json`, tout fichier sous `src/`, tout fichier de documentation (`*.md`).
- `.env*` est déjà exclu du suivi git via `.gitignore` — les secrets doivent exclusivement y résider (ou dans un gestionnaire de secrets externe), jamais dans le code source ni dans la documentation.
- Aucun exemple de clé, token ou identifiant réel ne doit être inséré, même à titre d'illustration, dans un document de ce dépôt.
