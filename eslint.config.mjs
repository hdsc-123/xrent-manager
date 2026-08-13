import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Scripts CLI Node autonomes (ex. scripts/reset-dev-data.js), exécutés directement via
    // `node`, hors du bundle Next.js — CommonJS `require()` y est intentionnel, pas une
    // erreur (voir CLAUDE.md section 7).
    "scripts/**",
  ]),
]);

export default eslintConfig;
