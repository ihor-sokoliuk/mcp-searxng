// Worker entrypoints resolve before inherited tsx loader hooks are active.
// Register tsx inside this JavaScript entrypoint for source tests. Published
// builds run pdf-worker.js directly.
import { register } from "tsx/esm/api";

const unregister = register();
try {
  await import("./pdf-worker.ts");
} finally {
  unregister();
}
