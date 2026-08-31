import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EnvironmentGuardError,
  VALID_ENVS,
  parseEnvFlag,
  envFileNameFor,
  loadEnvFileForEnv,
  assertDatabaseMatchesEnv,
} from "../../scripts/env-guard.js";

/**
 * Mode livraison efficace, phase 4 (2026-08-31) — `scripts/env-guard.js` centralise la
 * sélection d'environnement (dev/test) des 5 scripts opérationnels CommonJS
 * (`backfill-permissions.js`, `bootstrap-superadmin.js`, `reset-dev-data.js`,
 * `resync-vehicle-status.js`, `superadmin-mfa-recovery.js`), qui recopiaient jusqu'ici chacun
 * leur propre version quasi identique de cette logique — même classe de risque que INC-29.
 *
 * Ce fichier prouve chaque garde-fou séparément :
 * - `parseEnvFlag` : aucun défaut implicite, refuse toute valeur absente ou hors `dev`/`test`.
 * - `loadEnvFileForEnv` : refuse un fichier d'environnement manquant/introuvable, jamais un
 *   repli silencieux sur une variable déjà présente dans le shell.
 * - `assertDatabaseMatchesEnv` : exige une correspondance EXACTE entre le suffixe du nom de
 *   base et l'environnement demandé (`--env=test` ⇒ `..._test`, jamais seulement "ressemble à
 *   du dev/test" — c'est précisément le point durci par cette phase, voir INCIDENTS.md).
 *
 * `loadEnvFileForEnv` mute `process.env` via `dotenv.config({ override: true })` — chaque test
 * qui l'appelle restaure `process.env` après coup pour ne jamais polluer le reste de la suite
 * (isolation de fichier déjà garantie par `pool: forks`/`isolate: true`, mais on ne prend pas
 * de risque au sein même de ce fichier).
 */

describe("scripts/env-guard.js — parseEnvFlag", () => {
  it("VALID_ENVS ne contient que dev et test (aucun troisième environnement implicite)", () => {
    expect(VALID_ENVS).toEqual(["dev", "test"]);
  });

  it("refuse l'absence totale de --env (aucun défaut implicite)", () => {
    expect(() => parseEnvFlag([], "usage")).toThrow(EnvironmentGuardError);
  });

  it("refuse une valeur hors dev/test (ex. --env=prod, --env=staging)", () => {
    expect(() => parseEnvFlag(["--env=prod"], "usage")).toThrow(EnvironmentGuardError);
    expect(() => parseEnvFlag(["--env=staging"], "usage")).toThrow(EnvironmentGuardError);
  });

  it("refuse une valeur vide (--env=)", () => {
    expect(() => parseEnvFlag(["--env="], "usage")).toThrow(EnvironmentGuardError);
  });

  it("le message d'erreur reflète exactement le message d'usage fourni par l'appelant", () => {
    expect(() => parseEnvFlag([], "Usage: node scripts/x.js --env=dev|test")).toThrow(
      "Usage: node scripts/x.js --env=dev|test"
    );
  });

  it("accepte --env=dev et --env=test", () => {
    expect(parseEnvFlag(["--env=dev"], "usage")).toBe("dev");
    expect(parseEnvFlag(["--env=test"], "usage")).toBe("test");
  });

  it("ignore les autres flags présents avant/après --env=", () => {
    expect(parseEnvFlag(["--yes", "--env=test", "--full"], "usage")).toBe("test");
  });
});

describe("scripts/env-guard.js — envFileNameFor", () => {
  it("dev → .env, test → .env.test", () => {
    expect(envFileNameFor("dev")).toBe(".env");
    expect(envFileNameFor("test")).toBe(".env.test");
  });
});

describe("scripts/env-guard.js — loadEnvFileForEnv", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("refuse un fichier d'environnement introuvable, jamais un repli silencieux sur le shell appelant", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-guard-test-"));
    try {
      expect(() => loadEnvFileForEnv("test", emptyDir)).toThrow(EnvironmentGuardError);
      expect(() => loadEnvFileForEnv("test", emptyDir)).toThrow(/introuvable/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("charge réellement .env.test du dépôt (fichier existant) sans lever", () => {
    const rootDir = path.resolve(__dirname, "../..");
    expect(() => loadEnvFileForEnv("test", rootDir)).not.toThrow();
    expect(process.env.DATABASE_URL).toContain("xrent_test");
  });

  it("charge un fichier .env.test minimal préparé pour ce test et écrase une valeur déjà présente dans process.env (override: true)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-guard-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, ".env.test"), 'DATABASE_URL="postgresql://user@localhost:5432/fixture_test"\n');
      process.env.DATABASE_URL = "postgresql://user@localhost:5432/should-be-overridden";
      loadEnvFileForEnv("test", tempDir);
      expect(process.env.DATABASE_URL).toBe("postgresql://user@localhost:5432/fixture_test");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scripts/env-guard.js — assertDatabaseMatchesEnv", () => {
  it("refuse une DATABASE_URL absente", () => {
    expect(() => assertDatabaseMatchesEnv(undefined, "test")).toThrow(EnvironmentGuardError);
  });

  it("refuse une DATABASE_URL malformée", () => {
    expect(() => assertDatabaseMatchesEnv("not-a-url", "test")).toThrow(EnvironmentGuardError);
  });

  it("refuse un hôte distant même avec un nom de base correct", () => {
    expect(() => assertDatabaseMatchesEnv("postgresql://user@db.example.com:5432/xrent_test", "test")).toThrow(
      EnvironmentGuardError
    );
  });

  it("accepte localhost et 127.0.0.1", () => {
    expect(assertDatabaseMatchesEnv("postgresql://user@localhost:5432/xrent_test", "test")).toEqual({
      dbName: "xrent_test",
      hostname: "localhost",
    });
    expect(assertDatabaseMatchesEnv("postgresql://user@127.0.0.1:5432/xrent_test", "test")).toEqual({
      dbName: "xrent_test",
      hostname: "127.0.0.1",
    });
  });

  it("CORRECTIF PHASE 4 : refuse --env=test avec une base se terminant par _dev (l'ancien garde-fou, /_dev$|_test$/, laissait passer ce cas exact)", () => {
    expect(() => assertDatabaseMatchesEnv("postgresql://user@localhost:5432/xrent_dev", "test")).toThrow(
      EnvironmentGuardError
    );
  });

  it("CORRECTIF PHASE 4 : refuse --env=dev avec une base se terminant par _test (symétrique du cas ci-dessus)", () => {
    expect(() => assertDatabaseMatchesEnv("postgresql://user@localhost:5432/xrent_test", "dev")).toThrow(
      EnvironmentGuardError
    );
  });

  it("refuse un nom de base ne se terminant ni par _dev ni par _test", () => {
    expect(() => assertDatabaseMatchesEnv("postgresql://user@localhost:5432/some_random_db", "test")).toThrow(
      EnvironmentGuardError
    );
  });

  it("accepte une base dont le nom contient _dev/_test ailleurs qu'en suffixe uniquement si le suffixe réel correspond (ex. xrent_dev_test pour --env=test)", () => {
    // xrent_dev_test se termine bien par "_test" — cas limite documentant le comportement exact
    // du suffixe (pas une recherche de sous-chaîne).
    expect(assertDatabaseMatchesEnv("postgresql://user@localhost:5432/xrent_dev_test", "test")).toEqual({
      dbName: "xrent_dev_test",
      hostname: "localhost",
    });
  });
});
