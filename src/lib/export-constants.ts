/**
 * Sprint 13E tâche 3 — constantes de l'export CSV isolées dans un module sans dépendance vers
 * @/lib/authz (donc @/lib/auth, next-auth) : ce module est importé aussi bien par
 * src/lib/exports.ts (exécuté dans le serveur Next.js) que par les tests (exécutés dans le
 * process Vitest, hors serveur Next.js). Importer next-auth directement dans un test échoue
 * (`Cannot find module 'next/server'`, résolution de sous-chemin Next.js indisponible hors du
 * runtime Next) — convention déjà suivie par le reste de la suite (les tests appellent les
 * routes en HTTP réel plutôt que d'importer @/lib/authz), reproduite ici pour ces constantes
 * pures afin que les tests puissent les vérifier sans dupliquer leur valeur.
 */

export const MAX_EXPORT_ROWS = 20000;

export const VEHICLE_COLUMNS = [
  "agence",
  "nom",
  "immatriculation",
  "marque",
  "modele",
  "annee",
  "categorie",
  "transmission",
  "carburant",
  "statut",
  "etatAdministratif",
  "prixParJour",
  "devise",
  "kilometrageActuel",
  "niveauCarburantActuel",
  "assuranceExpiration",
  "vignetteExpiration",
  "controleTechniqueExpiration",
  "prochaineVidangeDate",
  "prochaineVidangeKm",
  "creeLe",
] as const;

export const CLIENT_COLUMNS = [
  "nom",
  "prenom",
  "nomFamille",
  "email",
  "telephone",
  "telephoneSecondaire",
  "adresse",
  "ville",
  "pays",
  "typePiece",
  "numeroPiece",
  "numeroPermis",
  "permisExpiration",
  "dateNaissance",
  "creeLe",
] as const;

export const LOCATION_COLUMNS = [
  "numeroContrat",
  "agence",
  "agenceRetour",
  "vehicule",
  "immatriculationVehicule",
  "client",
  "dateDebut",
  "dateFin",
  "kilometrageDebut",
  "kilometrageFin",
  "carburantDebut",
  "carburantFin",
  "statut",
  "prixParJour",
  "prixTotal",
  "caution",
  "devise",
  "dateRetourReelle",
  "creeLe",
] as const;

// Sprint 13E tâche 3, sous-phase 2c2-B : type/factureOrigine/motif ajoutés pour rendre un avoir
// (CREDIT_NOTE) identifiable sans ambiguïté dans l'export — jusqu'ici aucune colonne ne
// distinguait le type de document ni ne référençait la facture source d'un avoir.
export const INVOICE_COLUMNS = [
  "numero",
  "type",
  "statut",
  "agence",
  "client",
  "contrat",
  "sousTotal",
  "tauxTVAPourcent",
  "montantTVA",
  "remise",
  "montantTotal",
  "montantPaye",
  "devise",
  "emiseLe",
  "echeance",
  "version",
  "creeLe",
  "factureOrigine",
  "motif",
] as const;
