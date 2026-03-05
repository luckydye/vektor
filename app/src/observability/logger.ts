import { context, trace } from "@opentelemetry/api";
import { logs, SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";

const logger = logs.getLogger("wiki.app");

function toLogAttributes(
  attributes?: Record<string, unknown>,
): LogAttributes | undefined {
  if (!attributes) return undefined;
  const out: LogAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
      continue;
    }

    try {
      out[key] = JSON.stringify(value);
    } catch {
      out[key] = String(value);
    }
  }
  return out;
}

function emit(
  severityNumber: SeverityNumber,
  severityText: string,
  message: string,
  attributes?: Record<string, unknown>,
): void {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();

  logger.emit({
    severityNumber,
    severityText,
    body: message,
    context: context.active(),
    timestamp: Date.now(),
    attributes: toLogAttributes({
      ...attributes,
      trace_id: spanContext?.traceId,
      span_id: spanContext?.spanId,
    }),
  });
}

export const appLogger = {
  debug(message: string, attributes?: Record<string, unknown>) {
    console.debug(message, attributes ?? "");
    emit(SeverityNumber.DEBUG, "DEBUG", message, attributes);
  },
  info(message: string, attributes?: Record<string, unknown>) {
    console.info(message, attributes ?? "");
    emit(SeverityNumber.INFO, "INFO", message, attributes);
  },
  warn(message: string, attributes?: Record<string, unknown>) {
    console.warn(message, attributes ?? "");
    emit(SeverityNumber.WARN, "WARN", message, attributes);
  },
  error(message: string, attributes?: Record<string, unknown>) {
    console.error(message, attributes ?? "");
    emit(SeverityNumber.ERROR, "ERROR", message, attributes);
  },
};
