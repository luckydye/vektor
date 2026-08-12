import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

/**
 * Server-Side Request Forgery (SSRF) guard.
 *
 * Any code path that fetches a URL whose value is influenced by user input
 * (link previews, the agent `curl` command, ...) must validate the
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
    const parts = expandIPv6(normalized);

    // IPv4-mapped (`::ffff:127.0.0.1`, `::ffff:7f00:1`) and IPv4-compatible
    // (`::127.0.0.1`) addresses reach the v4 internet, so they have to be judged
    // by the v4 rules — the v6 CIDRs below would let every one of them through.
    const embedsIPv4 =
      parts.slice(0, 5).every((part) => part === "0000") &&
      (parts[5] === "ffff" || (parts[5] === "0000" && parts[6] !== "0000"));
    if (embedsIPv4) {
      const high = Number.parseInt(parts[6], 16);
      const low = Number.parseInt(parts[7], 16);
      return isPrivateOrBlockedIp(
        [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
      );
    }

    // `::/128` is the unspecified address, which connects to the local host.
    const blockedCidrs = ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];
    return blockedCidrs.some((cidr) => isIPv6InCidr(normalized, cidr));
  }

  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(host) || host.endsWith(".internal");
}

/**
 * A URL that passed validation, together with the addresses its hostname
 * resolved to *during* that validation.
 *
 * `addresses` is empty when there is nothing to pin: either the host was already
 * a literal IP (nothing to re-resolve, so no rebinding window) or the validator
 * deliberately skipped resolution.
 */
export interface ValidatedUrl {
  url: URL;
  addresses: string[];
}

/** Validates a candidate URL for {@link safeFetch}, throwing if it is refused. */
export type UrlValidator = (url: string) => Promise<ValidatedUrl>;

/**
 * Validate that `url` is a public HTTP(S) endpoint safe to fetch server-side and
 * report the addresses it resolved to, so the caller can pin the connection to
 * them. Throws {@link SsrfError} on any violation.
 */
export async function resolvePublicUrl(url: string): Promise<ValidatedUrl> {
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
    return { url: parsed, addresses: [] };
  }

  let records: LookupAddress[];
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

  return { url: parsed, addresses: records.map((record) => record.address) };
}

/**
 * Validate that `url` is a public HTTP(S) endpoint safe to fetch server-side.
 * Resolves the hostname and rejects if any resolved address is private/blocked.
 * Throws {@link SsrfError} on any violation. Returns the parsed URL on success.
 */
export async function assertPublicUrl(url: string): Promise<URL> {
  return (await resolvePublicUrl(url)).url;
}

const MAX_REDIRECTS = 5;

/** Addresses to try before giving up on a name that resolved to several. */
const MAX_PINNED_ATTEMPTS = 4;

/**
 * Connect to one of `target`'s validated addresses while still addressing the
 * request to its hostname.
 *
 * This is what closes the DNS-rebinding window: the validator resolved the name
 * once, and the socket goes to exactly what it checked instead of whatever a
 * second lookup would return. The request line and `Host` header keep the
 * original hostname, and TLS is still verified against it (SNI plus an explicit
 * `checkServerIdentity`), so pinning weakens neither virtual hosting nor
 * certificate validation.
 *
 * The addresses are tried in resolution order, because a dual-stack name on a
 * single-stack host resolves to records that cannot be reached and pinning to
 * only the first would turn a working fetch into a hard failure. Only transport
 * errors move on to the next record — an abort stops immediately, and any HTTP
 * response, including an error status, is final.
 */
async function fetchPinned(
  target: ValidatedUrl,
  init: RequestInit & { redirect: "manual" },
): Promise<Response> {
  if (target.addresses.length === 0) return await fetch(target.url, init);

  const hostname = target.url.hostname;
  const headers = new Headers(init.headers);
  headers.set("Host", target.url.host);

  const request: BunFetchRequestInit = { ...init, headers };
  if (target.url.protocol === "https:") {
    request.tls = {
      serverName: hostname,
      checkServerIdentity: (_peerName, cert) => checkServerIdentity(hostname, cert),
    };
  }

  let lastError: unknown;
  for (const address of target.addresses.slice(0, MAX_PINNED_ATTEMPTS)) {
    const pinned = new URL(target.url.toString());
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    try {
      return await fetch(pinned, request);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Restore the logical view of a pinned response: `url` would otherwise report
 * the IP literal we connected to, and `redirected` the single hop we made rather
 * than the chain we walked.
 */
function withLogicalUrl(response: Response, url: string, redirected: boolean): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  if (redirected) {
    Object.defineProperty(response, "redirected", { value: true, configurable: true });
  }
  return response;
}

/**
 * SSRF-safe fetch: validates the target (and every redirect hop) against the
 * private/blocked-IP denylist before connecting, then pins the socket to the
 * address that was validated. User-influenced URLs (link previews, the agent
 * `curl` command, the job runtime's `fetch`, ...) therefore cannot redirect or
 * re-resolve the server into internal services or cloud metadata endpoints.
 *
 * `init.redirect` keeps its `fetch` meaning — "manual" hands the 3xx back and
 * "error" refuses it, and either way the hop that produced it was still validated
 * and pinned. `validate` swaps in a different policy (the job runtime has its own
 * error messages and an escape hatch) while keeping the hop loop and the redirect
 * cap in one place.
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { method: string },
  validate: UrlValidator = resolvePublicUrl,
): Promise<Response> {
  let target = await validate(url);
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const response = await fetchPinned(target, { ...init, redirect: "manual" });
    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("location")
        : null;

    if (location) {
      if (init.redirect === "error") throw new SsrfError("Unexpected redirect");
      if (init.redirect !== "manual") {
        if (i === MAX_REDIRECTS) throw new SsrfError("Too many redirects");
        target = await validate(new URL(location, target.url).toString());
        continue;
      }
    }

    return withLogicalUrl(response, target.url.toString(), i > 0);
  }
  throw new SsrfError("Too many redirects");
}
