import { PerformanceObserver } from "node:perf_hooks";
import { appLogger } from "./logger.ts";

// Lightweight always-on tracing to find what blocks the event loop in real
// sessions. Everything here only logs anomalies (over a threshold), so it is
// cheap to leave enabled. Grep the server log for "[trace]".

const EVENT_LOOP_SAMPLE_MS = 100;
const EVENT_LOOP_BLOCK_THRESHOLD_MS = 200;
const GC_PAUSE_THRESHOLD_MS = 100;
const SLOW_OP_THRESHOLD_MS = 100;

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1048576);
}
function heapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1048576);
}

let started = false;

/**
 * Starts the event-loop lag monitor and GC observer. The lag monitor schedules
 * a timer every EVENT_LOOP_SAMPLE_MS; if it fires late by more than the
 * threshold, the loop was blocked (synchronous work or a GC pause) for that
 * long — logged with memory so we can correlate blocks with growth.
 */
export function startTracing(): void {
  if (started) return;
  started = true;

  let last = performance.now();
  let lastRss = rssMB();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - EVENT_LOOP_SAMPLE_MS;
    if (lag > EVENT_LOOP_BLOCK_THRESHOLD_MS) {
      appLogger.warn("[trace] event-loop blocked", {
        lagMs: Math.round(lag),
        rssMB: rssMB(),
        heapMB: heapMB(),
      });
    }
    // Surface large allocations (they drive the GC/paging stalls). Report a jump
    // even when the loop wasn't blocked, so we see growth leading into a freeze.
    const rss = rssMB();
    if (rss - lastRss >= 150) {
      appLogger.warn("[trace] rss jump", {
        fromMB: lastRss,
        toMB: rss,
        heapMB: heapMB(),
      });
    }
    lastRss = rss;
    last = now;
  }, EVENT_LOOP_SAMPLE_MS);
  timer.unref?.();

  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= GC_PAUSE_THRESHOLD_MS) {
          appLogger.warn("[trace] gc pause", {
            ms: Math.round(entry.duration),
            kind: (entry as { detail?: { kind?: unknown } }).detail?.kind,
            rssMB: rssMB(),
          });
        }
      }
    });
    obs.observe({ entryTypes: ["gc"] });
  } catch {
    // GC entries may be unavailable on this runtime; the lag monitor still
    // captures the resulting pauses.
  }

  appLogger.info("[trace] tracing started", { rssMB: rssMB() });
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
