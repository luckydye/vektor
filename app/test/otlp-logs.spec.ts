/**
 * Tests for OTLP/HTTP log export.
 *
 * A local HTTP server stands in for the collector and captures what the
 * exporter POSTs. The logger reads its endpoint config lazily and caches it, so
 * every case resets the module registry and re-imports after setting env.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
  body: OtlpPayload;
}

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
}

interface OtlpPayload {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{ scope: { name: string }; logRecords: OtlpLogRecord[] }>;
  }>;
}

const OTEL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
] as const;

interface Collector {
  origin: string;
  requests: CapturedRequest[];
  stop: () => void;
}

/** Collector stub that records every OTLP request it receives. */
function startCollector(status = 200): Collector {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: (await request.json()) as OtlpPayload,
      });
      return new Response("{}", { status });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** Fresh logger instance that picks up the current OTEL_* environment. */
async function loadLogger() {
  vi.resetModules();
  return (await import("#observability/logger.ts")).appLogger;
}

function attribute(attributes: OtlpKeyValue[], key: string): OtlpAnyValue | undefined {
  return attributes.find((entry) => entry.key === key)?.value;
}

function onlyRecords(payload: OtlpPayload): OtlpLogRecord[] {
  return payload.resourceLogs[0].scopeLogs[0].logRecords;
}

afterEach(() => {
  for (const key of OTEL_ENV_KEYS) {
    delete process.env[key];
  }
});

describe("OTLP log export", () => {
  it("is off unless an endpoint is configured", async () => {
    const collector = startCollector();
    try {
      const logger = await loadLogger();
      logger.info("no collector configured");
      await logger.flush();

      expect(collector.requests).toHaveLength(0);
    } finally {
      collector.stop();
    }
  });

  it("posts records to the collector with resource and scope", async () => {
    const collector = startCollector();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${collector.origin}/`;
      process.env.OTEL_SERVICE_NAME = "vektor-test";
      process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=secret%20token";

      const logger = await loadLogger();
      logger.info("document saved", { documentId: "doc_1" });
      await logger.flush();

      expect(collector.requests).toHaveLength(1);
      const [request] = collector.requests;
      // The endpoint is a base URL; the signal path is appended.
      expect(request.path).toBe("/v1/logs");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["x-api-key"]).toBe("secret token");

      const resource = request.body.resourceLogs[0].resource.attributes;
      expect(attribute(resource, "service.name")).toEqual({ stringValue: "vektor-test" });

      expect(request.body.resourceLogs[0].scopeLogs[0].scope.name).toBe("@vektorapp/app");

      const [record] = onlyRecords(request.body);
      expect(record.body).toEqual({ stringValue: "document saved" });
      expect(record.severityNumber).toBe(9);
      expect(record.severityText).toBe("INFO");
      expect(record.timeUnixNano).toMatch(/^\d{19}$/);
      expect(attribute(record.attributes, "documentId")).toEqual({ stringValue: "doc_1" });
    } finally {
      collector.stop();
    }
  });

  it("maps severities and encodes attribute types", async () => {
    const collector = startCollector();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

      const logger = await loadLogger();
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e", {
        count: 3,
        ratio: 1.5,
        ok: false,
        list: ["a", 1],
        nested: { inner: "value" },
        missing: null,
      });
      await logger.flush();

      const records = collector.requests.flatMap((request) => onlyRecords(request.body));
      expect(records.map((record) => record.severityNumber)).toEqual([5, 9, 13, 17]);
      expect(records.map((record) => record.severityText)).toEqual([
        "DEBUG",
        "INFO",
        "WARN",
        "ERROR",
      ]);

      const { attributes } = records[3];
      expect(attribute(attributes, "count")).toEqual({ intValue: "3" });
      expect(attribute(attributes, "ratio")).toEqual({ doubleValue: 1.5 });
      expect(attribute(attributes, "ok")).toEqual({ boolValue: false });
      expect(attribute(attributes, "list")).toEqual({
        arrayValue: { values: [{ stringValue: "a" }, { intValue: "1" }] },
      });
      expect(attribute(attributes, "nested")).toEqual({
        kvlistValue: { values: [{ key: "inner", value: { stringValue: "value" } }] },
      });
      // Values OTLP cannot represent are dropped rather than sent as empty.
      expect(attribute(attributes, "missing")).toBeUndefined();
    } finally {
      collector.stop();
    }
  });

  it("maps an Error attribute onto the exception semantic convention", async () => {
    const collector = startCollector();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

      const logger = await loadLogger();
      logger.error("upload failed", { error: new TypeError("bad input") });
      await logger.flush();

      const [record] = onlyRecords(collector.requests[0].body);
      expect(attribute(record.attributes, "exception.type")).toEqual({
        stringValue: "TypeError",
      });
      expect(attribute(record.attributes, "exception.message")).toEqual({
        stringValue: "bad input",
      });
      expect(
        attribute(record.attributes, "exception.stacktrace")?.stringValue,
      ).toContain("bad input");

      // The original attribute is kept too, so its key stays greppable.
      const serialized = attribute(record.attributes, "error")?.kvlistValue?.values ?? [];
      expect(attribute(serialized, "message")).toEqual({ stringValue: "bad input" });
    } finally {
      collector.stop();
    }
  });

  it("batches records queued between flushes into one request", async () => {
    const collector = startCollector();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

      const logger = await loadLogger();
      for (let index = 0; index < 5; index += 1) {
        logger.info(`line ${index}`);
      }
      await logger.flush();

      expect(collector.requests).toHaveLength(1);
      expect(onlyRecords(collector.requests[0].body).map((record) => record.body.stringValue)).toEqual([
        "line 0",
        "line 1",
        "line 2",
        "line 3",
        "line 4",
      ]);
    } finally {
      collector.stop();
    }
  });

  it("survives a collector that rejects the batch", async () => {
    const collector = startCollector(400);
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.origin;

      const logger = await loadLogger();
      logger.info("dropped on the floor");
      await expect(logger.flush()).resolves.toBeUndefined();

      // Rejected batches are dropped, not retried.
      expect(collector.requests).toHaveLength(1);
    } finally {
      collector.stop();
    }
  });
});
