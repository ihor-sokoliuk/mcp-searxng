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
  /**
   * Path to an extra PEM bundle to merge into the CA list. Defaults to
   * `process.env.NODE_EXTRA_CA_CERTS`. Pass `null` in tests to opt out.
   */
  extraCaPath?: string | null;
}

/**
 * Reads system CA certificates from well-known bundle paths, plus an optional
 * user-provided extra bundle pointed to by `NODE_EXTRA_CA_CERTS`.
 *
 * Returns null on Windows (no universal file path) or if no bundle is found.
 *
 * The extra bundle is folded in here because undici's `connect.ca` option,
 * when set, overrides Node's default CA handling and would otherwise ignore
 * `NODE_EXTRA_CA_CERTS` — which the built-in `https` module does honor.
 */
export function getSystemCACerts(deps: CACertDeps = {}): string | null {
  const {
    platformName = platform,
    fileExists = existsSync,
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile = (path: string) => readFileSync(path, "utf8"),
    caPaths = CA_BUNDLE_PATHS,
    extraCaPath = process.env.NODE_EXTRA_CA_CERTS,
  } = deps;

  // Windows has no universal CA bundle path; skip auto-detection
  if (platformName === "win32") {
    return null;
  }

  const bundles: string[] = [];

  for (const caPath of caPaths) {
    if (fileExists(caPath)) {
      try {
        bundles.push(readFile(caPath));
        break; // first readable bundle wins, matching prior behavior
      } catch {
        // File exists but is unreadable (permissions); try next
        continue;
      }
    }
  }

  if (extraCaPath) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      bundles.push(readFile(extraCaPath));
    } catch {
      // Unreadable extra path is silently ignored — same as Node's behavior.
    }
  }

  return bundles.length > 0 ? bundles.join("\n") : null;
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
