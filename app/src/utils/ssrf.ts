import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Server-Side Request Forgery (SSRF) guard.
 *
 * Any code path that fetches a URL whose value is influenced by user input
 * (link previews, webhooks, the agent `curl` command, ...) must validate the
 * target through {@link assertPublicUrl} first. The check rejects non-HTTP(S)
 * schemes, blocked hostnames, and any URL that resolves to a private,
 * loopback, link-local, or otherwise non-routable address — including the
 * cloud metadata endpoint (169.254.169.254).
 *
 * NOTE: DNS is resolved here and again by `fetch`, leaving a small rebinding
 * window. For the highest-risk callers prefer {@link safeFetch}, which pins the
 * connection to the address that was validated.
 */

export class SsrfError extends Error {
  constructor(message = "URL host is not allowed") {
    super(message);
    this.name = "SsrfError";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

const BLOCKED_IPS = new Set(["0.0.0.0", "127.0.0.1", "169.254.169.254", "::1"]);

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map((part) => Number.parseInt(part, 10));
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function isIPv4InCidr(ip: string, cidr: string): boolean {
  const [range, maskBitsRaw] = cidr.split("/");
  const maskBits = Number.parseInt(maskBitsRaw, 10);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

function expandIPv6(ip: string): string[] {
  if (ip.includes(".")) {
    const lastColon = ip.lastIndexOf(":");
    const prefix = ip.slice(0, lastColon);
    const v4 = ip.slice(lastColon + 1);
    const parts = v4.split(".").map((part) => Number.parseInt(part, 10));
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    ip = `${prefix}:${high}:${low}`;
  }

  const [leftRaw, rightRaw] = ip.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  const middle = Array.from({ length: Math.max(0, missing) }, () => "0");
  const parts = [...left, ...middle, ...right];
  return parts.map((part) => part.padStart(4, "0"));
}

function isIPv6InCidr(ip: string, cidr: string): boolean {
  const [rangeRaw, maskBitsRaw] = cidr.split("/");
  const maskBits = Number.parseInt(maskBitsRaw, 10);
  const ipParts = expandIPv6(ip);
  const rangeParts = expandIPv6(rangeRaw);

  let bitsRemaining = maskBits;
  for (let i = 0; i < 8; i += 1) {
    if (bitsRemaining <= 0) return true;

    const partMaskBits = Math.min(16, bitsRemaining);
    const mask = partMaskBits === 0 ? 0 : (0xffff << (16 - partMaskBits)) & 0xffff;
    const ipPart = Number.parseInt(ipParts[i], 16);
    const rangePart = Number.parseInt(rangeParts[i], 16);

    if ((ipPart & mask) !== (rangePart & mask)) {
      return false;
    }

    bitsRemaining -= 16;
  }

  return true;
}

export function isPrivateOrBlockedIp(ip: string): boolean {
  if (BLOCKED_IPS.has(ip)) return true;

  if (isIP(ip) === 4) {
    const blockedCidrs = [
      "10.0.0.0/8",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "198.18.0.0/15",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ];
    return blockedCidrs.some((cidr) => isIPv4InCidr(ip, cidr));
  }

  if (isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    const blockedCidrs = ["::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];
    return blockedCidrs.some((cidr) => isIPv6InCidr(normalized, cidr));
  }

  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(host) || host.endsWith(".internal");
}

/**
 * Validate that `url` is a public HTTP(S) endpoint safe to fetch server-side.
 * Resolves the hostname and rejects if any resolved address is private/blocked.
 * Throws {@link SsrfError} on any violation. Returns the parsed URL on success.
 */
export async function assertPublicUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError("Invalid URL provided");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError("Only HTTP(S) URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new SsrfError();
  }

  if (isIP(hostname) && isPrivateOrBlockedIp(hostname)) {
    throw new SsrfError();
  }

  // Skip DNS resolution when the host is already a (public) literal IP.
  if (isIP(hostname)) {
    return parsed;
  }

  let records: Awaited<ReturnType<typeof lookup>>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError("Unable to resolve URL host");
  }

  if (records.length === 0) {
    throw new SsrfError("Unable to resolve URL host");
  }

  for (const record of records) {
    if (isPrivateOrBlockedIp(record.address)) {
      throw new SsrfError();
    }
  }

  return parsed;
}

/** Non-throwing variant: returns true when the URL is safe to fetch. */
export async function isPublicUrl(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 5;

/**
 * SSRF-safe fetch: validates the target (and every redirect hop) against the
 * private/blocked-IP denylist before connecting, so user-influenced URLs
 * (webhooks, the agent `curl` command, ...) cannot redirect the server into
 * internal services or cloud metadata endpoints.
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  let target = (await assertPublicUrl(url)).toString();
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const response = await fetch(target, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      if (i === MAX_REDIRECTS) throw new SsrfError("Too many redirects");
      target = (await assertPublicUrl(new URL(location, target).toString())).toString();
      continue;
    }
    return response;
  }
  throw new SsrfError("Too many redirects");
}
