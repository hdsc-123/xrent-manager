import { describe, expect, it } from "vitest";
import { validatePassword } from "@/lib/password-policy";

describe("validatePassword", () => {
  it("accepte un mot de passe conforme", () => {
    expect(validatePassword("Correct-Horse-Battery-Staple9!")).toEqual([]);
  });

  it("rejette un mot de passe trop court", () => {
    expect(validatePassword("Ab1!")).toContain(
      "Le mot de passe doit contenir au moins 8 caractères."
    );
  });

  it("rejette un mot de passe sans majuscule", () => {
    expect(validatePassword("lowercase1!")).toContain(
      "Le mot de passe doit contenir au moins une majuscule."
    );
  });

  it("rejette un mot de passe sans chiffre", () => {
    expect(validatePassword("NoDigitsHere!")).toContain(
      "Le mot de passe doit contenir au moins un chiffre."
    );
  });

  it("rejette un mot de passe sans caractère spécial", () => {
    expect(validatePassword("NoSpecialChar1")).toContain(
      "Le mot de passe doit contenir au moins un caractère spécial."
    );
  });

  it("cumule toutes les erreurs applicables", () => {
    expect(validatePassword("short")).toHaveLength(4);
  });
});
