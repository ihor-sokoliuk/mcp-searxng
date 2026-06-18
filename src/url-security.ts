import { isIP } from "node:net";
import { createURLSecurityPolicyError } from "./error-handler.js";
import { getHttpSecurityConfig } from "./http-security.js";

export const URL_SECURITY_POLICY_DNS_ERROR = "URLSecurityPolicyDnsError";

export function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

export function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) {
    return false;
  }

  return (
    hostname.startsWith("0.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.")
  );
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
