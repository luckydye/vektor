/**
 * Everything a space does in the background, run as one pass whenever its host
 * wakes it. Nothing polls: each kind of work reports when it is next due.
 */

import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { workflowScheduleWork } from "#jobs/cronScheduler.ts";
import { emailNotificationWork } from "#notifications/worker.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { seriesMaintenanceWork } from "#series/maintenance.ts";

/** One kind of background work in a space. */
export interface SpaceWork {
  name: string;
  /** Do whatever is due at `now`. */
  run(store: SpaceStore, now: Date): Promise<void>;
  /** When this work is next due, or null while there is none. */
  nextAt(store: SpaceStore, now: Date): Promise<Date | null>;
}

const work: SpaceWork[] = [
  workflowScheduleWork,
  seriesMaintenanceWork,
  emailNotificationWork,
];

/** Run the space's due work; returns when the pass is next due, or null when nothing is pending. */
export async function runSpaceWork(
  platform: Platform,
  spaceId: string,
  now: Date,
): Promise<Date | null> {
  const store = await openSpaceStore(platform, spaceId);
  for (const entry of work) {
    // One failing kind of work must not starve the others; it is retried at its next due time.
    try {
      await entry.run(store, now);
    } catch (error) {
      appLogger.error("Background work failed", { spaceId, work: entry.name, error });
    }
  }

  let next: Date | null = null;
  for (const entry of work) {
    const at = await entry.nextAt(store, now);
    if (at && (!next || at < next)) next = at;
  }
  return next;
}
