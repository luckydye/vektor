import {
  SpanStatusCode,
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import { config } from "../config.ts";

const INSTRUMENTATION_SCOPE = "wiki.observability";
const DEFAULT_OTLP_HTTP_ENDPOINT = "http://127.0.0.1:4318";
const DEFAULT_METRICS_EXPORT_INTERVAL_MS = 10_000;
const GLOBAL_OTEL_INIT_KEY = "__wikiOtelInitialized";
const GLOBAL_OTEL_SDK_KEY = "__wikiOtelSdk";

type OTelGlobal = typeof globalThis & {
  [GLOBAL_OTEL_INIT_KEY]?: boolean;
  [GLOBAL_OTEL_SDK_KEY]?: NodeSDK | null;
};

function toBool(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function otlpUrl(base: string | undefined, path: string): string {
  const endpoint = (base || DEFAULT_OTLP_HTTP_ENDPOINT).replace(/\/+$/, "");
  return `${endpoint}${path}`;
}

function samplerFromConfig(name: string | undefined, arg: string | undefined): Sampler {
  switch ((name || "parentbased_traceidratio").toLowerCase()) {
    case "always_on":
      return new AlwaysOnSampler();
    case "always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
      return new TraceIdRatioBasedSampler(toRatio(arg, 1));
    case "parentbased_always_on":
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    default:
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(toRatio(arg, 0.2)),
      });
  }
}

function diagLevelFromConfig(level: string | undefined): DiagLogLevel {
  switch ((level || "error").toLowerCase()) {
    case "all":
      return DiagLogLevel.ALL;
    case "verbose":
      return DiagLogLevel.VERBOSE;
    case "debug":
      return DiagLogLevel.DEBUG;
    case "info":
      return DiagLogLevel.INFO;
    case "warn":
      return DiagLogLevel.WARN;
    default:
      return DiagLogLevel.ERROR;
  }
}

export function initTelemetry(): void {
  const otelGlobal = globalThis as OTelGlobal;
  if (otelGlobal[GLOBAL_OTEL_INIT_KEY]) return;
  otelGlobal[GLOBAL_OTEL_INIT_KEY] = true;

  const appConfig = config();
  if (!toBool(appConfig.OTEL_ENABLED, false)) return;

  diag.setLogger(
    new DiagConsoleLogger(),
    diagLevelFromConfig(appConfig.OTEL_DIAG_LOG_LEVEL),
  );

  if (appConfig.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = appConfig.OTEL_SERVICE_NAME;
  }

  const traceExporter = new OTLPTraceExporter({
    url:
      appConfig.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      otlpUrl(appConfig.OTEL_EXPORTER_OTLP_ENDPOINT, "/v1/traces"),
  });

  const metricExporter = new OTLPMetricExporter({
    url:
      appConfig.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
      otlpUrl(appConfig.OTEL_EXPORTER_OTLP_ENDPOINT, "/v1/metrics"),
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: toInt(
      appConfig.OTEL_METRICS_EXPORT_INTERVAL_MS,
      DEFAULT_METRICS_EXPORT_INTERVAL_MS,
    ),
  });

  const sdk = new NodeSDK({
    traceExporter,
    metricReader,
    sampler: samplerFromConfig(
      appConfig.OTEL_TRACES_SAMPLER,
      appConfig.OTEL_TRACES_SAMPLER_ARG,
    ),
  });
  otelGlobal[GLOBAL_OTEL_SDK_KEY] = sdk;

  Promise.resolve(sdk.start()).catch((error) => {
    console.error("Failed to initialize OpenTelemetry SDK", error);
  });
}

export async function shutdownTelemetry(): Promise<void> {
  const otelGlobal = globalThis as OTelGlobal;
  const current = otelGlobal[GLOBAL_OTEL_SDK_KEY];
  if (!current) return;
  otelGlobal[GLOBAL_OTEL_SDK_KEY] = null;
  await current.shutdown();
}

export const otelTrace = trace;
export const otelMetrics = metrics;

export function activeTraceHeaders(): { traceparent?: string; tracestate?: string } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    traceparent: carrier.traceparent,
    tracestate: carrier.tracestate,
  };
}

export function contextFromTraceHeaders(
  traceparent?: string | null,
  tracestate?: string | null,
): Context {
  const carrier: Record<string, string> = {};
  if (traceparent) carrier.traceparent = traceparent;
  if (tracestate) carrier.tracestate = tracestate;
  return propagation.extract(context.active(), carrier);
}

export async function withSpan<T>(
  name: string,
  options: {
    attributes?: Attributes;
    traceparent?: string | null;
    tracestate?: string | null;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(INSTRUMENTATION_SCOPE);
  const parentContext = contextFromTraceHeaders(options.traceparent, options.tracestate);

  return tracer.startActiveSpan(
    name,
    {
      attributes: options.attributes,
    },
    parentContext,
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
