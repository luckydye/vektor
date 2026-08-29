/**
 * The on-disk half: a normal bare repository, driven by stock git, holding
 * nothing that is not derivable from the repository's prefix in storage.
 *
 * It is a cache in the strict sense — deleting it loses nothing — which is what
 * lets object storage be the source of truth without reimplementing git.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "#config";
import type { FileStorageAdapter } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { git } from "./run.ts";
import { ensureState, type LoadedState, packPath } from "./state.ts";

/** Which stored state a cache directory was built from. */
const MARKER = ".vektor-state";

/** Resolved per call rather than at import, so `DATA_DIR` is read after config. */
export function cacheRoot(): string {
  return join(resolve(config().DATA_DIR?.trim() || "data"), "git-cache");
}

export function cachePath(spaceId: string, documentId: string): string {
  return join(cacheRoot(), spaceId, `${documentId}.git`);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `work` with no other repository operation interleaved.
 *
 * Per process, which is the scope that matters: git's own locking covers a ref
 * update, but not the read-modify-publish sequence a push wraps around it.
 */
export function withRepoLock<T>(
  spaceId: string,
  documentId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${spaceId}/${documentId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  locks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next as Promise<T>;
}

async function initBare(dir: string, defaultBranch: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet", "--bare", `--initial-branch=${defaultBranch}`]);
  // Every push must land as a packfile: loose objects would be thousands of
  // tiny mutable-looking keys instead of one immutable blob.
  await git(dir, ["config", "receive.unpackLimit", "0"]);
  // A third file per pack that nothing here reads, and that git regenerates on
  // demand — not worth storing or hydrating.
  await git(dir, ["config", "pack.writeReverseIndex", "false"]);
  await git(dir, ["config", "gc.auto", "0"]);
}

export async function localPackNames(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, "objects", "pack")).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.endsWith(".pack"))
    .map((entry) => entry.slice(0, -".pack".length));
}

async function downloadPack(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  dir: string,
  name: string,
): Promise<void> {
  for (const extension of ["pack", "idx"]) {
    const body = await storage.read(spaceId, packPath(documentId, name, extension));
    if (!body) throw new Error(`Missing ${name}.${extension} for ${documentId}`);
    await writeFile(join(dir, "objects", "pack", `${name}.${extension}`), body);
  }
}

/**
 * Write the refs and HEAD the stored state names.
 *
 * `packed-refs` in one write rather than a process per ref: hydration is on the
 * request path, and a repository with a thousand tags would otherwise pay for a
 * thousand `update-ref` spawns.
 */
async function writeRefs(dir: string, loaded: LoadedState): Promise<void> {
  const lines = Object.entries(loaded.state.refs).map(([name, oid]) => `${oid} ${name}`);
  await writeFile(
    join(dir, "packed-refs"),
    `${["# pack-refs with: peeled", ...lines].join("\n")}\n`,
  );
  // Loose refs shadow packed ones, so a ref deleted upstream would survive.
  await rm(join(dir, "refs", "heads"), { recursive: true, force: true });
  await rm(join(dir, "refs", "tags"), { recursive: true, force: true });
  await mkdir(join(dir, "refs", "heads"), { recursive: true });
  await writeFile(join(dir, "HEAD"), `ref: refs/heads/${loaded.state.defaultBranch}\n`);
}

/**
 * A cache directory holding exactly what `state.json` currently says, creating
 * or re-syncing it as needed.
 *
 * The marker records which version of the state the directory was built from,
 * so a push that landed on another node is noticed by comparing one entity tag
 * rather than by trusting local disk.
 */
export async function ensureCache(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
): Promise<{ dir: string; loaded: LoadedState } | null> {
  // Created on first sight rather than when the document is: the row already
  // says the repository exists, so there is nothing to race and no prefix left
  // behind by a creation that half-succeeded.
  const loaded = await ensureState(storage, spaceId, documentId, defaultBranch);
  if (!loaded) return null;

  const dir = cachePath(spaceId, documentId);
  const marker = await readFile(join(dir, MARKER), "utf8").catch(() => null);
  if (marker === loaded.etag) return { dir, loaded };

  if (marker === null) {
    await rm(dir, { recursive: true, force: true });
    await initBare(dir, loaded.state.defaultBranch);
  }

  const present = new Set(await localPackNames(dir));
  for (const name of loaded.state.packs) {
    if (present.has(name)) continue;
    await downloadPack(storage, spaceId, documentId, dir, name);
  }

  await writeRefs(dir, loaded);
  await writeFile(join(dir, MARKER), loaded.etag);
  return { dir, loaded };
}

/** Record which state the cache now matches, after a push published a new one. */
export async function markCache(dir: string, etag: string): Promise<void> {
  await writeFile(join(dir, MARKER), etag);
}

/**
 * Drop the cache, forcing the next request to rebuild from storage.
 *
 * Used when local disk and the published state have diverged — after a push
 * whose refs could not be published, the cache is the only copy of a ref update
 * nobody accepted.
 */
export async function invalidateCache(
  spaceId: string,
  documentId: string,
): Promise<void> {
  await rm(cachePath(spaceId, documentId), { recursive: true, force: true }).catch(
    (error) => {
      appLogger.warn("Failed to drop git cache", {
        spaceId,
        documentId,
        error: String(error),
      });
    },
  );
}
