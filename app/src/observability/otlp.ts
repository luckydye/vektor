/**
 * OTLP/HTTP log export: `appLogger` calls become OpenTelemetry log records,
 * POSTed as OTLP/JSON to a collector. Off until an endpoint is configured.
 *
 * Dependency-free on purpose — the wire format is a small stable JSON document
 * and the batching we need is a queue plus a timer, which the official SDK
 * would only wrap in a large transitive dependency tree.
 */

import { config } from "#config";

/** Severity numbers from the OTel logs data model. */
const SEVERITY_NUMBERS = { debug: 5, info: 9, warn: 13, error: 17 } as const;

export type LogLevel = keyof typeof SEVERITY_NUMBERS;

/** Records held while an export is in flight; beyond this, new records drop. */
const MAX_QUEUE_RECORDS = 2048;
/** Records per HTTP request. */
const MAX_BATCH_RECORDS = 512;
/** How long records wait for company before being shipped. */
const SCHEDULE_DELAY_MS = 1000;
const EXPORT_TIMEOUT_MS = 10_000;
/** Nested values deeper than this are stringified, which also terminates
 * cyclic structures. */
const MAX_ATTRIBUTE_DEPTH = 5;

export function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined
      ? {}
      : {
          cause: error.cause instanceof Error ? serializeError(error.cause) : error.cause,
        }),
  };
}

// ---------------------------------------------------------------------------
// Attribute encoding (protobuf `AnyValue`, JSON mapping)
// ---------------------------------------------------------------------------

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } };

interface KeyValue {
  key: string;
  value: AnyValue;
}

/** Encodes a value, or returns undefined for values OTLP cannot carry. */
function toAnyValue(value: unknown, depth: number): AnyValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    // NaN/Infinity would serialize as JSON null and cost us the whole batch.
    if (!Number.isFinite(value)) return { stringValue: String(value) };
    // int64 is encoded as a string in the JSON mapping.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Error) return toAnyValue(serializeError(value), depth);
  if (value instanceof Date) return { stringValue: value.toISOString() };
  if (depth >= MAX_ATTRIBUTE_DEPTH) return { stringValue: String(value) };

  if (Array.isArray(value)) {
    const values: AnyValue[] = [];
    for (const entry of value) {
      const encoded = toAnyValue(entry, depth + 1);
      if (encoded) values.push(encoded);
    }
    return { arrayValue: { values } };
  }
  if (typeof value !== "object") return { stringValue: String(value) };

  return { kvlistValue: { values: toKeyValues(value as Record<string, unknown>, depth + 1) } };
}

function toKeyValues(source: Record<string, unknown>, depth = 0): KeyValue[] {
  const values: KeyValue[] = [];
  for (const [key, raw] of Object.entries(source)) {
    const value = toAnyValue(raw, depth);
    if (value) values.push({ key, value });
  }
  return values;
}

/**
 * Encodes log attributes, additionally mapping the first Error-valued entry to
 * the `exception.*` semantic convention — that is what backends key their
 * error grouping and stack-trace views off.
 */
function encodeAttributes(attributes: Record<string, unknown> | undefined): KeyValue[] {
  if (!attributes) return [];

  const encoded = toKeyValues(attributes);
  const error = Object.values(attributes).find((value) => value instanceof Error);
  if (error instanceof Error) {
    encoded.push(
      { key: "exception.type", value: { stringValue: error.name } },
      { key: "exception.message", value: { stringValue: error.message } },
      { key: "exception.stacktrace", value: { stringValue: error.stack ?? "" } },
    );
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface OtlpConfig {
  endpoint: string;
  headers: Record<string, string>;
  resource: KeyValue[];
}

/** Parses the `k1=v1,k2=v2` header form, whose values are percent-encoded. */
function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of raw?.split(",") ?? []) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, Math.max(separator, 0)).trim();
    if (separator <= 0 || !key) continue;
    const value = entry.slice(separator + 1).trim();
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      // A stray `%` is not worth failing the whole export over.
      headers[key] = value;
    }
  }
  return headers;
}

let cachedConfig: OtlpConfig | null | undefined;

function getOtlpConfig(): OtlpConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = config();
  // The configured endpoint is a base URL the signal path is appended to, per
  // the OTLP exporter spec.
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!baseEndpoint) {
    cachedConfig = null;
    return cachedConfig;
  }

  cachedConfig = {
    endpoint: `${baseEndpoint.replace(/\/+$/, "")}/v1/logs`,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    resource: toKeyValues({ "service.name": env.OTEL_SERVICE_NAME?.trim() || "vektor" }),
  };
  return cachedConfig;
}

// ---------------------------------------------------------------------------
// Queue and export
// ---------------------------------------------------------------------------

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: KeyValue[];
}

const queue: OtlpLogRecord[] = [];
let exportTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/** Queues a log record for export. No-op unless an endpoint is configured. */
export function recordOtlpLog(
  level: LogLevel,
  message: string,
  attributes?: Record<string, unknown>,
): void {
  if (!getOtlpConfig()) return;

  if (queue.length >= MAX_QUEUE_RECORDS) {
    // The collector is unreachable or too slow; drop rather than grow without
    // bound. Console output still has the line.
    droppedRecords += 1;
    return;
  }

  queue.push({
    timeUnixNano: `${Date.now()}000000`,
    severityNumber: SEVERITY_NUMBERS[level],
    severityText: level.toUpperCase(),
    body: { stringValue: message },
    attributes: encodeAttributes(attributes),
  });

  if (queue.length >= MAX_BATCH_RECORDS) {
    void drainQueue();
  }
  scheduleExport();
}

function scheduleExport(): void {
  if (exportTimer) return;
  exportTimer = setTimeout(() => {
    exportTimer = null;
    void drainQueue();
  }, SCHEDULE_DELAY_MS);
  // Pending logs must not keep the process alive.
  exportTimer.unref?.();
}

/**
 * Ships everything queued. Only one export runs at a time so records reach the
 * collector in order and memory stays bounded by the queue cap; concurrent
 * callers join the running drain.
 */
function drainQueue(): Promise<void> {
  if (inFlight) return inFlight;

  const otlpConfig = getOtlpConfig();
  if (!otlpConfig) return Promise.resolve();

  inFlight = (async () => {
    try {
      while (queue.length > 0) {
        await sendBatch(otlpConfig, queue.splice(0, MAX_BATCH_RECORDS));
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Exports pending records now (e.g. before a controlled shutdown). */
export async function flushOtlpLogs(): Promise<void> {
  if (!getOtlpConfig()) return;
  if (exportTimer) {
    clearTimeout(exportTimer);
    exportTimer = null;
  }
  await drainQueue();
}

/**
 * A batch the collector rejects is dropped, not retried: the same lines are on
 * stdout/stderr, so a retry queue would buy little for the state it costs.
 */
async function sendBatch(otlpConfig: OtlpConfig, records: OtlpLogRecord[]): Promise<void> {
  const payload = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: otlpConfig.resource },
        scopeLogs: [{ scope: { name: "@vektorapp/app" }, logRecords: records }],
      },
    ],
  });

  try {
    const response = await fetch(otlpConfig.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...otlpConfig.headers },
      body: payload,
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    const detail = await response.text().catch(() => "");
    if (!response.ok) {
      reportExportFailure(`HTTP ${response.status} ${detail.slice(0, 200)}`, records.length);
    }
  } catch (error) {
    reportExportFailure(String(error), records.length);
  }
}

// Failures are written straight to stderr rather than through `appLogger`: a
// failing export that logged through the logger would queue another record and
// feed itself. Rate limited so an unreachable collector cannot flood the log.
const FAILURE_REPORT_INTERVAL_MS = 60_000;
let lastFailureReportMs = 0;
let droppedRecords = 0;

function reportExportFailure(reason: string, records: number): void {
  droppedRecords += records;

  const now = Date.now();
  if (now - lastFailureReportMs < FAILURE_REPORT_INTERVAL_MS) return;
  lastFailureReportMs = now;

  try {
    process.stderr.write(
      `OTLP log export failed: ${reason} droppedRecords=${droppedRecords}\n`,
    );
  } catch {
    // Losing the diagnostic must never take the server down.
  }
}
