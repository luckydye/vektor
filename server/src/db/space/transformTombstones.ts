import { asc, eq } from "drizzle-orm";
import { isActiveSpace } from "#db/auth/spaceIndex.ts";
import { one } from "#db/client/query.ts";
import {
  openSpaceStore,
  type SpaceStore,
  wakeSpaceAfterCommit,
} from "#db/client/store.ts";
import { file as fileTable, transformTombstone } from "#db/schema/space.ts";
import { deleteTransformVariants } from "#files/transforms.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import type { SpaceWork } from "#platform/spaceWork.ts";

/**
 * How long a tombstone stays after its first purge. A transform that was
 * already running when the delete landed can write its variant afterwards, so
 * the second pass purges again before the tombstone is dropped.
 */
const PURGE_GRACE_MS = 60_000;

/** Queue the cache half of an upload delete; the request path does no listing. */
export async function tombstoneUpload(
  store: SpaceStore,
  path: string,
): Promise<void> {
  await store.db
    .insert(transformTombstone)
    .values({ path, createdAt: new Date() })
    .onConflictDoNothing();
  wakeSpaceAfterCommit(store);
}

/** Whether a delete is queued for this upload path. */
export async function isUploadTombstoned(
  platform: Platform,
  spaceId: string,
  path: string,
): Promise<boolean> {
  if (!(await isActiveSpace(platform, spaceId))) return false;
  const store = await openSpaceStore(platform, spaceId);
  const row = await one(
    store.db
      .select({ path: transformTombstone.path })
      .from(transformTombstone)
      .where(eq(transformTombstone.path, path)),
  );
  return row !== undefined;
}

/**
 * Remove every cached transform variant for each due tombstone.
 *
 * The original upload is deleted on the request path, so only the derived
 * variants are left. A file row that exists again means the same
 * content-addressed key was re-uploaded while the delete was queued; the bytes
 * are live again and the tombstone is simply discarded.
 */
async function purgeTombstones(store: SpaceStore, now: Date): Promise<void> {
  const rows = await store.db
    .select()
    .from(transformTombstone)
    .orderBy(asc(transformTombstone.createdAt));

  for (const row of rows) {
    const live = await one(
      store.db
        .select({ path: fileTable.path })
        .from(fileTable)
        .where(eq(fileTable.path, row.path)),
    );
    if (live) {
      await store.db
        .delete(transformTombstone)
        .where(eq(transformTombstone.path, row.path));
      continue;
    }

    // The first pass runs at once; the confirming pass waits out the grace.
    if (row.purgedAt && row.purgedAt.getTime() + PURGE_GRACE_MS > now.getTime()) {
      continue;
    }

    try {
      await deleteTransformVariants(store.platform, store.spaceId, row.path);
      if (row.purgedAt) {
        await store.db
          .delete(transformTombstone)
          .where(eq(transformTombstone.path, row.path));
      } else {
        await store.db
          .update(transformTombstone)
          .set({ purgedAt: now })
          .where(eq(transformTombstone.path, row.path));
      }
    } catch (error) {
      // Defer the retry even after a first-pass failure; the grace is the
      // retry interval, so a broken cache cannot spin the space's work loop.
      await store.db
        .update(transformTombstone)
        .set({ purgedAt: now })
        .where(eq(transformTombstone.path, row.path));
      appLogger.warn("Failed to purge a tombstoned upload", {
        error,
        spaceId: store.spaceId,
        path: row.path,
      });
    }
  }
}

export const transformTombstoneWork: SpaceWork = {
  name: "transform tombstones",
  run: purgeTombstones,
  nextAt: async (store) => {
    const rows = await store.db
      .select({ purgedAt: transformTombstone.purgedAt })
      .from(transformTombstone);
    if (rows.length === 0) return null;

    const now = Date.now();
    return new Date(
      Math.min(
        ...rows.map((row) =>
          row.purgedAt ? row.purgedAt.getTime() + PURGE_GRACE_MS : now,
        ),
      ),
    );
  },
};
