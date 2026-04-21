import { context, trace } from "@opentelemetry/api";
import { logs, SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";

const logger = logs.getLogger("wiki.app");

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : {
      cause: error.cause instanceof Error ? serializeError(error.cause) : error.cause,
    }),
  };
}

function serializeAttributeValue(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  return value;
}

function formatConsoleMessage(
  message: string,
  attributes?: Record<string, unknown>,
): string {
  if (!attributes || Object.keys(attributes).length === 0) {
    return message;
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    const serializedValue = serializeAttributeValue(value);
    if (
      serializedValue === null ||
      serializedValue === undefined ||
      typeof serializedValue === "string" ||
      typeof serializedValue === "number" ||
      typeof serializedValue === "boolean"
    ) {
      parts.push(`${key}=${JSON.stringify(serializedValue)}`);
      continue;
    }

    try {
      parts.push(`${key}=${JSON.stringify(serializedValue)}`);
    } catch {
      parts.push(`${key}=${JSON.stringify(String(serializedValue))}`);
    }
  }

  return `${message} ${parts.join(" ")}`;
}

function toLogAttributes(
  attributes?: Record<string, unknown>,
): LogAttributes | undefined {
  if (!attributes) return undefined;
  const out: LogAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const serializedValue = serializeAttributeValue(value);
    if (serializedValue === undefined) {
      continue;
    }
    if (
      serializedValue === null ||
      typeof serializedValue === "string" ||
      typeof serializedValue === "number" ||
      typeof serializedValue === "boolean"
    ) {
      out[key] = serializedValue as string | number | boolean | null;
      continue;
    }

    try {
      out[key] = JSON.stringify(serializedValue);
    } catch {
      out[key] = String(serializedValue);
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
    console.debug(formatConsoleMessage(message, attributes));
    emit(SeverityNumber.DEBUG, "DEBUG", message, attributes);
  },
  info(message: string, attributes?: Record<string, unknown>) {
    console.info(formatConsoleMessage(message, attributes));
    emit(SeverityNumber.INFO, "INFO", message, attributes);
  },
  warn(message: string, attributes?: Record<string, unknown>) {
    console.warn(formatConsoleMessage(message, attributes));
    emit(SeverityNumber.WARN, "WARN", message, attributes);
  },
  error(message: string, attributes?: Record<string, unknown>) {
    console.error(formatConsoleMessage(message, attributes));
    emit(SeverityNumber.ERROR, "ERROR", message, attributes);
  },
};
