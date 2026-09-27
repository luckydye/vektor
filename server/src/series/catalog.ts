/**
 * The `series` and `series_dirty_window` tables: what a series is, its
 * compaction claim, and which windows need maintenance. Never what it contains.
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { type SeriesRow, series, seriesDirtyWindow } from "#db/schema/space.ts";
import { getFileStorage } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { SERIES_CLAIM_TTL_MS, SeriesInputError, seriesLimits } from "./limits.ts";

export const seriesKinds = ["gps", "log", "metric"] as const;
export type SeriesKind = (typeof seriesKinds)[number];

export interface SeriesDeclaration {
  name: string;
  kind: SeriesKind;
  documentId: string | null;
  windowSeconds?: number;
  retentionDays?: number | null;
  compactAfterSegments?: number;
  createdBy: string;
}

export interface SeriesPatch {
  retentionDays?: number | null;
  compactAfterSegments?: number;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export function seriesPrefix(id: string): string {
  return `series/${id}/`;
}

function assertPositiveInt(value: unknown, what: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SeriesInputError(`${what} must be a positive integer`);
  }
}

function assertPatch(patch: SeriesPatch): void {
  if (patch.retentionDays !== undefined && patch.retentionDays !== null) {
    assertPositiveInt(patch.retentionDays, "retentionDays");
  }
  if (patch.compactAfterSegments !== undefined) {
    assertPositiveInt(patch.compactAfterSegments, "compactAfterSegments");
  }
}

export async function getSeries(
  store: SpaceStore,
  name: string,
): Promise<SeriesRow | undefined> {
  return one(store.db.select().from(series).where(eq(series.name, name)));
}

/** The series named `name`; a name with no row is refused. */
export async function requireSeries(store: SpaceStore, name: string): Promise<SeriesRow> {
  const row = await getSeries(store, name);
  if (!row) throw new SeriesInputError(`Series "${name}" is not declared`, 404);
  return row;
}

export async function listSeries(store: SpaceStore): Promise<SeriesRow[]> {
  return many(store.db.select().from(series).orderBy(series.name));
}

/**
 * Declare a series, or return the existing one when it matches. A redeclaration
 * that changes what the stored layout depends on is a conflict.
 */
export async function declareSeries(
  store: SpaceStore,
  declaration: SeriesDeclaration,
): Promise<{ series: SeriesRow; created: boolean }> {
  if (!NAME_PATTERN.test(declaration.name)) {
    throw new SeriesInputError(
      "Series names are 1-128 letters, digits, ':', '.', '_' or '-', starting alphanumeric",
    );
  }
  if (!seriesKinds.includes(declaration.kind)) {
    throw new SeriesInputError(`kind must be one of ${seriesKinds.join(", ")}`);
  }
  const limits = seriesLimits();
  const windowSeconds = declaration.windowSeconds ?? limits.windowSeconds;
  assertPositiveInt(windowSeconds, "windowSeconds");
  assertPatch(declaration);

  const now = new Date();
  const inserted = await store.db
    .insert(series)
    .values({
      id: randomUUID(),
      name: declaration.name,
      kind: declaration.kind,
      documentId: declaration.documentId,
      windowSeconds,
      retentionDays: declaration.retentionDays ?? null,
      compactAfterSegments:
        declaration.compactAfterSegments ?? limits.compactAfterSegments,
      createdAt: now,
      updatedAt: now,
      createdBy: declaration.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { series: inserted[0], created: true };

  const existing = await requireSeries(store, declaration.name);
  const same =
    existing.kind === declaration.kind &&
    existing.documentId === declaration.documentId &&
    (declaration.windowSeconds === undefined ||
      existing.windowSeconds === declaration.windowSeconds);
  if (!same) {
    throw new SeriesInputError(
      `Series "${declaration.name}" exists with a different kind, document or window`,
      409,
    );
  }
  return { series: existing, created: false };
}

export async function patchSeries(
  store: SpaceStore,
  name: string,
  patch: SeriesPatch,
): Promise<SeriesRow> {
  assertPatch(patch);
  const [row] = await store.db
    .update(series)
    .set({
      ...(patch.retentionDays !== undefined && { retentionDays: patch.retentionDays }),
      ...(patch.compactAfterSegments !== undefined && {
        compactAfterSegments: patch.compactAfterSegments,
      }),
      updatedAt: new Date(),
    })
    .where(eq(series.name, name))
    .returning();
  if (!row) throw new SeriesInputError(`Series "${name}" is not declared`, 404);
  return row;
}

/** Delete every object under each series' prefix. Their rows must already be gone. */
export async function deleteSeriesObjects(spaceId: string, ids: string[]): Promise<void> {
  const storage = getFileStorage();
  for (const id of ids) {
    let cursor: string | undefined;
    do {
      const page = await storage.list(spaceId, { prefix: seriesPrefix(id), cursor });
      for (const file of page.files) await storage.delete(spaceId, file.key);
      cursor = page.cursor;
    } while (cursor);
  }
}

/** Remove the row, then its objects: nothing deletes objects because a row is missing. */
export async function deleteSeries(store: SpaceStore, name: string): Promise<boolean> {
  const [row] = await store.db
    .delete(series)
    .where(eq(series.name, name))
    .returning({ id: series.id });
  if (!row) return false;
  await deleteSeriesObjects(store.spaceId, [row.id]);
  return true;
}

export async function seriesIdsForDocument(
  store: SpaceStore,
  documentId: string,
): Promise<string[]> {
  const rows = await many(
    store.db
      .select({ id: series.id })
      .from(series)
      .where(eq(series.documentId, documentId)),
  );
  return rows.map((row) => row.id);
}

/** After a document's row is gone: its cascaded series' objects. */
export async function deleteDocumentSeriesObjects(
  spaceId: string,
  ids: string[],
): Promise<void> {
  await deleteSeriesObjects(spaceId, ids).catch((error) => {
    appLogger.warn("Failed to delete series objects", { spaceId, ids, error });
  });
}

/**
 * Account for segments that landed: they mark their windows dirty and move the
 * cosmetic totals. Called only after the objects are durable.
 */
export async function recordAppend(
  store: SpaceStore,
  seriesId: string,
  windows: number[],
  points: number,
  bytes: number,
): Promise<void> {
  for (const window of windows) {
    await store.db
      .insert(seriesDirtyWindow)
      .values({ seriesId, window, segments: 1 })
      .onConflictDoUpdate({
        target: [seriesDirtyWindow.seriesId, seriesDirtyWindow.window],
        set: { segments: sql`${seriesDirtyWindow.segments} + 1` },
      });
  }
  const oldest = Math.min(...windows);
  await store.db
    .update(series)
    .set({
      pointCount: sql`${series.pointCount} + ${points}`,
      byteCount: sql`${series.byteCount} + ${bytes}`,
      oldestWindow: sql`MIN(COALESCE(${series.oldestWindow}, ${oldest}), ${oldest})`,
    })
    .where(eq(series.id, seriesId));
}

/** Take the single-writer compaction claim, returning its stamp, or null when held. */
export async function claimCompaction(
  store: SpaceStore,
  seriesId: string,
): Promise<number | null> {
  const now = Date.now();
  const claimed = await store.db
    .update(series)
    .set({ compactingAt: now })
    .where(
      and(
        eq(series.id, seriesId),
        or(
          isNull(series.compactingAt),
          lte(series.compactingAt, now - SERIES_CLAIM_TTL_MS),
        ),
      ),
    )
    .returning({ id: series.id });
  return claimed.length > 0 ? now : null;
}

export async function releaseCompaction(
  store: SpaceStore,
  seriesId: string,
  claimedAt: number,
): Promise<void> {
  await store.db
    .update(series)
    .set({ compactingAt: null })
    .where(and(eq(series.id, seriesId), eq(series.compactingAt, claimedAt)));
}

export interface DirtyWindow {
  series: SeriesRow;
  window: number;
  segments: number;
  collectAt: number | null;
}

export async function listDirtyWindows(store: SpaceStore): Promise<DirtyWindow[]> {
  const rows = await many(
    store.db
      .select({ series, dirty: seriesDirtyWindow })
      .from(seriesDirtyWindow)
      .innerJoin(series, eq(series.id, seriesDirtyWindow.seriesId))
      .orderBy(seriesDirtyWindow.seriesId, seriesDirtyWindow.window),
  );
  return rows.map(({ series, dirty }) => ({
    series,
    window: dirty.window,
    segments: dirty.segments,
    collectAt: dirty.collectAt,
  }));
}

export async function dirtySegmentCount(
  store: SpaceStore,
  seriesId: string,
  window: number,
): Promise<number> {
  const row = await one(
    store.db
      .select({ segments: seriesDirtyWindow.segments })
      .from(seriesDirtyWindow)
      .where(
        and(
          eq(seriesDirtyWindow.seriesId, seriesId),
          eq(seriesDirtyWindow.window, window),
        ),
      ),
  );
  return row?.segments ?? 0;
}

/**
 * Subtract the segments a compaction read before listing, set when collection
 * is due (`undefined` keeps it), and drop the row once neither is pending.
 */
export async function settleDirtyWindow(
  store: SpaceStore,
  seriesId: string,
  window: number,
  absorbed: number,
  collectAt: number | null | undefined,
): Promise<void> {
  const where = and(
    eq(seriesDirtyWindow.seriesId, seriesId),
    eq(seriesDirtyWindow.window, window),
  );
  await store.db
    .update(seriesDirtyWindow)
    .set({
      segments: sql`${seriesDirtyWindow.segments} - ${absorbed}`,
      ...(collectAt !== undefined && { collectAt }),
    })
    .where(where);
  await store.db
    .delete(seriesDirtyWindow)
    .where(
      and(where, lte(seriesDirtyWindow.segments, 0), isNull(seriesDirtyWindow.collectAt)),
    );
}

export async function forgetDirtyWindows(
  store: SpaceStore,
  seriesId: string,
  beforeWindow: number,
): Promise<void> {
  await store.db
    .delete(seriesDirtyWindow)
    .where(
      and(
        eq(seriesDirtyWindow.seriesId, seriesId),
        sql`${seriesDirtyWindow.window} < ${beforeWindow}`,
      ),
    );
}

/** Move where pruning starts, never backwards. */
export async function advanceOldestWindow(
  store: SpaceStore,
  seriesId: string,
  window: number,
): Promise<void> {
  await store.db
    .update(series)
    .set({ oldestWindow: window })
    .where(and(eq(series.id, seriesId), sql`${series.oldestWindow} < ${window}`));
}
