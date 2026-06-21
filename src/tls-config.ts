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
 * Injectable dependencies for {@link getSystemCACerts}.
 *
 * These exist purely as a test seam: production callers pass nothing and the
 * real platform / filesystem are used. Tests override them to exercise branches
 * (e.g. Windows, unreadable bundles) deterministically on any host.
 */
export interface CACertDeps {
  platformName?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  caPaths?: readonly string[];
}

/**
 * Reads system CA certificates from well-known bundle paths.
 * Returns null on Windows (no universal file path) or if no bundle is found.
 *
 * On Windows, users should set NODE_EXTRA_CA_CERTS pointing to a PEM file.
 */
export function getSystemCACerts(deps: CACertDeps = {}): string | null {
  const {
    platformName = platform,
    fileExists = existsSync,
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile = (path: string) => readFileSync(path, "utf8"),
    caPaths = CA_BUNDLE_PATHS,
  } = deps;

  // Windows has no universal CA bundle path; skip auto-detection
  if (platformName === "win32") {
    return null;
  }

  for (const caPath of caPaths) {
    if (fileExists(caPath)) {
      try {
        return readFile(caPath);
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
export function getConnectOptions(deps: CACertDeps = {}): { ca: string } | Record<string, never> {
  const ca = getSystemCACerts(deps);
  return ca !== null ? { ca } : {};
}
