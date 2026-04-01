import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:process";

/**
 * Ordered list of well-known system CA bundle paths.
 * Checked in order; first path that exists and is readable wins.
 */
const CA_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",  // Debian/Ubuntu/WSL2
  "/etc/pki/tls/certs/ca-bundle.crt",    // RHEL/CentOS/Fedora
  "/etc/ssl/ca-bundle.pem",               // OpenSUSE
  "/etc/ssl/cert.pem",                    // Alpine, macOS
];

/**
 * Reads system CA certificates from well-known bundle paths.
 * Returns null on Windows (no universal file path) or if no bundle is found.
 *
 * On Windows, users should set NODE_EXTRA_CA_CERTS pointing to a PEM file.
 */
export function getSystemCACerts(): string | null {
  // Windows has no universal CA bundle path; skip auto-detection
  if (platform === "win32") {
    return null;
  }

  for (const caPath of CA_BUNDLE_PATHS) {
    if (existsSync(caPath)) {
      try {
        return readFileSync(caPath, "utf8");
      } catch {
        // File exists but is unreadable (permissions); try next
        continue;
      }
    }
  }

  return null;
}

/**
 * Returns undici `connect` options with system CA certs, or an empty object
 * if no system CA bundle is found (undici uses Node's compiled-in Mozilla
 * bundle in that case).
 *
 * Usage:
 *   new Agent({ connect: getConnectOptions() })
 *   new ProxyAgent({ uri: proxyUrl, connect: getConnectOptions() })
 */
export function getConnectOptions(): { ca: string } | Record<string, never> {
  const ca = getSystemCACerts();
  return ca !== null ? { ca } : {};
}
