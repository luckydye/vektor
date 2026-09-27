import { config, positiveIntSetting } from "#config";

/** An append's storage writes abort past this; shorter than the claim TTL. */
export const SERIES_WRITE_DEADLINE_MS = 30_000;
/** Margin before retention may prune a window, and after a `PATCH` it waits out. */
export const SERIES_SETTLE_MS = 60_000;
/** A read or query aborts past this rather than outlive what it listed. */
export const SERIES_READ_DEADLINE_MS = 60_000;
/** Superseded objects are deleted this long after the chunk that replaced them. */
export const SERIES_SUPERSEDED_GRACE_MS = 300_000;
/** A compaction claim older than this belongs to a writer that has given up. */
export const SERIES_CLAIM_TTL_MS = 90_000;

// A chunk becomes visible up to a write deadline after its `compactedAt`, and a
// reader that listed just before must still finish before the grace ends.
if (SERIES_CLAIM_TTL_MS <= SERIES_WRITE_DEADLINE_MS) {
  throw new Error("SERIES_CLAIM_TTL_MS must exceed SERIES_WRITE_DEADLINE_MS");
}
if (SERIES_SETTLE_MS <= SERIES_WRITE_DEADLINE_MS) {
  throw new Error("SERIES_SETTLE_MS must exceed SERIES_WRITE_DEADLINE_MS");
}
if (SERIES_SUPERSEDED_GRACE_MS <= SERIES_WRITE_DEADLINE_MS + SERIES_READ_DEADLINE_MS) {
  throw new Error("SERIES_SUPERSEDED_GRACE_MS must exceed the write and read deadlines");
}

export function seriesLimits() {
  const env = config();
  return {
    windowSeconds: positiveIntSetting(
      "VEKTOR_SERIES_WINDOW_SECONDS",
      env.SERIES_WINDOW_SECONDS,
      3600,
    ),
    maxBatch: positiveIntSetting("VEKTOR_SERIES_MAX_BATCH", env.SERIES_MAX_BATCH, 1000),
    compactAfterSegments: positiveIntSetting(
      "VEKTOR_SERIES_COMPACT_AFTER_SEGMENTS",
      env.SERIES_COMPACT_AFTER_SEGMENTS,
      20,
    ),
    maxFutureMs:
      positiveIntSetting(
        "VEKTOR_SERIES_MAX_FUTURE_SECONDS",
        env.SERIES_MAX_FUTURE_SECONDS,
        300,
      ) * 1000,
    cacheBytes: positiveIntSetting(
      "VEKTOR_SERIES_CACHE_BYTES",
      env.SERIES_CACHE_BYTES,
      64 * 1024 * 1024,
    ),
    maxScanPoints: positiveIntSetting(
      "VEKTOR_SERIES_MAX_SCAN_POINTS",
      env.SERIES_MAX_SCAN_POINTS,
      5_000_000,
    ),
    maxBuckets: positiveIntSetting(
      "VEKTOR_SERIES_MAX_BUCKETS",
      env.SERIES_MAX_BUCKETS,
      10_000,
    ),
    maxGroups: positiveIntSetting(
      "VEKTOR_SERIES_MAX_GROUPS",
      env.SERIES_MAX_GROUPS,
      1000,
    ),
    maxColumnValues: positiveIntSetting(
      "VEKTOR_SERIES_MAX_COLUMN_VALUES",
      env.SERIES_MAX_COLUMN_VALUES,
      256,
    ),
  };
}

/** Rejected input: a caller error, answered with a 4xx. */
export class SeriesInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 400,
  ) {
    super(message);
    this.name = "SeriesInputError";
  }
}

/** Resolve `work`, or throw once `ms` have passed. The work itself is not cancelled. */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
