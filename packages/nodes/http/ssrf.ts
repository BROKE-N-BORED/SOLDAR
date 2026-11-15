// SSRF guard for the HTTP node.
//
// A workflow must not be able to call services on the machine's own network
// by accident (or because someone pasted a hostile workflow). Before any
// request — including each redirect hop — the URL's hostname is resolved
// and every address it resolves to is checked against the private,
// loopback, link-local, and other non-public ranges. Literal private IPs
// are refused without a DNS lookup.
//
// The workflow opts out with settings.allowPrivateAddresses: true, for
// workflows that genuinely need local calls.

import { lookup } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// IP parsing
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 address to a 32-bit number, or null. */
export function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // No leading zeros: "010" must not silently mean octal 8.
    if (!/^(0|[1-9][0-9]*)$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    n = n * 256 + value;
  }
  return n >>> 0;
}

/** Parse an IPv6 address to 16 bytes, or null. Handles :: and embedded IPv4. */
export function parseIpv6(ip: string): number[] | null {
  let s = ip;
  const dotIndex = s.lastIndexOf('.');
  if (dotIndex !== -1) {
    // IPv4-embedded form, e.g. ::ffff:192.168.1.1 — rewrite the IPv4 tail
    // as two hex groups.
    const colonBefore = s.lastIndexOf(':', dotIndex);
    if (colonBefore === -1) return null;
    const v4 = parseIpv4(s.slice(colonBefore + 1));
    if (v4 === null) return null;
    s =
      s.slice(0, colonBefore + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }

  const parseGroup = (g: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    return parseInt(g, 16);
  };

  const halves = s.split('::');
  if (halves.length > 2) return null;
  let groups: number[];
  if (halves.length === 2) {
    const left = halves[0] === '' ? [] : halves[0].split(':');
    const right = halves[1] === '' ? [] : halves[1].split(':');
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const all = [...left, ...new Array<string>(missing).fill('0'), ...right];
    groups = [];
    for (const g of all) {
      const v = parseGroup(g);
      if (v === null) return null;
      groups.push(v);
    }
  } else {
    const all = s.split(':');
    if (all.length !== 8) return null;
    groups = [];
    for (const g of all) {
      const v = parseGroup(g);
      if (v === null) return null;
      groups.push(v);
    }
  }

  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

// ---------------------------------------------------------------------------
// Private-range checks
// ---------------------------------------------------------------------------

const IPV4_PRIVATE: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8 — "this network"
  [0x0a000000, 8], // 10.0.0.0/8 — private
  [0x64400000, 10], // 100.64.0.0/10 — shared address space (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8 — loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 — link-local
  [0xac100000, 12], // 172.16.0.0/12 — private
  [0xc0000000, 24], // 192.0.0.0/24 — IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 — TEST-NET-1
  [0xc0a80000, 16], // 192.168.0.0/16 — private
  [0xc6336400, 24], // 198.51.100.0/24 — TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 — TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 — multicast
  [0xf0000000, 4], // 240.0.0.0/4 — reserved (includes broadcast)
];

function inCidr(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

export function isPrivateIpv4(address: number): boolean {
  return IPV4_PRIVATE.some(([network, prefix]) => inCidr(address, network, prefix));
}

export function isPrivateIpv6(bytes: number[]): boolean {
  const allZero = bytes.every((b) => b === 0);
  if (allZero) return true; // :: — unspecified
  // ::1 — loopback
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // fe80::/10 — link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // fc00::/7 — unique local
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // 2001:db8::/32 — documentation
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true;
  }
  // 100::/64 — discard-only
  if (
    bytes[0] === 0x01 &&
    bytes.slice(1, 8).every((b) => b === 0)
  ) {
    return true;
  }
  // ::ffff:0:0/96 — IPv4-mapped: judge the embedded IPv4 address.
  if (
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    const v4 = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    return isPrivateIpv4(v4);
  }
  return false;
}

/** True when the string is an IP literal in a private/non-public range. */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return isPrivateIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6 !== null) return isPrivateIpv6(v6);
  return false;
}

// ---------------------------------------------------------------------------
// URL check
// ---------------------------------------------------------------------------

export interface SsrfOptions {
  /** Skip the guard entirely (workflow opted out). */
  allowPrivate?: boolean;
  /** Hostname resolver, injectable for tests. Defaults to DNS lookup. */
  resolveHost?: (host: string) => Promise<string[]>;
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function refused(host: string, address: string): Error {
  return new Error(
    `Refused to call ${host} — it resolves to private address ${address}, and the ` +
      `SSRF guard blocks local network addresses. Set settings.allowPrivateAddresses ` +
      `to true on the workflow to allow it.`,
  );
}

/**
 * Throw unless the URL is safe to call: http(s) only, and — unless the
 * workflow opted out — every address the hostname resolves to is public.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  options: SsrfOptions = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed, not "${url.protocol}".`);
  }
  if (options.allowPrivate) return;

  // WHATWG URL normalizes IPv4 forms (127.1, 0x7f000001, 2130706433) to
  // dotted quads, so a literal check here catches the obfuscated forms too.
  // IPv6 hostnames keep their brackets; strip them before parsing.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  const v4 = parseIpv4(host);
  if (v4 !== null) {
    if (isPrivateIpv4(v4)) throw refused(host, host);
    return;
  }
  if (host.includes(':')) {
    const v6 = parseIpv6(host);
    if (v6 !== null && isPrivateIpv6(v6)) throw refused(host, host);
    return;
  }

  const resolve = options.resolveHost ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(`Could not resolve host "${host}".`);
  }
  for (const address of addresses) {
    if (isPrivateIp(address)) throw refused(host, address);
  }
}
