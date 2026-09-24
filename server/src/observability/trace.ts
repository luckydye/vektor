// Lightweight timing for individual hot-path operations (yjs update/broadcast,
// document persist, etc.). Aggregated per label as count + total duration and
// exposed as labeled metrics in `#observability/metrics.ts`.

interface OpStats {
  count: number;
  totalMs: number;
}

const opStats = new Map<string, OpStats>();

function recordOp(label: string, ms: number): void {
  const existing = opStats.get(label);
  if (existing) {
    existing.count += 1;
    existing.totalMs += ms;
  } else {
    opStats.set(label, { count: 1, totalMs: ms });
  }
}

/** Snapshot of per-label operation timing, for `/metrics`. */
export function getOpStats(): Array<{ label: string; count: number; totalMs: number }> {
  return Array.from(opStats.entries(), ([label, stats]) => ({ label, ...stats }));
}

/** Times an async operation and records it under `label`. */
export async function traced<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordOp(label, performance.now() - start);
  }
}

/** Times a synchronous operation and records it under `label`. */
export function tracedSync<T>(label: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordOp(label, performance.now() - start);
  }
}
