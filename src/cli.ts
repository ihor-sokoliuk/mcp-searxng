#!/usr/bin/env node

import { handleUncaughtException, handleUnhandledRejection } from "./error-handler.js";
import {
  initializeDiagnosticSanitizer,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";
import { packageVersion } from "./version.js";
import { createCliHelpText } from "./resources.js";

initializeDiagnosticSanitizer();
process.on('uncaughtException', handleUncaughtException);
process.on('unhandledRejection', handleUnhandledRejection);

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  writeDiagnostic("log", packageVersion);
} else if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  writeDiagnostic("log", createCliHelpText());
} else {
  void import("./index.js")
    .then(({ main }) => main())
    .catch((error) => {
      writeDiagnostic("error", "Failed to start server:", sanitizeErrorForTransport(error));
      process.exit(1);
    });
}
