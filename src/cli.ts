#!/usr/bin/env node

import { main } from "./index.js";
import { handleUncaughtException, handleUnhandledRejection } from "./error-handler.js";

process.on('uncaughtException', handleUncaughtException);
process.on('unhandledRejection', handleUnhandledRejection);

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
