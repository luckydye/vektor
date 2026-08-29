/**
 * Reading a repository for the browser: the tree, a file, the log.
 *
 * All of it is git's own plumbing over the warm cache — `ls-tree`, `cat-file`,
 * `log` — because a browser showing something other than what a clone would
 * hand you is worse than no browser at all.
 */

import type { FileStorageAdapter } from "#files/storage.ts";
import { ensureCache } from "./cache.ts";
import { git } from "./run.ts";

/** Field separator for `--format`; a byte no ref, path or subject contains. */
const UNIT = "\x1f";

export interface TreeEntry {
  name: string;
  path: string;
  type: "blob" | "tree";
  size: number | null;
}

export interface Commit {
  oid: string;
  shortOid: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface RepositoryOverview {
  empty: boolean;
  /** The branch a browse defaults to, which may not be the configured one. */
  branch: string;
  branches: string[];
  head: Commit | null;
}

/**
 * A rev reaches a command line, so it is held to what a branch, tag or object
 * id can look like — and never allowed to open with `-`, which git would read
 * as an option rather than a revision.
 */
export function isSafeRev(rev: string): boolean {
  return /^[A-Za-z0-9][\w./-]{0,254}$/.test(rev) && !rev.includes("..");
}

/** Paths are held to the same standard, and must stay inside the tree. */
export function isSafePath(path: string): boolean {
  if (path === "") return true;
  if (path.length > 1024) return false;
  if (path.startsWith("/") || path.startsWith("-") || path.includes("..")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a path carrying one is not a path
  return !/[\x00-\x1f]/.test(path);
}

/**
 * The cache, materialized and current. Every read goes through here, so a
 * browse of a cold repository pays the same hydration a clone would.
 */
async function repoDir(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
): Promise<string | null> {
  const cache = await ensureCache(storage, spaceId, documentId, defaultBranch);
  return cache?.dir ?? null;
}

export async function log(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
  rev: string,
  limit: number,
): Promise<Commit[]> {
  const dir = await repoDir(storage, spaceId, documentId, defaultBranch);
  if (!dir) return [];

  const output = await git(dir, [
    "log",
    `--max-count=${limit}`,
    `--format=%H${UNIT}%h${UNIT}%s${UNIT}%an${UNIT}%aI`,
    rev,
    "--",
  ]).catch(() => null);
  if (output === null) return [];

  const commits: Commit[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [oid, shortOid, subject, author, authoredAt] = line.split(UNIT);
    commits.push({ oid, shortOid, subject, author, authoredAt });
  }
  return commits;
}

/**
 * What the repository is, before anything is browsed.
 *
 * Branches come from the stored state rather than from git, so an empty
 * repository answers without materializing a cache at all.
 */
export async function overview(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
): Promise<RepositoryOverview | null> {
  const cache = await ensureCache(storage, spaceId, documentId, defaultBranch);
  if (!cache) return null;

  const branches = Object.keys(cache.loaded.state.refs)
    .filter((name) => name.startsWith("refs/heads/"))
    .map((name) => name.slice("refs/heads/".length))
    .sort();

  if (branches.length === 0) {
    return { empty: true, branch: defaultBranch, branches: [], head: null };
  }

  const branch = branches.includes(defaultBranch) ? defaultBranch : branches[0];
  const [head] = await log(storage, spaceId, documentId, defaultBranch, branch, 1);
  return { empty: false, branch, branches, head: head ?? null };
}

export async function tree(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
  rev: string,
  path: string,
): Promise<TreeEntry[] | null> {
  const dir = await repoDir(storage, spaceId, documentId, defaultBranch);
  if (!dir) return null;

  // `--` separates revisions from paths, so a path can never be read as one.
  // No `--long`: it carries the size on its own and git refuses both at once.
  const output = await git(dir, [
    "ls-tree",
    `--format=%(objecttype)${UNIT}%(objectsize)${UNIT}%(path)`,
    rev,
    "--",
    ...(path === "" ? [] : [`${path.replace(/\/$/, "")}/`]),
  ]).catch(() => null);
  if (output === null) return null;

  const entries: TreeEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [type, size, entryPath] = line.split(UNIT);
    if (type !== "blob" && type !== "tree") continue;
    entries.push({
      name: entryPath.split("/").pop() ?? entryPath,
      path: entryPath,
      type,
      size: type === "blob" ? Number(size) : null,
    });
  }
  // Directories first, then by name — the order every file browser uses.
  return entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1,
  );
}

export interface Blob {
  /** Null when the bytes are not text; the browser offers a clone instead. */
  text: string | null;
  size: number;
}

/** How much of a file the browser will render before giving up on it. */
const MAX_BLOB_BYTES = 1024 * 1024;

export async function blob(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
  rev: string,
  path: string,
): Promise<Blob | null> {
  const dir = await repoDir(storage, spaceId, documentId, defaultBranch);
  if (!dir) return null;

  const reported = await git(dir, ["cat-file", "-s", `${rev}:${path}`]).catch(() => null);
  if (reported === null) return null;
  const size = Number(reported.trim());
  if (!Number.isFinite(size)) return null;
  if (size > MAX_BLOB_BYTES) return { text: null, size };

  const content = await git(dir, ["cat-file", "blob", `${rev}:${path}`]).catch(
    () => null,
  );
  if (content === null) return null;
  // A NUL byte is git's own test for "binary", and the one that matters here:
  // it is what cannot be shown as text.
  return { text: content.includes("\0") ? null : content, size };
}
