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
 *   table rejects. Adding a capability is a deliberate edit to this file.
 * - **Space operations keep going through the HTTP API.** `readDocument` and
 *   friends call the local origin with a scoped job token, exactly as before, so
 *   authorization stays in the route handlers and is not re-derived here.
 *   Everything else — the compute helpers, the filesystem, subprocesses — is
 *   native, because there is no route to protect and no reason to pay for a hop.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { config, getLocalOrigin } from "#config";
import { createJobToken } from "#jobs/jobToken.ts";
import {
  isPrivateOrBlockedIp,
  safeFetch,
  type UrlValidator,
  urlHostname,
} from "#utils/ssrf.ts";
import { readXlsxRows } from "#utils/xlsx.ts";
import { createZipBuffer, unzipSync } from "#utils/zip.ts";
import { agentPrompt } from "./agentCapability.ts";
import type { CapabilityTable } from "./types.ts";

/** Base64 envelope marking binary data across the VM boundary. */
const BYTES_KEY = "__bytes";

/** Largest response body / file / subprocess output accepted from one call. */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
/** Ceiling for a single `sleep`, so a job cannot park past its own deadline. */
const MAX_SLEEP_MS = 5 * 60 * 1000;
/** Wall-clock ceiling for one subprocess. */
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Binaries a job may run: the document-conversion tools jobs need and cannot
 * reasonably reimplement in-process. Fixed names, never a path and never
 * guest-supplied, so `exec` is a door to specific tools rather than to the
 * shell — and only to the three the image installs, since allowlisting a tool
 * that does not ship buys nothing and would admit it the day it does.
 */
const EXEC_ALLOWLIST = new Set(["htmlq", "pandoc", "rsvg-convert"]);

export interface CapabilityContext {
  spaceId: string;
  /** Logical job id; scopes the disk cache and labels errors. */
  jobId: string;
  initiatedByUserId: string | null;
  onLog: (message: string) => void;
  signal?: AbortSignal;
  /** Capabilities layered on top of the standard table (workflows add runJob). */
  extra?: CapabilityTable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary and argument coercion
// ─────────────────────────────────────────────────────────────────────────────

function isBytesEnvelope(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[BYTES_KEY] === "string"
  );
}

/** Wrap bytes for the trip back into the VM, where they become a `Uint8Array`. */
function toBytes(data: Buffer | Uint8Array): Record<string, string> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { [BYTES_KEY]: buffer.toString("base64") };
}

/**
 * Accept whatever the guest passed as content: a string, a `Uint8Array` (as an
 * envelope), or nothing.
 */
function asBuffer(value: unknown): Buffer<ArrayBuffer> {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (isBytesEnvelope(value)) return Buffer.from(value[BYTES_KEY], "base64");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Array.isArray(value)) return Buffer.from(value as number[]);
  return Buffer.from(String(value), "utf8");
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isBytesEnvelope(value)) return asBuffer(value).toString("utf8");
  if (typeof value === "string") return value;
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checkPayloadSize(bytes: number, what: string): void {
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `${what} is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`,
    );
  }
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

  const hostname = urlHostname(url);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
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

  for (const address of addresses) {
    if (isPrivateOrBlockedIp(address)) {
      throw new Error(
        `fetch: ${url.hostname} resolves to the private address ${address}, which jobs cannot reach`,
      );
    }
  }

  // A literal IP has nothing to re-resolve, so nothing to pin.
  return { url, addresses: isIP(hostname) ? [] : addresses };
};

/**
 * Flatten a `Response` into the plain shape the prelude rebuilds a
 * `Response`-like object from. The body crosses once, as bytes.
 */
async function describeResponse(
  response: Response,
  requestedUrl: string,
): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer());
  checkPayloadSize(bytes.byteLength, `response from ${requestedUrl}`);

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // Cookies travel separately: a single header string cannot represent
    // multiple Set-Cookie values, and jobs that follow logins need them intact.
    if (key.toLowerCase() !== "set-cookie") headers[key] = value;
  });

  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url || requestedUrl,
    redirected: response.redirected,
    headers,
    setCookies: response.headers.getSetCookie?.() ?? [],
    body: toBytes(bytes),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scratch directory
// ─────────────────────────────────────────────────────────────────────────────

/** True when an already-resolved path is the scratch root or sits under it. */
function isInside(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A private directory per run, created on first use and removed at dispose. */
class Scratch {
  private root: string | null = null;

  async dir(): Promise<string> {
    this.root ??= await mkdtemp(join(tmpdir(), "vektor-job-"));
    return this.root;
  }

  /** Resolve a guest-supplied path, refusing anything outside the scratch root. */
  async resolve(rawPath: unknown): Promise<string> {
    const root = await this.dir();
    const requested = String(rawPath ?? "");
    if (!requested || isAbsolute(requested)) {
      throw new Error(`scratch: "${requested}" must be a relative path`);
    }
    const resolved = normalize(join(root, requested));
    if (!isInside(root, resolved)) {
      throw new Error(`scratch: "${requested}" escapes the scratch directory`);
    }
    return resolved;
  }

  /**
   * Vet one `exec` argument. Allowlisting the binary keeps guest input from
   * becoming a command, but the converters take input and output paths, so an
   * unchecked argument would read or write anywhere the server process can —
   * every argument is treated as a candidate location and has to resolve inside
   * the scratch tree, which ordinary flags and values do unchanged.
   */
  async assertArgAllowed(cwd: string, arg: string): Promise<void> {
    const root = await this.dir();
    // Unwrapping only, and only ever narrowing: `--flag=value` and `@argfile`
    // hide a path one level in, and a flag's value may be a `:`-separated
    // search path. An argument that matches neither shape is checked whole,
    // which is the stricter reading, so a missed shape cannot pass a path.
    const flag = /^-{1,2}[^=]*=/.exec(arg);
    const candidates = flag
      ? arg.slice(flag[0].length).split(":")
      : [arg.replace(/^@/, "")];

    for (const candidate of candidates) {
      if (!candidate) continue;
      // Both decisions are a parser's, not a pattern's. A URL names a location
      // no path check would see — `file:///etc/passwd`, and gio and libreoffice
      // answer to schemes not worth enumerating — and the URL parser sees
      // through the tabs, newlines and leading spaces a pattern trips over. The
      // slash keeps CSS selectors out of it: `a:hover` parses as a URL, and
      // htmlq takes selectors as arguments.
      if (candidate.includes("/") && URL.canParse(candidate)) {
        throw new Error(`exec: argument "${arg}" names a URL, not a scratch path`);
      }
      if (isAbsolute(candidate) || !isInside(root, normalize(join(cwd, candidate)))) {
        throw new Error(`exec: argument "${arg}" points outside the scratch directory`);
      }
    }
  }

  async destroy(): Promise<void> {
    if (!this.root) return;
    const root = this.root;
    this.root = null;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Disk cache
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number | null;
}

/** Cache scoped to one job id, persisted under the system temp directory. */
class JobCache {
  constructor(private readonly jobId: string) {}

  private path(key: string): string {
    const scope = createHash("sha256").update(this.jobId).digest("hex").slice(0, 16);
    const name = createHash("sha256").update(String(key)).digest("hex");
    return join(tmpdir(), `vektor-job-cache-${scope}`, `${name}.json`);
  }

  async get(key: string): Promise<{ hit: boolean; value: unknown }> {
    try {
      const entry = JSON.parse(await readFile(this.path(key), "utf8")) as CacheEntry;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        await this.delete(key);
        return { hit: false, value: null };
      }
      return { hit: true, value: entry.value };
    } catch {
      return { hit: false, value: null };
    }
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const file = this.path(key);
    const entry: CacheEntry = {
      value,
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
    };
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(entry), "utf8");
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The table
// ─────────────────────────────────────────────────────────────────────────────

export interface Capabilities {
  table: CapabilityTable;
  dispose(): Promise<void>;
}

export function createCapabilities(context: CapabilityContext): Capabilities {
  const { spaceId, jobId, initiatedByUserId, onLog, signal } = context;
  const scratch = new Scratch();
  const cache = new JobCache(jobId);

  // Space operations authenticate exactly as they did from the sandbox: a
  // short-lived token scoped to this space and the initiating user.
  const origin = getLocalOrigin();
  const token = createJobToken(spaceId, Date.now().toString(), initiatedByUserId ?? null);
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

  const contentTypeFor = (type: unknown): string =>
    type === "csv"
      ? "text/csv; charset=utf-8"
      : type === "app"
        ? "application/vnd.wiki.app+html; charset=utf-8"
        : "text/markdown; charset=utf-8";

  const table: CapabilityTable = {
    // ── timing ───────────────────────────────────────────────────────────────
    sleep: ((ms: unknown) =>
      new Promise<null>((resolve, reject) => {
        const delay = Math.min(Math.max(0, Number(ms) || 0), MAX_SLEEP_MS);
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(null);
        }, delay);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      })) as never,

    // ── network ──────────────────────────────────────────────────────────────
    fetch: (async (rawUrl: unknown, rawInit: unknown) => {
      const url = new URL(String(rawUrl));

      const init = asRecord(rawInit);
      const method = String(init.method ?? "GET").toUpperCase();
      const body =
        init.body === null || init.body === undefined
          ? undefined
          : isBytesEnvelope(init.body)
            ? asBuffer(init.body)
            : String(init.body);

      onLog(`${method} ${url.href}`);
      // Validated and pinned on every hop: a bare `fetch` here let a public 302
      // walk the server into loopback or the metadata endpoint.
      const response = await safeFetch(
        url.href,
        {
          method,
          headers: Object.fromEntries(
            Object.entries(asRecord(init.headers)).map(([k, v]) => [k, String(v)]),
          ),
          body,
          ...(init.redirect === "manual" ? { redirect: "manual" as const } : {}),
          signal,
        },
        assertEgressAllowed,
      );

      return await describeResponse(response, url.href);
    }) as never,

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
      onLog(`${method} ${path}`);

      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...Object.fromEntries(
            Object.entries(asRecord(init.headers)).map(([k, v]) => [k, String(v)]),
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
     * One turn with the ACP agent. The host streams it, so plan and tool-call
     * lines reach the run log as they happen.
     */
    agentPrompt: ((text: unknown) =>
      agentPrompt(String(text ?? ""), {
        origin,
        spaceId,
        token,
        onLog,
        signal,
      })) as never,

    // ── compute ──────────────────────────────────────────────────────────────
    hash: ((algorithm: unknown, data: unknown) =>
      createHash(String(algorithm ?? "sha256"))
        .update(asBuffer(data))
        .digest("hex")) as never,

    zipRead: ((bytes: unknown) => {
      const archive = unzipSync(new Uint8Array(asBuffer(bytes)));
      return {
        entries: Object.entries(archive).map(([name, data]) => ({
          name,
          data: toBytes(data),
        })),
      };
    }) as never,

    zipWrite: ((rawEntries: unknown) => {
      const entries = Array.isArray(rawEntries) ? rawEntries : [];
      return toBytes(
        createZipBuffer(
          entries.map((entry) => {
            const { name, data } = asRecord(entry);
            return { name: String(name), data: asBuffer(data) };
          }),
        ),
      );
    }) as never,

    /**
     * Parse a spreadsheet to a row grid. Host-side because the JS parser is a
     * 1.4 MB bundle that every job using it used to carry, and parsing it in an
     * interpreter is far slower than doing it here.
     */
    spreadsheetToRows: ((bytes: unknown, rawOptions: unknown) => {
      const options = asRecord(rawOptions);
      return readXlsxRows(new Uint8Array(asBuffer(bytes)), {
        cellDates: options.cellDates === true,
        raw: options.raw === true,
        blankRows: options.blankRows === true,
        sheet:
          typeof options.sheet === "string" || typeof options.sheet === "number"
            ? options.sheet
            : undefined,
      });
    }) as never,

    // ── scratch filesystem ───────────────────────────────────────────────────
    scratchRead: (async (path: unknown) => {
      const file = await scratch.resolve(path);
      const info = await stat(file);
      checkPayloadSize(info.size, `scratch file ${String(path)}`);
      return toBytes(await readFile(file));
    }) as never,

    scratchReadText: (async (path: unknown) =>
      (await readFile(await scratch.resolve(path))).toString("utf8")) as never,

    scratchWrite: (async (path: unknown, content: unknown) => {
      const file = await scratch.resolve(path);
      const data = asBuffer(content);
      checkPayloadSize(data.byteLength, `scratch write to ${String(path)}`);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, data);
      return null;
    }) as never,

    scratchList: (async (dir: unknown) => {
      const target = dir ? await scratch.resolve(dir) : await scratch.dir();
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    }) as never,

    scratchRemove: (async (path: unknown) => {
      await rm(await scratch.resolve(path), { recursive: true, force: true });
      return null;
    }) as never,

    scratchMkdir: (async (path: unknown) => {
      await mkdir(await scratch.resolve(path), { recursive: true });
      return null;
    }) as never,

    // ── tools ────────────────────────────────────────────────────────────────
    /**
     * Run one of a fixed set of conversion tools. The command must be an
     * allowlisted name and no shell is involved, so guest input cannot become a
     * command; every argument is confined to the scratch tree, so it cannot
     * become a path to another tenant's data either.
     */
    exec: (async (rawCommand: unknown, rawArgs: unknown, rawOptions: unknown) => {
      const command = String(rawCommand ?? "");
      if (!EXEC_ALLOWLIST.has(command)) {
        throw new Error(`exec: "${command}" is not an allowed tool`);
      }
      const args = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
      const options = asRecord(rawOptions);
      const cwd = options.cwd ? await scratch.resolve(options.cwd) : await scratch.dir();
      for (const arg of args) await scratch.assertArgAllowed(cwd, arg);

      onLog(`exec ${command} ${args.join(" ")}`);
      return await new Promise((resolve, reject) => {
        const child = execFile(
          command,
          args,
          {
            cwd,
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: MAX_PAYLOAD_BYTES,
            encoding: "buffer",
            signal,
            // No inherited environment: tools get a clean, minimal one.
            env: { PATH: process.env.PATH ?? "", HOME: cwd, LANG: "C.UTF-8" },
          },
          (error, stdout, stderr) => {
            const text = stderr.toString("utf8");
            if (error) {
              reject(new Error(`${command} failed: ${text || error.message}`));
              return;
            }
            resolve({ stdout: toBytes(stdout), stderr: text });
          },
        );
        if (options.stdin !== undefined && options.stdin !== null) {
          child.stdin?.end(asBuffer(options.stdin));
        }
      });
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
      await api(`/documents/${encodeURIComponent(String(documentId))}`, {
        method: "PUT",
        headers: { "Content-Type": contentTypeFor(type) },
        body: asText(content),
      });
      return null;
    }) as never,

    createDocument: (async (content: unknown, rawOptions: unknown) => {
      const options =
        typeof rawOptions === "string" ? { title: rawOptions } : asRecord(rawOptions);
      const headers: Record<string, string> = {
        "Content-Type": contentTypeFor(options.type),
      };
      if (options.title) headers["X-Document-Title"] = String(options.title);
      const response = await api("/documents", {
        method: "POST",
        headers,
        body: asText(content),
      });
      return ((await response.json()) as { document: unknown }).document;
    }) as never,

    searchDocuments: (async (query: unknown, limit: unknown) => {
      const params = new URLSearchParams({ q: String(query) });
      if (limit !== undefined && limit !== null) params.set("limit", String(limit));
      const response = await api(`/search?${params.toString()}`);
      return ((await response.json()) as { results: unknown }).results;
    }) as never,

    getSecret: (async (name: unknown) => {
      const response = await api(`/secrets/${encodeURIComponent(String(name))}`);
      return ((await response.json()) as { value: unknown }).value;
    }) as never,

    ...context.extra,
  };

  return {
    table,
    async dispose() {
      await scratch.destroy();
    },
  };
}
