import { createHash } from "node:crypto";
import { marketplaceOrigin } from "#config";
import { appLogger } from "#observability/logger.ts";
import { parseHttpUrl, SsrfError, safeFetch, type ValidatedUrl } from "#utils/ssrf.ts";

/**
 * Client for an extension store registry.
 *
 * The registry is a read-only HTTP contract — see `docs/extension-registry.md`
 * — so everything here is a GET against the operator-configured base URL, and
 * nothing a caller sends decides which host is contacted.
 */

/** Bumped by the registry when the wire format breaks; also part of the path. */
const REGISTRY_BASE_PATH = "/api/extensions/v1";

/** Same ceiling as a direct upload, so a store install cannot smuggle a bigger one. */
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

/** Metadata is small; a registry that stalls must not hold a request open. */
const METADATA_TIMEOUT_MS = 10_000;
const PACKAGE_TIMEOUT_MS = 60_000;

/** The catalogue changes on a publish, not per request. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RegistryCapabilities {
  views: boolean;
  jobs: boolean;
  integrations: boolean;
}

export interface RegistryExtensionSummary {
  id: string;
  name: string;
  description?: string;
  version: string;
  publisher: string;
  categories: string[];
  keywords: string[];
  icon?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  capabilities: RegistryCapabilities;
  downloadUrl: string;
  size: number;
  sha256: string;
  publishedAt: string;
  detailUrl: string;
}

export interface RegistryExtensionVersion {
  version: string;
  downloadUrl: string;
  size: number;
  sha256: string;
  publishedAt: string;
  manifest: {
    routes: Array<{ path: string; title?: string; description?: string }>;
    jobs: Array<{ id: string; name?: string }>;
    integrations: Array<{ id: string; label?: string; description?: string }>;
  };
}

export interface RegistryExtensionDetail extends RegistryExtensionSummary {
  latest: string;
  /** Short curated store copy in markdown, or null when there is none. */
  about: string | null;
  screenshots: string[];
  versions: RegistryExtensionVersion[];
}

export interface RegistryIndex {
  schemaVersion: number;
  generatedAt: string;
  extensions: RegistryExtensionSummary[];
}

/**
 * The configured registry origin, or null when the operator turned the store
 * off by setting `VEKTOR_MARKETPLACE_URL` empty. Everything else in this module
 * treats null as "no store", not as "fall back to the default".
 */
export function registryBaseUrl(): string | null {
  return marketplaceOrigin();
}

function requireRegistry(): string {
  const base = registryBaseUrl();
  if (!base) {
    throw new RegistryError("No extension store is configured on this server", 404);
  }
  return base;
}

/**
 * Resolve a URL the registry handed us against the registry itself.
 *
 * Registry documents carry paths, not absolute URLs, so a mirror serving the
 * official build works unchanged. Resolving here is also what makes the origin
 * check meaningful for the absolute case: an injected `https://evil.test/x`
 * survives `new URL` untouched and is then rejected by the caller's pin.
 */
function resolveRegistryUrl(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString();
  } catch {
    throw new RegistryError("Extension store returned an unusable URL");
  }
}

/**
 * Whether `candidate` is the same host as `origin` under the two rewrites a site
 * is allowed to perform on itself: dropping or adding a leading `www.`, and
 * upgrading http to https.
 *
 * Both are ordinary canonical-host redirects — `vektorapp.org` answers with a
 * 308 to `www.vektorapp.org` — and an operator who configures one of the pair
 * plainly means the other too. Neither lets the *content* of a registry choose
 * a host: an attacker's redirect to another domain is still refused, because
 * the comparison is against the configured origin, not against the last hop.
 */
function isCanonicalVariant(candidate: URL, origin: URL): boolean {
  if (candidate.protocol === "http:" && origin.protocol === "https:") return false;
  if (candidate.port !== origin.port) return false;

  const bare = (host: string) => host.replace(/^www\./, "");
  return bare(candidate.hostname) === bare(origin.hostname);
}

/**
 * Restrict every hop to the registry's own origin.
 *
 * The registry URL is operator-configured, so it is allowed to be an internal
 * host — a mirror on the LAN is a legitimate setup, and the public/private
 * check that guards user-supplied URLs would forbid it. What must not happen is
 * the registry's *content* steering the server elsewhere: `downloadUrl` comes
 * out of a JSON document, and a redirect comes out of a response header. Both
 * are pinned here instead.
 */
function sameOriginValidator(origin: string) {
  const pinned = new URL(origin);
  return async (url: string): Promise<ValidatedUrl> => {
    const parsed = parseHttpUrl(url);
    if (parsed.origin !== origin && !isCanonicalVariant(parsed, pinned)) {
      throw new SsrfError(
        `Extension store URL must stay on ${origin}, got ${parsed.origin}`,
      );
    }
    return { url: parsed, addresses: [] };
  };
}

/**
 * Fetch from the registry. The allowed origin is always the *configured* one —
 * never the origin of the URL being fetched, which for a `downloadUrl` is a
 * value the registry's own JSON chose.
 */
async function registryFetch(url: string, timeoutMs: number): Promise<Response> {
  const origin = requireRegistry();

  let response: Response;
  try {
    response = await safeFetch(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json, application/zip" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      },
      sameOriginValidator(origin),
    );
  } catch (error) {
    if (error instanceof SsrfError) throw new RegistryError(error.message, 502);
    appLogger.warn("Extension store request failed", { url, error });
    throw new RegistryError("Could not reach the extension store");
  }

  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    throw new RegistryError("Not found in the extension store", 404);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new RegistryError(`Extension store returned ${response.status}`);
  }

  return response;
}

async function registryJson<T>(path: string): Promise<T> {
  const response = await registryFetch(
    `${requireRegistry()}${path}`,
    METADATA_TIMEOUT_MS,
  );
  try {
    return (await response.json()) as T;
  } catch {
    throw new RegistryError("Extension store returned malformed JSON");
  }
}

let catalogueCache: { value: RegistryIndex; expiresAt: number; origin: string } | null =
  null;

/**
 * The store catalogue. Cached per origin for a few minutes: the in-app store
 * fetches it on open, and every member of every space would otherwise hit the
 * registry directly.
 */
export async function fetchRegistryIndex(
  options: { force?: boolean } = {},
): Promise<RegistryIndex> {
  const origin = requireRegistry();
  const now = Date.now();

  if (
    !options.force &&
    catalogueCache &&
    catalogueCache.origin === origin &&
    catalogueCache.expiresAt > now
  ) {
    return catalogueCache.value;
  }

  const index = await registryJson<RegistryIndex>(`${REGISTRY_BASE_PATH}/index.json`);
  if (!Array.isArray(index?.extensions)) {
    throw new RegistryError("Extension store returned an unexpected catalogue");
  }

  catalogueCache = { value: index, expiresAt: now + CATALOGUE_TTL_MS, origin };
  return index;
}

/**
 * Turn the registry's relative display URLs into ones a browser can load. The
 * server knows where the registry is; the browser only sees what this returns.
 */
export function absolutizeListing<T extends { icon?: string; screenshots?: string[] }>(
  listing: T,
): T {
  const origin = registryBaseUrl();
  if (!origin) return listing;

  const toAbsolute = (url: string) => {
    try {
      return new URL(url, origin).toString();
    } catch {
      return url;
    }
  };

  return {
    ...listing,
    icon: listing.icon ? toAbsolute(listing.icon) : listing.icon,
    screenshots: listing.screenshots?.map(toAbsolute),
  };
}

/** Ids are path segments; anything else must not reach the registry URL. */
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function fetchRegistryExtension(
  extensionId: string,
): Promise<RegistryExtensionDetail> {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new RegistryError("Invalid extension id", 400);
  }

  const detail = await registryJson<RegistryExtensionDetail>(
    `${REGISTRY_BASE_PATH}/${extensionId}.json`,
  );
  if (detail?.id !== extensionId || !Array.isArray(detail.versions)) {
    throw new RegistryError("Extension store returned an unexpected response");
  }
  return detail;
}

export interface ResolvedRegistryPackage {
  detail: RegistryExtensionDetail;
  version: RegistryExtensionVersion;
  buffer: Buffer;
}

/**
 * Resolve an extension to a verified package.
 *
 * The version is looked up in the registry's own document rather than taken
 * from the caller, so the only thing a caller chooses is *which* published
 * version — never where the bytes come from. The download is capped and its
 * checksum checked before the buffer is handed back, so nothing unverified
 * reaches the unzipper.
 */
export async function downloadRegistryPackage(
  extensionId: string,
  requestedVersion?: string,
): Promise<ResolvedRegistryPackage> {
  const detail = await fetchRegistryExtension(extensionId);

  const version = requestedVersion
    ? detail.versions.find((candidate) => candidate.version === requestedVersion)
    : (detail.versions.find((candidate) => candidate.version === detail.latest) ??
      detail.versions[0]);

  if (!version) {
    throw new RegistryError(
      requestedVersion
        ? `Version ${requestedVersion} of '${extensionId}' is not in the extension store`
        : `'${extensionId}' has no published versions`,
      404,
    );
  }

  if (version.size > MAX_PACKAGE_BYTES) {
    throw new RegistryError("Extension package exceeds the maximum size of 5MB", 400);
  }

  const response = await registryFetch(
    resolveRegistryUrl(version.downloadUrl, requireRegistry()),
    PACKAGE_TIMEOUT_MS,
  );
  const buffer = await readCapped(response, MAX_PACKAGE_BYTES);

  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== version.sha256) {
    appLogger.error("Extension store package failed checksum verification", {
      extensionId,
      version: version.version,
      expected: version.sha256,
      actual: digest,
    });
    throw new RegistryError(
      "Extension package did not match the checksum published by the store",
    );
  }

  return { detail, version, buffer };
}

/**
 * Read a body, aborting once it exceeds `limit`. `Content-Length` is a claim,
 * not a guarantee, so the cap is enforced against the bytes as they arrive.
 */
async function readCapped(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new RegistryError("Extension package exceeds the maximum size of 5MB", 400);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new RegistryError("Extension store returned an empty package");

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new RegistryError("Extension package exceeds the maximum size of 5MB", 400);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
