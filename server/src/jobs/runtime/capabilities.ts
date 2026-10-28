/**
 * Everything a job is allowed to do, implemented once.
 *
 * This replaces the two near-identical wrappers that used to be stringified into
 * a worker thread and into an external sandbox process. Guest code no longer
 * implements capabilities on top of `fetch`; it asks the host, and the host is
 * here.
 *
 * Two rules shape the surface:
 *
 * - **Deny by default.** A capability the guest asks for that is not in this
 *   table rejects. Adding a capability is a deliberate edit to this file, or
 *   to the target's `JobVm` for the scratch directory and `exec`.
 * - **Space operations keep going through the HTTP API.** `readDocument` and
 *   friends call the local origin with a scoped job token, exactly as before, so
 *   authorization stays in the route handlers and is not re-derived here.
 *   Everything else — the compute helpers, the filesystem, subprocesses — is
 *   native, because there is no route to protect and no reason to pay for a hop.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Attribution } from "#acl/apps.ts";
import { config, getLocalOrigin } from "#config";
import { isSerializedDocumentType } from "#documents/types.ts";
import { applyTransform } from "#files/transforms.ts";
import { createJobToken } from "#jobs/jobToken.ts";
import { enqueueJobNotificationEmail } from "#notifications/enqueue.ts";
import type { Platform } from "#platform/platform.ts";
import {
  isLoopbackIp,
  isPrivateOrBlockedIp,
  type UrlValidator,
  urlHostname,
} from "#utils/ssrf.ts";
import { agentPrompt } from "./agentCapability.ts";
import { JobCache } from "./jobCache.ts";
import {
  asBuffer,
  asRecord,
  asText,
  checkPayloadSize,
  createPortableCapabilities,
  describeResponse,
  isBytesEnvelope,
  toBytes,
} from "./portable.ts";
import type { CapabilityTable } from "./types.ts";

/** Encoders the image addon ships; an unknown name would keep the input format silently. */
const IMAGE_OUTPUT_FORMATS = new Set(["webp", "jpeg", "png"]);

export interface CapabilityContext {
  spaceId: string;
  /** Logical job id; scopes the disk cache and labels errors. */
  jobId: string;
  initiatedByUserId: string | null;
  attribution: Attribution;
  onLog: (message: string) => void;
  signal?: AbortSignal;
  /**
   * The guest runs on a runner (#runners/jobs.ts), which brings its own
   * `fetch`, scratch directory and `exec`: the table leaves them out, so a
   * runner's job can never make the server fetch, touch disk or run tools.
   */
  onRunner?: boolean;
  /** Capabilities layered on top of the standard table (workflows add runJob). */
  extra?: CapabilityTable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Egress control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject requests aimed at this host or the local network. Egress is otherwise
 * open, since job code legitimately fetches the public internet. Only the error
 * wording and the `JOB_FETCH_ALLOW_PRIVATE` hatch are job-specific, so this is a
 * {@link UrlValidator} over the shared denylist rather than a second copy of it.
 */
export const assertEgressAllowed: UrlValidator = async (rawUrl) => {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`fetch: unsupported protocol "${url.protocol}"`);
  }
  // No pinning either: the hatch exists to reach the local network.
  if (config().JOB_FETCH_ALLOW_PRIVATE === "1") return { url, addresses: [] };

  const allowLoopback = config().JOB_FETCH_ALLOW_LOOPBACK === "1";
  const hostname = urlHostname(url);
  if (!allowLoopback && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new Error(`fetch: ${url.hostname} is not reachable from a job`);
  }

  // Resolve first so a public name pointing at a private address is caught too.
  const addresses = isIP(hostname)
    ? [hostname]
    : (
        await lookup(hostname, { all: true }).catch(() => {
          throw new Error(`fetch: could not resolve ${url.hostname}`);
        })
      ).map((record) => record.address);

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const address of addresses) {
    if (allowLoopback && isLoopbackIp(address)) {
      // Unproxied, the instance would believe a job-chosen `X-Forwarded-For`.
      if (port === new URL(getLocalOrigin()).port) {
        throw new Error(`fetch: ${url.host} is this instance, use apiFetch instead`);
      }
      continue;
    }
    if (isPrivateOrBlockedIp(address)) {
      throw new Error(
        `fetch: ${url.hostname} resolves to the private address ${address}, which jobs cannot reach`,
      );
    }
  }

  // A literal IP has nothing to re-resolve, so nothing to pin.
  return { url, addresses: isIP(hostname) ? [] : addresses };
};

// ─────────────────────────────────────────────────────────────────────────────
// The table
// ─────────────────────────────────────────────────────────────────────────────

export interface Capabilities {
  table: CapabilityTable;
  dispose(): Promise<void>;
}

export function createCapabilities(
  platform: Platform,
  context: CapabilityContext,
): Capabilities {
  const { spaceId, jobId, initiatedByUserId, attribution, onLog, signal } = context;
  const host = context.onRunner ? null : platform.jobVm.hostCapabilities(signal);
  const cache = new JobCache(platform.jobCache, jobId);

  // Space operations authenticate exactly as they did from the sandbox: a
  // short-lived token scoped to this space and the initiating user.
  const origin = getLocalOrigin();
  const token = createJobToken(
    spaceId,
    Date.now().toString(),
    initiatedByUserId ?? null,
    attribution,
  );
  const spaceUrl = (path: string) => `${origin}/api/v1/spaces/${spaceId}${path}`;

  async function api(
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const response = await fetch(spaceUrl(path), {
      ...init,
      headers: { ...(init.headers ?? {}), "X-Job-Token": token },
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => String(response.status));
      throw new Error(`${path} failed (${response.status}): ${detail}`);
    }
    return response;
  }

  // Validated and pinned on every hop: a bare `fetch` here let a public 302
  // walk the server into loopback or the metadata endpoint.
  const { fetch: guestFetch, ...portable } = createPortableCapabilities(
    (url, init) => platform.fetch(url, init, assertEgressAllowed),
    signal,
  );

  const table: CapabilityTable = {
    ...portable,
    ...(host && { fetch: guestFetch, ...host.table }),

    /**
     * Call this Vektor instance's own API with the run's job token.
     *
     * Jobs cannot reach the loopback interface through `fetch`, and they no
     * longer receive a token to authenticate with — but a few of them genuinely
     * need endpoints that have no dedicated capability (chat completions, for
     * one). This is that door: the host owns the origin and the credential, and
     * the guest only chooses a path.
     */
    apiFetch: (async (rawPath: unknown, rawInit: unknown) => {
      const path = String(rawPath ?? "");
      if (!path.startsWith("/")) {
        throw new Error(`apiFetch: path must start with "/" (got "${path}")`);
      }

      const init = asRecord(rawInit);
      const method = String(init.method ?? "GET").toUpperCase();

      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...Object.fromEntries(
            Object.entries(asRecord(init.headers))
              .filter(([k]) => k.toLowerCase() !== "x-forwarded-for")
              .map(([k, v]) => [k, String(v)]),
          ),
          "X-Job-Token": token,
          "X-Space-Id": spaceId,
        },
        body:
          init.body === null || init.body === undefined
            ? undefined
            : isBytesEnvelope(init.body)
              ? asBuffer(init.body)
              : String(init.body),
        signal,
      });

      return await describeResponse(response, `${origin}${path}`);
    }) as never,

    /**
     * One turn in an agent session, opening one unless `sessionId` names it.
     * The host streams it, so plan and tool-call lines reach the run log as
     * they happen.
     */
    agentPrompt: ((text: unknown, options: unknown) => {
      const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
      if (sessionId !== undefined && typeof sessionId !== "string") {
        throw new Error("agentPrompt: options.sessionId must be a string");
      }
      return agentPrompt(String(text ?? ""), {
        origin,
        spaceId,
        token,
        sessionId,
        onLog,
        signal,
      });
    }) as never,

    // ── compute ──────────────────────────────────────────────────────────────
    imageMetadata: (async (bytes: unknown) =>
      platform.imageTransformer.metadata(asBuffer(bytes))) as never,

    /**
     * Decode, fit inside the given box without enlarging, re-encode. Shares the
     * transformer and the no-upscale rule with the upload transform path.
     */
    imageTransform: (async (bytes: unknown, rawOptions: unknown) => {
      const options = asRecord(rawOptions);
      const input = asBuffer(bytes);
      checkPayloadSize(input.byteLength, "image input");
      const format = options.format ? String(options.format) : null;
      if (format !== null && !IMAGE_OUTPUT_FORMATS.has(format)) {
        throw new Error(`image.transform: "${format}" is not an output format`);
      }
      const quality = Math.min(100, Math.max(1, Number(options.quality) || 80));
      const out = await applyTransform(platform, input, {
        w: Math.max(0, Math.floor(Number(options.width) || 0)),
        h: Math.max(0, Math.floor(Number(options.height) || 0)),
        format: format as "webp" | "jpeg" | "png" | null,
        quality,
      });
      if (!out) throw new Error("image.transform: the input could not be transformed");
      return toBytes(out);
    }) as never,

    // ── cache ────────────────────────────────────────────────────────────────
    cacheGet: ((key: unknown) => cache.get(String(key))) as never,
    cacheSet: ((key: unknown, value: unknown, rawOptions: unknown) => {
      const { ttlMs } = asRecord(rawOptions);
      return cache.set(String(key), value, Number(ttlMs) || undefined).then(() => null);
    }) as never,
    cacheDelete: ((key: unknown) => cache.delete(String(key)).then(() => null)) as never,

    // ── space operations ─────────────────────────────────────────────────────
    uploadArtifact: (async (filename: unknown, content: unknown, mimeType: unknown) => {
      const data = asBuffer(content);
      checkPayloadSize(data.byteLength, `artifact ${String(filename)}`);
      const query = new URLSearchParams({ filename: String(filename) });
      onLog(`upload ${String(filename)} (${data.byteLength} bytes)`);
      const response = await api(`/uploads?${query}`, {
        method: "POST",
        body: data,
        headers: {
          Origin: origin,
          "Content-Type": mimeType ? String(mimeType) : "application/octet-stream",
        },
      });
      return ((await response.json()) as { url: string }).url;
    }) as never,

    readDocument: (async (documentId: unknown) => {
      const response = await api(`/documents/${encodeURIComponent(String(documentId))}`);
      const body = (await response.json()) as { document: { content: string } };
      return body.document.content;
    }) as never,

    writeDocument: (async (documentId: unknown, content: unknown, type: unknown) => {
      const text = asText(content);
      const serialized = isSerializedDocumentType(type);
      await api(`/documents/${encodeURIComponent(String(documentId))}`, {
        method: "PUT",
        headers: {
          "Content-Type": serialized
            ? "application/json"
            : "text/markdown; charset=utf-8",
        },
        body: serialized ? JSON.stringify({ content: text }) : text,
      });
      return null;
    }) as never,

    createDocument: (async (content: unknown, rawOptions: unknown) => {
      const options =
        typeof rawOptions === "string" ? { title: rawOptions } : asRecord(rawOptions);
      const text = asText(content);
      const serialized = isSerializedDocumentType(options.type);
      const headers: Record<string, string> = serialized
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "text/markdown; charset=utf-8" };
      if (!serialized && options.title) {
        headers["X-Document-Title"] = String(options.title);
      }
      if (!serialized && typeof options.type === "string") {
        headers["X-Document-Type"] = options.type;
      }
      const response = await api("/documents", {
        method: "POST",
        headers,
        body: serialized
          ? JSON.stringify({
              content: text,
              type: options.type,
              ...(options.title ? { properties: { title: String(options.title) } } : {}),
            })
          : text,
      });
      return ((await response.json()) as { document: unknown }).document;
    }) as never,

    searchDocuments: (async (query: unknown, limit: unknown) => {
      const params = new URLSearchParams({ q: String(query) });
      if (limit !== undefined && limit !== null) params.set("limit", String(limit));
      const response = await api(`/search?${params.toString()}`);
      return ((await response.json()) as { results: unknown }).results;
    }) as never,

    notifyInitiator: (async (documentId: unknown) => {
      if (!initiatedByUserId) {
        throw new Error(
          "notifyInitiator is unavailable for a job without an initiating user",
        );
      }
      const queued = await enqueueJobNotificationEmail(platform, {
        spaceId,
        documentId: String(documentId),
        actorId: initiatedByUserId,
      });
      onLog(`queued ${queued} job notification email(s)`);
      return queued;
    }) as never,

    getSecret: (async (name: unknown) => {
      const response = await api(`/secrets/${encodeURIComponent(String(name))}`);
      return ((await response.json()) as { value: unknown }).value;
    }) as never,

    ...context.extra,
  };

  return {
    table,
    dispose: async () => host?.dispose(),
  };
}
