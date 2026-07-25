#!/usr/bin/env node

import { main } from "./index.js";
import { handleUncaughtException, handleUnhandledRejection } from "./error-handler.js";
import {
  initializeDiagnosticSanitizer,
  sanitizeErrorForTransport,
} from "./diagnostic-sanitizer.js";
import { writeDiagnostic } from "./diagnostic-output.js";

initializeDiagnosticSanitizer();
process.on('uncaughtException', handleUncaughtException);
process.on('unhandledRejection', handleUnhandledRejection);

main().catch((error) => {
  writeDiagnostic("error", "Failed to start server:", sanitizeErrorForTransport(error));
  process.exit(1);
});
