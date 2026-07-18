function serializeError(error: Error): Record<string, unknown> {
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

export const appLogger = {
  debug(message: string, attributes?: Record<string, unknown>) {
    console.debug(formatConsoleMessage(message, attributes));
  },
  info(message: string, attributes?: Record<string, unknown>) {
    console.info(formatConsoleMessage(message, attributes));
  },
  warn(message: string, attributes?: Record<string, unknown>) {
    console.warn(formatConsoleMessage(message, attributes));
  },
  error(message: string, attributes?: Record<string, unknown>) {
    console.error(formatConsoleMessage(message, attributes));
  },
};
