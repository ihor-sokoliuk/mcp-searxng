import { isIP } from "node:net";
import { createURLSecurityPolicyError } from "./error-handler.js";
import { getHttpSecurityConfig } from "./http-security.js";

export const URL_SECURITY_POLICY_DNS_ERROR = "URLSecurityPolicyDnsError";

export function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

// Blocked IPv4 ranges — RFC1918 private space plus IANA special-purpose ranges
// (RFC 6890). Kept as a single CIDR table so every range is enforced by the same
// integer match and the full blocklist is auditable at a glance. Sorted by network.
const BLOCKED_V4_CIDRS: [number, number][] = [
  [ipv4ToInt("0.0.0.0"), 8],       // "this" network / unspecified
  [ipv4ToInt("10.0.0.0"), 8],      // RFC1918 private
  [ipv4ToInt("100.64.0.0"), 10],   // CGNAT (RFC 6598) - Tailscale default, overlays
  [ipv4ToInt("127.0.0.0"), 8],     // loopback
  [ipv4ToInt("169.254.0.0"), 16],  // link-local
  [ipv4ToInt("172.16.0.0"), 12],   // RFC1918 private
  [ipv4ToInt("192.0.0.0"), 24],    // IETF protocol assignments
  [ipv4ToInt("192.0.2.0"), 24],    // TEST-NET-1
  [ipv4ToInt("192.88.99.0"), 24],  // 6to4 relay anycast (RFC 7526, deprecated)
  [ipv4ToInt("192.168.0.0"), 16],  // RFC1918 private
  [ipv4ToInt("198.18.0.0"), 15],   // benchmarking (RFC 2544)
  [ipv4ToInt("198.51.100.0"), 24], // TEST-NET-2
  [ipv4ToInt("203.0.113.0"), 24],  // TEST-NET-3
  [ipv4ToInt("224.0.0.0"), 4],     // multicast
  [ipv4ToInt("240.0.0.0"), 4],     // reserved / 255.255.255.255 broadcast
];

export function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) {
    return false;
  }

  const ip = ipv4ToInt(hostname);
  return BLOCKED_V4_CIDRS.some(([net, bits]) => ((ip ^ net) >>> (32 - bits)) === 0);
}

export function isPrivateIPv6(hostname: string): boolean {
  // url.hostname wraps IPv6 in brackets (e.g. "[::1]") - strip them first
  const addr = (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  ).toLowerCase();

  if (isIP(addr) !== 6) return false;

  if (addr === "::1") return true;                     // loopback
  if (addr === "::") return true;                      // unspecified
  if (/^f[cd]/i.test(addr)) return true;               // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;  // link-local fe80::/10

  // IPv4-mapped ::ffff:<ipv4> - delegate to the IPv4 check
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  // IPv4-mapped ::ffff:<hhhh>:<hhhh> - convert the hex segments to dotted decimal
  const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16);
    const low = parseInt(hexMapped[2], 16);
    const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return isPrivateIpv4(ipv4);
  }

  return false;
}

export function isPrivateAddress(address: string): boolean {
  return isPrivateIpv4(address) || isPrivateIPv6(address);
}

export function assertUrlAllowed(url: URL): void {
  const security = getHttpSecurityConfig();
  if (security.allowPrivateUrls) {
    return;
  }

  if (isPrivateHostname(url.hostname) || isPrivateIpv4(url.hostname) || isPrivateIPv6(url.hostname)) {
    throw createURLSecurityPolicyError(url.toString());
  }
}

export function createUrlSecurityPolicyDnsError(hostname: string): NodeJS.ErrnoException {
  const error = new Error(`Resolved private address blocked by security policy for ${hostname}`) as NodeJS.ErrnoException;
  error.name = URL_SECURITY_POLICY_DNS_ERROR;
  error.code = URL_SECURITY_POLICY_DNS_ERROR;
  return error;
}

export function isUrlSecurityPolicyDnsError(error: unknown): boolean {
  let current = error as any;
  while (current) {
    if (current.name === URL_SECURITY_POLICY_DNS_ERROR || current.code === URL_SECURITY_POLICY_DNS_ERROR) {
      return true;
    }
    if (Array.isArray(current.errors) && current.errors.some(isUrlSecurityPolicyDnsError)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
