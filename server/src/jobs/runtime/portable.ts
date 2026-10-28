/**
 * Capabilities that need nothing from the server: timing, outbound `fetch` and
 * the compute helpers, plus the byte envelope every capability shares. A node
 * runs these for its jobs itself, so they import nothing server-side.
 */

import { createHash, createHmac } from "node:crypto";
import { readXlsxRows } from "#utils/xlsx.ts";
import { createZipBuffer, unzipSync } from "#utils/zip.ts";
import type { CapabilityTable } from "./types.ts";

/** Base64 envelope marking binary data across the VM boundary. */
const BYTES_KEY = "__bytes";

/** Largest response body / file / subprocess output accepted from one call. */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
/** Ceiling for a single `sleep`, so a job cannot park past its own deadline. */
const MAX_SLEEP_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Binary and argument coercion
// ─────────────────────────────────────────────────────────────────────────────

export function isBytesEnvelope(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[BYTES_KEY] === "string"
  );
}

/** Wrap bytes for the trip back into the VM, where they become a `Uint8Array`. */
export function toBytes(data: Buffer | Uint8Array): Record<string, string> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { [BYTES_KEY]: buffer.toString("base64") };
}

/**
 * Accept whatever the guest passed as content: a string, a `Uint8Array` (as an
 * envelope), or nothing.
 */
export function asBuffer(value: unknown): Buffer<ArrayBuffer> {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (isBytesEnvelope(value)) return Buffer.from(value[BYTES_KEY], "base64");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Array.isArray(value)) return Buffer.from(value as number[]);
  return Buffer.from(String(value), "utf8");
}

export function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isBytesEnvelope(value)) return asBuffer(value).toString("utf8");
  if (typeof value === "string") return value;
  return String(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function checkPayloadSize(bytes: number, what: string): void {
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `${what} is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`,
    );
  }
}

/**
 * Flatten a `Response` into the plain shape the prelude rebuilds a
 * `Response`-like object from. The body crosses once, as bytes.
 */
export async function describeResponse(
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

/**
 * `request` performs the guest's `fetch`; it is where a host puts its egress
 * policy.
 */
export function createPortableCapabilities(
  request: (url: string, init: RequestInit & { method: string }) => Promise<Response>,
  signal?: AbortSignal,
): CapabilityTable {
  return {
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

      const response = await request(url.href, {
        method,
        headers: Object.fromEntries(
          Object.entries(asRecord(init.headers)).map(([k, v]) => [k, String(v)]),
        ),
        body,
        ...(init.redirect === "manual" ? { redirect: "manual" as const } : {}),
        signal,
      });

      return await describeResponse(response, url.href);
    }) as never,

    // ── compute ──────────────────────────────────────────────────────────────
    hash: ((algorithm: unknown, data: unknown) =>
      createHash(String(algorithm ?? "sha256"))
        .update(asBuffer(data))
        .digest("hex")) as never,

    /**
     * Keyed digest, bytes by default so the caller can chain one result into the
     * next key — AWS SigV4 derives its signing key that way, and a hex string
     * would have to be decoded at every step.
     */
    hmac: ((algorithm: unknown, key: unknown, data: unknown, encoding: unknown) => {
      const digest = createHmac(String(algorithm ?? "sha256"), asBuffer(key))
        .update(asBuffer(data))
        .digest();
      return String(encoding ?? "bytes") === "hex"
        ? digest.toString("hex")
        : toBytes(digest);
    }) as never,

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
  };
}
