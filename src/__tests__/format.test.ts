import { describe, expect, it } from "vitest";
import { calculateDaysCount, combineDateAndTime, isValidTimeString } from "@/lib/format";

/**
 * Revue durée de réservation (2026-09-01) : tests unitaires directs des fonctions canoniques
 * partagées par réservations/locations/contrats/factures/prolongations/import Excel — jamais
 * réimplémentées localement (voir les commentaires "revue durée de réservation" apposés sur
 * chaque site converti dans ce même commit).
 */

describe("calculateDaysCount — règle du jour entamé", () => {
  it("10/08/2026 10:00 → 12/08/2026 10:00 = 2 jours (durée exacte, aucun dépassement)", () => {
    const start = new Date(Date.UTC(2026, 7, 10, 10, 0));
    const end = new Date(Date.UTC(2026, 7, 12, 10, 0));
    expect(calculateDaysCount(start, end)).toBe(2);
  });

  it("10/08/2026 10:00 → 12/08/2026 09:59 = 2 jours (une minute sous la durée exacte, pas de jour supplémentaire)", () => {
    const start = new Date(Date.UTC(2026, 7, 10, 10, 0));
    const end = new Date(Date.UTC(2026, 7, 12, 9, 59));
    expect(calculateDaysCount(start, end)).toBe(2);
  });

  it("10/08/2026 10:00 → 12/08/2026 11:00 = 3 jours (une heure de dépassement compte comme un jour entier)", () => {
    const start = new Date(Date.UTC(2026, 7, 10, 10, 0));
    const end = new Date(Date.UTC(2026, 7, 12, 11, 0));
    expect(calculateDaysCount(start, end)).toBe(3);
  });

  it("un dépassement d'une seule minute compte comme un jour supplémentaire", () => {
    const start = new Date(Date.UTC(2026, 7, 10, 10, 0));
    const end = new Date(Date.UTC(2026, 7, 12, 10, 1));
    expect(calculateDaysCount(start, end)).toBe(3);
  });

  it("minimum 1 jour, même pour un écart de quelques minutes", () => {
    const start = new Date(Date.UTC(2026, 7, 10, 10, 0));
    const end = new Date(Date.UTC(2026, 7, 10, 10, 30));
    expect(calculateDaysCount(start, end)).toBe(1);
  });

  it("insensible aux secondes/millisecondes : un écart de durée exacte + 1ms compte comme un jour de plus", () => {
    const start = new Date(Date.UTC(2026, 7, 10, 10, 0, 0, 0));
    const end = new Date(Date.UTC(2026, 7, 12, 10, 0, 0, 1));
    expect(calculateDaysCount(start, end)).toBe(3);
  });
});

describe("combineDateAndTime — combinaison UTC canonique", () => {
  it("combine une date et une heure HH:mm en UTC", () => {
    const combined = combineDateAndTime(new Date(Date.UTC(2026, 7, 10)), "14:30");
    expect(combined.getUTCHours()).toBe(14);
    expect(combined.getUTCMinutes()).toBe(30);
    expect(combined.getUTCFullYear()).toBe(2026);
    expect(combined.getUTCMonth()).toBe(7);
    expect(combined.getUTCDate()).toBe(10);
  });

  it("renvoie la date inchangée si aucune heure n'est fournie (usage affichage historique)", () => {
    const date = new Date(Date.UTC(2026, 7, 10));
    expect(combineDateAndTime(date).getTime()).toBe(date.getTime());
  });

  it("renvoie la date inchangée si l'heure ne correspond pas au format HH:mm (permissif, usage affichage)", () => {
    const date = new Date(Date.UTC(2026, 7, 10));
    expect(combineDateAndTime(date, "not-a-time").getTime()).toBe(date.getTime());
  });
});

describe("isValidTimeString — validation stricte HH:mm (écriture)", () => {
  it.each(["00:00", "09:05", "14:30", "23:59"])("accepte %s", (value) => {
    expect(isValidTimeString(value)).toBe(true);
  });

  it.each([
    "24:00",
    "23:60",
    "9:5",
    "abc",
    "",
    "14:30:00",
    " ",
    "-1:00",
  ])("rejette %s", (value) => {
    expect(isValidTimeString(value)).toBe(false);
  });

  it("rejette toute valeur non-chaîne", () => {
    expect(isValidTimeString(undefined)).toBe(false);
    expect(isValidTimeString(null)).toBe(false);
    expect(isValidTimeString(1430)).toBe(false);
  });
});
