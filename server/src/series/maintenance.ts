/**
 * Compaction, collection of superseded objects, and retention. Compaction is
 * single-writer per series and never deletes inline.
 */

import type { SpaceStore } from "#db/client/store.ts";
import type { SeriesRow } from "#db/schema/space.ts";
import { getFileStorage, listAllFiles } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import {
  advanceOldestWindow,
  claimCompaction,
  dirtySegmentCount,
  forgetDirtyWindows,
  listDirtyWindows,
  listSeries,
  releaseCompaction,
  settleDirtyWindow,
} from "./catalog.ts";
import { compareStoredPoints, encodeObject } from "./format.ts";
import {
  SERIES_CLAIM_TTL_MS,
  SERIES_SETTLE_MS,
  SERIES_SUPERSEDED_GRACE_MS,
  SERIES_WRITE_DEADLINE_MS,
  seriesLimits,
  withDeadline,
} from "./limits.ts";
import {
  chunkKey,
  forgetListing,
  isChunk,
  listWindow,
  objectName,
  objectStamp,
  readHeader,
  readObject,
  resolveWindow,
  windowMs,
  windowPrefix,
} from "./store.ts";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Windows one prune pass may delete per series; the rest wait for the next. */
const PRUNE_WINDOWS_PER_PASS = 1000;
const lastPruneAt = new Map<string, number>();

/** Run `work` under the series' compaction claim; false when someone else holds it. */
async function withClaim(
  store: SpaceStore,
  seriesId: string,
  work: (claimedAt: number) => Promise<void>,
): Promise<boolean> {
  const claimedAt = await claimCompaction(store, seriesId);
  if (claimedAt === null) return false;
  try {
    await work(claimedAt);
  } finally {
    await releaseCompaction(store, seriesId, claimedAt);
  }
  return true;
}

/**
 * Fold the window's live objects into one new chunk. The watermark only moves
 * forward, so a segment that lands behind an earlier chunk still gets a new key.
 */
export async function compactWindow(
  store: SpaceStore,
  row: SeriesRow,
  window: number,
): Promise<boolean> {
  const { spaceId } = store;
  return withClaim(store, row.id, async (claimedAt) => {
    const absorbed = await dirtySegmentCount(store, row.id, window);
    const listed = await listWindow(spaceId, row.id, window, true);
    const resolved = await resolveWindow(spaceId, listed);
    const segments = resolved.keys.filter((key) => key !== resolved.chunk?.key);
    if (segments.length === 0) {
      await settleDirtyWindow(store, row.id, window, absorbed, undefined);
      return;
    }

    const objects = await Promise.all(
      resolved.keys.map((key) => readObject(spaceId, key)),
    );
    const points = objects.flatMap((object) => object.points).sort(compareStoredPoints);
    // Names of collected segments are dropped: a name matters only while listed.
    const listedNames = new Set(listed.map(objectName));
    const subsumes = [
      ...(resolved.chunk?.header.subsumes ?? []).filter((name) => listedNames.has(name)),
      ...segments.map(objectName),
    ].sort();
    const previous = resolved.chunk ? objectStamp(objectName(resolved.chunk.key)) : -1;
    const watermark = Math.max(
      previous + 1,
      ...segments.map((key) => objectStamp(objectName(key))),
    );

    // Past this, the claim may expire before the write's deadline does.
    if (Date.now() - claimedAt > SERIES_CLAIM_TTL_MS - SERIES_WRITE_DEADLINE_MS) {
      throw new Error("Series compaction ran out of claim before writing");
    }
    const compactedAt = Date.now();
    const buffer = await encodeObject(
      { series: row.id, name: row.name, window, subsumes, compactedAt },
      points,
      seriesLimits().maxColumnValues,
    );
    const written = await withDeadline(
      getFileStorage().putConditional(
        spaceId,
        chunkKey(row.id, window, watermark),
        buffer,
        { ifNoneMatch: true },
      ),
      SERIES_WRITE_DEADLINE_MS,
      "Series compaction",
    );
    forgetListing(spaceId, row.id, window);
    if (!written.ok) return;
    await settleDirtyWindow(
      store,
      row.id,
      window,
      absorbed,
      compactedAt + SERIES_SUPERSEDED_GRACE_MS,
    );
  });
}

/**
 * Delete what the newest chunk past its grace superseded: older chunks and the
 * segments it names. A newer chunk defers only its own share of the work.
 */
export async function collectWindow(
  store: SpaceStore,
  row: SeriesRow,
  window: number,
): Promise<boolean> {
  const { spaceId } = store;
  return withClaim(store, row.id, async () => {
    const keys = await listWindow(spaceId, row.id, window, true);
    const chunks = keys.filter(isChunk);
    const now = Date.now();
    let nextCollectAt: number | null = null;
    for (let index = chunks.length - 1; index >= 0; index--) {
      const header = await readHeader(spaceId, chunks[index]);
      const collectAt = (header.compactedAt as number) + SERIES_SUPERSEDED_GRACE_MS;
      if (collectAt > now) {
        nextCollectAt = collectAt;
        continue;
      }
      const subsumed = new Set(header.subsumes);
      const superseded = [
        ...chunks.slice(0, index),
        ...keys.filter((key) => !isChunk(key) && subsumed.has(objectName(key))),
      ];
      const storage = getFileStorage();
      for (const key of superseded) await storage.delete(spaceId, key);
      forgetListing(spaceId, row.id, window);
      break;
    }
    await settleDirtyWindow(store, row.id, window, 0, nextCollectAt);
  });
}

/** Delete windows past retention, oldest first, and move where pruning starts. */
export async function pruneSeries(
  store: SpaceStore,
  row: SeriesRow,
  now: number,
): Promise<void> {
  if (row.retentionDays === null || row.oldestWindow === null) return;
  // A retention change waits out the margin, so an append bounded by the old
  // value cannot land in a window being pruned under the new one.
  if (row.updatedAt.getTime() > now - SERIES_SETTLE_MS) return;
  const horizon = now - row.retentionDays * 86_400_000 - SERIES_SETTLE_MS;
  const storage = getFileStorage();
  let window = row.oldestWindow;
  for (
    let pass = 0;
    pass < PRUNE_WINDOWS_PER_PASS && window + windowMs(row) <= horizon;
    pass++
  ) {
    const prefix = windowPrefix(row.id, window);
    for (const file of await listAllFiles(storage, store.spaceId, { prefix })) {
      await storage.delete(store.spaceId, file.key);
    }
    forgetListing(store.spaceId, row.id, window);
    window += windowMs(row);
  }
  if (window === row.oldestWindow) return;
  await forgetDirtyWindows(store, row.id, window);
  await advanceOldestWindow(store, row.id, window);
}

function isCompactable(
  row: SeriesRow,
  window: number,
  segments: number,
  now: number,
): boolean {
  if (segments <= 0) return false;
  const closed = window + windowMs(row) + SERIES_SETTLE_MS <= now;
  return closed || segments >= row.compactAfterSegments;
}

/** One maintenance pass over a space: compact, collect, and hourly prune. */
export async function maintainSpaceSeries(store: SpaceStore, now: Date): Promise<void> {
  const at = now.getTime();
  for (const dirty of await listDirtyWindows(store)) {
    try {
      if (dirty.collectAt !== null && dirty.collectAt <= at) {
        await collectWindow(store, dirty.series, dirty.window);
      }
      if (isCompactable(dirty.series, dirty.window, dirty.segments, at)) {
        await compactWindow(store, dirty.series, dirty.window);
      }
    } catch (error) {
      appLogger.error("Series maintenance failed", {
        spaceId: store.spaceId,
        series: dirty.series.name,
        window: dirty.window,
        error,
      });
    }
  }

  if (at - (lastPruneAt.get(store.spaceId) ?? 0) < PRUNE_INTERVAL_MS) return;
  lastPruneAt.set(store.spaceId, at);
  for (const row of await listSeries(store)) {
    try {
      await pruneSeries(store, row, at);
    } catch (error) {
      appLogger.error("Series prune failed", {
        spaceId: store.spaceId,
        series: row.name,
        error,
      });
    }
  }
}
