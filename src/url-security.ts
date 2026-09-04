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

const IPV6_HEX_DIGITS = "0123456789abcdef";

export function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) {
    return false;
  }

  const ip = ipv4ToInt(hostname);
  return BLOCKED_V4_CIDRS.some(([net, bits]) => ((ip ^ net) >>> (32 - bits)) === 0);
}

function splitIpv6Parts(address: string): {
  hasCompression: boolean;
  leftParts: string[];
  rightParts: string[];
} {
  const compressionAt = address.indexOf("::");
  const hasCompression = compressionAt !== -1;
  if (hasCompression && address.indexOf("::", compressionAt + 1) !== -1) {
    throw new Error("invalid IPv6 compression");
  }

  return {
    hasCompression,
    leftParts: hasCompression
      ? address.slice(0, compressionAt).split(":").filter(Boolean)
      : address.split(":"),
    rightParts: hasCompression
      ? address.slice(compressionAt + 2).split(":").filter(Boolean)
      : [],
  };
}

function parseIpv6Part(part: string, isLast: boolean): number[] {
  if (part.includes(".")) {
    if (!isLast || isIP(part) !== 4) {
      throw new Error("invalid embedded IPv4");
    }
    return part.split(".").map(Number);
  }

  if (
    part.length < 1
    || part.length > 4
    || ![...part.toLowerCase()].every((character) => IPV6_HEX_DIGITS.includes(character))
  ) {
    throw new Error("invalid IPv6 hextet");
  }
  const value = Number.parseInt(part, 16);
  return [value >> 8, value & 0xff];
}

function parseIpv6Parts(parts: string[]): number[] {
  return parts.flatMap((part, index) => parseIpv6Part(part, index === parts.length - 1));
}

function expandIpv6Bytes(octets: number[], hasCompression: boolean, leftOctetLength: number): Uint8Array {
  if (!hasCompression) {
    if (octets.length !== 16) throw new Error("invalid IPv6 length");
    return Uint8Array.from(octets);
  }
  if (octets.length >= 16) throw new Error("invalid IPv6 compression length");

  const bytes = new Uint8Array(16);
  bytes.set(octets.slice(0, leftOctetLength));
  bytes.set(octets.slice(leftOctetLength), 16 - (octets.length - leftOctetLength));
  return bytes;
}

function parseIpv6Bytes(address: string): Uint8Array {
  const { hasCompression, leftParts, rightParts } = splitIpv6Parts(address);
  const parts = [...leftParts, ...rightParts];
  const octets = parseIpv6Parts(parts);
  const leftOctetLength = parseIpv6Parts(leftParts).length;
  return expandIpv6Bytes(octets, hasCompression, leftOctetLength);
}

function ipv4FromBytes(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

export function isPrivateIPv6(hostname: string): boolean {
  // url.hostname wraps IPv6 in brackets (e.g. "[::1]") - strip them first
  const addr = (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  ).toLowerCase();

  if (isIP(addr) !== 6) return false;

  let bytes: Uint8Array;
  try {
    bytes = parseIpv6Bytes(addr);
  } catch {
    return true;
  }
  if (bytes.length !== 16) return true;

  // Native singleton and CIDR denials.
  if (bytes.every((value) => value === 0)) return true; // unspecified ::
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) return true; // loopback ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link-local fe80::/10

  // RFC 8215 local-use prefix is entirely non-public, regardless of payload.
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return true;

  // Mutually exclusive IPv4 embedding forms, in their RFC prefix order.
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) { // IPv4-compatible ::/96
    return isPrivateIpv4(ipv4FromBytes(bytes, 12));
  } else if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) { // IPv4-mapped ::ffff:0:0/96
    return isPrivateIpv4(ipv4FromBytes(bytes, 12));
  } else if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0])) { // IPv4-translated ::ffff:0:0:0/96
    return isPrivateIpv4(ipv4FromBytes(bytes, 12));
  } else if (hasPrefix(bytes, [0x20, 0x02])) { // 6to4 2002::/16, bits 16-47 carry IPv4
    return isPrivateIpv4(ipv4FromBytes(bytes, 2));
  } else if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) { // RFC 6052 64:ff9b::/96
    return isPrivateIpv4(ipv4FromBytes(bytes, 12));
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
