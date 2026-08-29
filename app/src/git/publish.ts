/**
 * Publishing a push: what turns a receive-pack that touched local disk into a
 * change everyone else can see.
 *
 * The ordering is the correctness story. Packs are uploaded before any ref can
 * name them, so a reader that sees a new ref can always fetch the objects
 * behind it; the reverse order would publish references to bytes that may never
 * arrive.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStorageAdapter } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { localPackNames, markCache } from "./cache.ts";
import { git } from "./run.ts";
import {
  applyEntry,
  commitState,
  conflictsWith,
  type LoadedState,
  packPath,
  type RefUpdate,
  type RepoState,
  readState,
} from "./state.ts";

/** Packs beyond which a repository is consolidated. */
const REPACK_THRESHOLD = 12;

/** How long a superseded pack stays readable for clones already streaming it. */
const SUPERSEDED_GRACE_MS = 60_000;

/** Attempts to publish before giving up on a repository under sustained load. */
const COMMIT_ATTEMPTS = 5;

export async function readRefs(dir: string): Promise<Record<string, string>> {
  const output = await git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  const refs: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const [oid, name] = line.split(" ");
    if (oid && name) refs[name] = oid;
  }
  return refs;
}

export function diffRefs(
  before: Record<string, string>,
  after: Record<string, string>,
): RefUpdate[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const updates: RefUpdate[] = [];
  for (const name of names) {
    const from = before[name] ?? null;
    const to = after[name] ?? null;
    if (from !== to) updates.push({ name, from, to });
  }
  return updates;
}

async function uploadPacks(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
  dir: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    for (const extension of ["pack", "idx"]) {
      const body = await readFile(join(dir, "objects", "pack", `${name}.${extension}`));
      await storage.put(spaceId, packPath(slug, name, extension), body);
    }
  }
}

/**
 * Publish `refUpdates` and the packs backing them.
 *
 * Losing the compare-and-swap does not mean losing the push: another writer
 * landing first only invalidates this one if it moved a ref this push is also
 * moving. Anything else is re-applied to the state that won.
 */
async function commit(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
  loaded: LoadedState,
  packs: string[],
  refUpdates: RefUpdate[],
): Promise<{ etag: string; state: RepoState } | { conflict: true }> {
  let current = loaded;
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    if (conflictsWith(current.state, refUpdates)) return { conflict: true };

    const next = applyEntry(current.state, packs, refUpdates);
    const etag = await commitState(storage, spaceId, next, current.etag);
    if (etag) return { etag, state: next };

    const reread = await readState(storage, spaceId, slug);
    if (!reread) return { conflict: true };
    current = reread;
  }
  return { conflict: true };
}

/**
 * Consolidate a repository whose pack count has grown past the threshold.
 *
 * Cold-start cost is proportional to the number of pushes rather than the size
 * of the history, so this is part of writing, not housekeeping deferred to a
 * quiet moment.
 */
async function repack(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
  dir: string,
  loaded: LoadedState,
): Promise<LoadedState> {
  if (loaded.state.packs.length <= REPACK_THRESHOLD) return loaded;

  await git(dir, ["repack", "-a", "-d", "-q"]);
  const names = await localPackNames(dir);
  const added = names.filter((name) => !loaded.state.packs.includes(name));
  await uploadPacks(storage, spaceId, slug, dir, added);

  const superseded = loaded.state.packs.filter((name) => !names.includes(name));
  const next: RepoState = { ...loaded.state, packs: names };
  const etag = await commitState(storage, spaceId, next, loaded.etag);
  if (!etag) {
    // Someone pushed while this ran. The new pack is uploaded and unreferenced,
    // which the orphan sweep collects; the old ones stay live and correct.
    appLogger.info("Repack lost the race, leaving packs consolidated locally", { slug });
    return loaded;
  }

  // A clone that started before the commit is still reading these, so they go
  // after a grace period rather than the moment nothing new can name them.
  setTimeout(() => {
    for (const name of superseded) {
      for (const extension of ["pack", "idx"]) {
        void storage.delete(spaceId, packPath(slug, name, extension));
      }
    }
  }, SUPERSEDED_GRACE_MS).unref?.();

  await markCache(dir, etag);
  return { state: next, etag };
}

export interface PublishResult {
  published: boolean;
  refUpdates: RefUpdate[];
}

/**
 * Turn whatever receive-pack just wrote into local disk into published state.
 * Returns unpublished when a genuinely conflicting push won the race.
 */
export async function publishPush(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
  dir: string,
  loaded: LoadedState,
  before: Record<string, string>,
): Promise<PublishResult> {
  const after = await readRefs(dir);
  const refUpdates = diffRefs(before, after);
  if (refUpdates.length === 0) return { published: true, refUpdates };

  const packs = (await localPackNames(dir)).filter(
    (name) => !loaded.state.packs.includes(name),
  );
  await uploadPacks(storage, spaceId, slug, dir, packs);

  const result = await commit(storage, spaceId, slug, loaded, packs, refUpdates);
  if ("conflict" in result) return { published: false, refUpdates };

  await markCache(dir, result.etag);
  await repack(storage, spaceId, slug, dir, { state: result.state, etag: result.etag });
  return { published: true, refUpdates };
}

/**
 * Delete packs no state names any more.
 *
 * They come from a push whose objects uploaded and whose refs never published —
 * a crash, or a conflict — so nothing will ever reference them, and nothing
 * else would ever remove them.
 */
export async function sweepOrphanedPacks(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
): Promise<number> {
  const loaded = await readState(storage, spaceId, slug);
  if (!loaded) return 0;

  const live = new Set(loaded.state.packs);
  const cutoff = Date.now() - SUPERSEDED_GRACE_MS;
  let removed = 0;

  const { files } = await storage.list(spaceId, { prefix: `git/${slug}/pack/` });
  for (const file of files) {
    const name = file.key
      .split("/")
      .pop()
      ?.replace(/\.(pack|idx)$/, "");
    if (!name || live.has(name)) continue;
    if (file.updatedAt.getTime() > cutoff) continue;
    await storage.delete(spaceId, file.key);
    removed++;
  }
  return removed;
}
