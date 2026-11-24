import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { configs as secureCoding } from "eslint-plugin-secure-coding";
import { configs as nodeSecurity } from "eslint-plugin-node-security";

export default [
  // Type-aware rules for src (tsconfig covers these files)
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/no-deprecated": "warn",
    },
  },
  // Test files: parse without project (no type-aware rules)
  {
    files: ["__tests__/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
  },
  // Security rules for src, tests and the release scripts. Release scripts handle
  // registry output and temporary paths, so suppressions there need a narrow reason.
  secureCoding.recommended,
  nodeSecurity.recommended,
  // Parity with eslint-plugin-security's recommended set, which also covered Trojan Source
  // (bidi and invisible characters) and non-literal RegExp.
  {
    rules: {
      "secure-coding/no-bidi-characters": "error",
      "secure-coding/no-invisible-characters": "error",
      "secure-coding/detect-non-literal-regexp": "error",
    },
  },
];
