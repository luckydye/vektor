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
      "0.0.0.0/8",
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

    const blockedCidrs = [
      "::/128", // unspecified, connects to the local host
      "::1/128",
      "fc00::/7",
      "fe80::/10",
      "ff00::/8",
      "2002::/16", // 6to4, tunnels to whatever relay answers
      "64:ff9b:1::/48", // local-use NAT64, reaches whatever the translator maps
    ];
    if (blockedCidrs.some((cidr) => isIPv6InCidr(normalized, cidr))) return true;

    // These carry an IPv4 address in their low 32 bits, so the v4 rules judge them.
    const ipv4EmbeddingPrefixes = [
      "::/96", // IPv4-compatible, `::127.0.0.1`
      "::ffff:0:0/96", // IPv4-mapped, `::ffff:127.0.0.1`
      "::ffff:0:0:0/96", // IPv4-translated, `::ffff:0:127.0.0.1`
      "64:ff9b::/96", // NAT64, `64:ff9b::127.0.0.1`
    ];
    if (ipv4EmbeddingPrefixes.some((cidr) => isIPv6InCidr(normalized, cidr))) {
      const parts = expandIPv6(normalized);
      const high = Number.parseInt(parts[6], 16);
      const low = Number.parseInt(parts[7], 16);
      return isPrivateOrBlockedIp(
        [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
      );
    }

    return false;
  }

  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(host) || host.endsWith(".internal");
}

/**
 * A URL that passed validation, with the addresses it resolved to during it.
 * `addresses` is empty when there is nothing to pin — a literal-IP host, or a
 * validator that skipped resolution.
 */
export interface ValidatedUrl {
  url: URL;
  addresses: string[];
}

/** Validates a candidate URL for {@link safeFetch}, throwing if it is refused. */
export type UrlValidator = (url: string) => Promise<ValidatedUrl>;

/**
 * Validate that `url` is a public HTTP(S) endpoint safe to fetch server-side and
 * report the addresses it resolved to, so the caller can pin to them.
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

const MAX_RACED_ADDRESSES = 8;
const CONNECT_STAGGER_MS = 250;
const CONNECT_RACE_TIMEOUT_MS = 5_000;

/** Unref'd, so a race timer left over cannot hold the process open. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Resolves once `attempt` has failed, and stays pending if it succeeds. */
function whenFailed(attempt: Promise<unknown>): Promise<null> {
  return attempt.then(
    () => new Promise<null>(() => {}),
    () => null,
  );
}

/**
 * Pick which validated address to connect to, racing them as `fetch` does
 * natively. Pinning gives that race up, and a record that black-holes packets
 * rather than refusing them costs a full OS connect timeout, so trying them in
 * series would turn a working name into a failing one.
 */
async function pickAddress(addresses: string[], url: URL): Promise<string> {
  const candidates = addresses.slice(0, MAX_RACED_ADDRESSES);
  if (candidates.length === 1) return candidates[0];

  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const attempts: Promise<string>[] = [];
  let winner: string | undefined;

  for (const [index, address] of candidates.entries()) {
    attempts.push(
      (async () => {
        if (index > 0) {
          await Promise.race([
            after(index * CONNECT_STAGGER_MS, null),
            whenFailed(attempts[index - 1]),
          ]);
          // Must throw rather than return, or it could be taken for the winner.
          if (winner) throw new SsrfError(`${address} was not needed`);
        }
        const socket = await Bun.connect({
          hostname: address,
          port,
          socket: { data() {}, error() {}, close() {} },
        });
        socket.end();
        winner ??= address;
        return address;
      })(),
    );
  }

  // Falling back to the first address reports its real failure, which beats
  // anything a probe could say.
  const decided = await Promise.race([
    Promise.any(attempts).catch(() => candidates[0]),
    after(CONNECT_RACE_TIMEOUT_MS, candidates[0]),
  ]);
  winner ??= decided;
  return decided;
}

/**
 * Connect to a validated address while still addressing the request to the
 * hostname, which is what closes the DNS-rebinding window. `Host` and the TLS
 * identity checks stay on the original hostname, so pinning breaks neither
 * virtual hosting nor certificate validation.
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

  const address = await pickAddress(target.addresses, target.url);
  const pinned = new URL(target.url.toString());
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return await fetch(pinned, request);
}

/**
 * Restore the logical view of a pinned response, whose `url` would otherwise be
 * the IP literal and `redirected` only the last hop.
 */
function withLogicalUrl(response: Response, url: string, redirected: boolean): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  if (redirected) {
    Object.defineProperty(response, "redirected", { value: true, configurable: true });
  }
  return response;
}

/** Dropped when a redirect leaves the origin. */
const CROSS_ORIGIN_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** Dropped along with the body they describe. */
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
];

/** Per HTTP-redirect-fetch, which 307 and 308 exist to opt out of. */
function redirectBecomesGet(status: number, method: string): boolean {
  const verb = method.toUpperCase();
  if (status === 303) return verb !== "GET" && verb !== "HEAD";
  return (status === 301 || status === 302) && verb === "POST";
}

/**
 * SSRF-safe fetch: validates the target (and every redirect hop) against the
 * private/blocked-IP denylist before connecting, then pins the socket to the
 * address that was validated. User-influenced URLs (link previews, the agent
 * `curl` command, the job runtime's `fetch`, ...) therefore cannot redirect or
 * re-resolve the server into internal services or cloud metadata endpoints.
 *
 * `init.redirect` keeps its `fetch` meaning, and following a hop reproduces by
 * hand what `fetch` would have done: credentials do not cross an origin change,
 * and a POST is not re-POSTed. `validate` swaps in a different policy without
 * forking the hop loop.
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { method: string },
  validate: UrlValidator = resolvePublicUrl,
): Promise<Response> {
  let target = await validate(url);
  let method = init.method;
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const response = await fetchPinned(target, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("location")
        : null;

    if (location) {
      if (init.redirect === "error") throw new SsrfError("Unexpected redirect");
      if (init.redirect !== "manual") {
        if (i === MAX_REDIRECTS) throw new SsrfError("Too many redirects");
        // An unread body holds the socket.
        await response.body?.cancel().catch(() => {});

        const next = await validate(new URL(location, target.url).toString());
        if (next.url.origin !== target.url.origin) {
          for (const header of CROSS_ORIGIN_HEADERS) headers.delete(header);
        }
        if (redirectBecomesGet(response.status, method)) {
          method = "GET";
          body = undefined;
          for (const header of BODY_HEADERS) headers.delete(header);
        }
        target = next;
        continue;
      }
    }

    return withLogicalUrl(response, target.url.toString(), i > 0);
  }
  throw new SsrfError("Too many redirects");
}
