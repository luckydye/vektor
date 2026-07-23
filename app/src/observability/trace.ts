import { appLogger } from "./logger.ts";

// Lightweight tracing for slow individual operations. Event-loop delay, GC
// pauses, and RSS are tracked as gauges in `#observability/metrics.ts`
// instead of being logged here. Grep the server log for "[trace]".

const SLOW_OP_THRESHOLD_MS = 100;

const sampleRss: () => number =
  typeof process.memoryUsage.rss === "function"
    ? () => process.memoryUsage.rss()
    : () => process.memoryUsage().rss;

function rssMB(): number {
  return Math.round(sampleRss() / 1048576);
}

/** Times an async operation and logs it when it exceeds the slow threshold. */
export async function traced<T>(
  label: string,
  fn: () => Promise<T>,
  extra?: Record<string, unknown>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    if (ms >= SLOW_OP_THRESHOLD_MS) {
      appLogger.warn("[trace] slow op", {
        label,
        ms: Math.round(ms),
        rssMB: rssMB(),
        ...extra,
      });
    }
  }
}

/** Times a synchronous operation and logs it when it exceeds the slow threshold. */
export function tracedSync<T>(
  label: string,
  fn: () => T,
  extra?: Record<string, unknown>,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - start;
    if (ms >= SLOW_OP_THRESHOLD_MS) {
      appLogger.warn("[trace] slow op", {
        label,
        ms: Math.round(ms),
        rssMB: rssMB(),
        ...extra,
      });
    }
  }
}
