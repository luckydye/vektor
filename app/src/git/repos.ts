/**
 * Repositories as they are named and listed.
 *
 * A repository is its prefix in storage and nothing else: no row identifies it,
 * and the slug in the URL is the prefix, so resolving one costs a single read
 * rather than a lookup.
 */

import type { FileStorageAdapter } from "#files/storage.ts";
import { appLogger } from "#observability/logger.ts";
import { invalidateCache } from "./cache.ts";
import { createState, type RepoState, readState, repoPrefix } from "./state.ts";

/**
 * Slugs are path segments, prefixes and directory names at once, so they are
 * held to what is safe in all three rather than to what any one would allow.
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug) && !slug.includes("..");
}

export interface CreateRepoOptions {
  slug: string;
  defaultBranch?: string;
  createdBy: string;
}

/** Creates the repository, or null when the slug is already taken. */
export async function createRepo(
  storage: FileStorageAdapter,
  spaceId: string,
  options: CreateRepoOptions,
): Promise<RepoState | null> {
  const state: RepoState = {
    version: 1,
    slug: options.slug,
    defaultBranch: options.defaultBranch ?? "main",
    createdAt: new Date().toISOString(),
    createdBy: options.createdBy,
    refs: {},
    packs: [],
    seq: 0,
    log: [],
  };
  return (await createState(storage, spaceId, state)) ? state : null;
}

export async function getRepo(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
): Promise<RepoState | null> {
  if (!isValidSlug(slug)) return null;
  return (await readState(storage, spaceId, slug))?.state ?? null;
}

/**
 * Every repository in the space, found by listing the one object each of them
 * is guaranteed to have.
 */
export async function listRepos(
  storage: FileStorageAdapter,
  spaceId: string,
): Promise<RepoState[]> {
  const slugs = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await storage.list(spaceId, { prefix: "git/", cursor });
    for (const file of page.files) {
      const [, slug, tail] = file.key.split("/");
      if (slug && tail === "state.json") slugs.add(slug);
    }
    cursor = page.cursor;
  } while (cursor);

  const repos: RepoState[] = [];
  for (const slug of slugs) {
    const state = await getRepo(storage, spaceId, slug);
    if (state) repos.push(state);
  }
  return repos.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Remove a repository and everything it owns.
 *
 * Through the storage adapter rather than by touching the cache directory: the
 * cache is a copy, and deleting only that would leave every object behind in
 * the bucket with nothing failing to say so.
 */
export async function deleteRepo(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  if (!(await getRepo(storage, spaceId, slug))) return false;

  const prefix = `${repoPrefix(slug)}/`;
  let cursor: string | undefined;
  do {
    const page = await storage.list(spaceId, { prefix, cursor });
    for (const file of page.files) {
      await storage.delete(spaceId, file.key);
    }
    cursor = page.cursor;
  } while (cursor);

  await invalidateCache(spaceId, slug);
  appLogger.info("Deleted repository", { spaceId, slug });
  return true;
}
