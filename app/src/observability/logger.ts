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

// Log batching.
//
// `console.*` writes synchronously to the underlying fd (processChunkSync ->
// writeSync). When stdout/stderr is a pipe (the usual production case: output
// captured by a log collector), a burst of log lines blocks the event loop on
// one syscall per line — under load this was a dominant cause of multi-second
// stalls. We instead buffer formatted lines and flush them in a single write
// per stream on a short timer, coalescing bursts into far fewer syscalls.
//
// Set LOG_SYNC=1 to opt out (write immediately) for debugging.
const FLUSH_INTERVAL_MS = 10;
// Flush early if the buffer grows large, to bound memory and per-flush latency.
const MAX_BUFFERED_LINES = 2000;
const LOG_SYNC = process.env.LOG_SYNC === "1";

const stdoutBuffer: string[] = [];
const stderrBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function writeBatch(stream: NodeJS.WriteStream, buffer: string[]): void {
  if (buffer.length === 0) return;
  const chunk = `${buffer.join("\n")}\n`;
  buffer.length = 0;
  try {
    stream.write(chunk);
  } catch {
    // Ignore write failures (e.g. EPIPE when the reader has gone away); losing
    // a log line must never take down the server.
  }
}

function flushLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writeBatch(process.stdout, stdoutBuffer);
  writeBatch(process.stderr, stderrBuffer);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
  // Don't keep the process alive just to flush logs.
  flushTimer.unref?.();
}

function enqueue(buffer: string[], line: string): void {
  if (LOG_SYNC) {
    buffer.push(line);
    flushLogs();
    return;
  }
  buffer.push(line);
  if (buffer.length >= MAX_BUFFERED_LINES) {
    flushLogs();
  } else {
    scheduleFlush();
  }
}

// Flush any buffered lines before the process goes away so shutdown logs are
// not lost. We only hook `beforeExit`/`exit` (both fire on the normal and
// process.exit() paths) — NOT SIGINT/SIGTERM, since adding signal listeners
// would suppress default termination for CLIs that import this module. Code
// with its own shutdown path can call `appLogger.flush()` explicitly.
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("beforeExit", flushLogs);
  process.on("exit", flushLogs);
}

export const appLogger = {
  debug(message: string, attributes?: Record<string, unknown>) {
    enqueue(stdoutBuffer, formatConsoleMessage(message, attributes));
  },
  info(message: string, attributes?: Record<string, unknown>) {
    enqueue(stdoutBuffer, formatConsoleMessage(message, attributes));
  },
  warn(message: string, attributes?: Record<string, unknown>) {
    enqueue(stderrBuffer, formatConsoleMessage(message, attributes));
  },
  error(message: string, attributes?: Record<string, unknown>) {
    enqueue(stderrBuffer, formatConsoleMessage(message, attributes));
  },
  /** Flush buffered logs immediately (e.g. before a controlled shutdown). */
  flush: flushLogs,
};
