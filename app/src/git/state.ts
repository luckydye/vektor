/**
 * A repository's mutable half: refs, the packs they can name, and the log of
 * how they got there — one object, read and written whole.
 *
 * Refs and the log live together so that publishing a push is a single
 * conditional write. Split across two objects there would be a window in which
 * a ref had moved and the log had not, and nothing to close it with.
 */

import type { FileStorageAdapter } from "#files/storage.ts";

/** How many log entries a repository keeps. Older ones are dropped. */
const LOG_ENTRIES = 50;

export interface RefUpdate {
  name: string;
  /** Null when the ref is being created. */
  from: string | null;
  /** Null when the ref is being deleted. */
  to: string | null;
}

export interface LogEntry {
  seq: number;
  at: string;
  packs: string[];
  refUpdates: RefUpdate[];
}

export interface RepoState {
  version: 1;
  slug: string;
  defaultBranch: string;
  createdAt: string;
  createdBy: string;
  /** Ref name to object id. The complete set; absent means deleted. */
  refs: Record<string, string>;
  /** Base names of the live packs, without extension. */
  packs: string[];
  seq: number;
  log: LogEntry[];
}

/** A read of the state together with the tag a write back must name. */
export interface LoadedState {
  state: RepoState;
  etag: string;
}

export function repoPrefix(slug: string): string {
  return `git/${slug}`;
}

export function statePath(slug: string): string {
  return `${repoPrefix(slug)}/state.json`;
}

export function packPath(slug: string, name: string, extension: string): string {
  return `${repoPrefix(slug)}/pack/${name}.${extension}`;
}

export async function readState(
  storage: FileStorageAdapter,
  spaceId: string,
  slug: string,
): Promise<LoadedState | null> {
  const key = statePath(slug);
  const info = await storage.stat(spaceId, key);
  if (!info) return null;

  const body = await storage.read(spaceId, key);
  if (!body) return null;

  try {
    return { state: JSON.parse(body.toString()) as RepoState, etag: info.etag };
  } catch {
    return null;
  }
}

function serialize(state: RepoState): Buffer {
  return Buffer.from(JSON.stringify(state, null, 2));
}

/**
 * Create the state object, and with it the repository.
 *
 * Create-if-absent is the uniqueness constraint: two requests claiming one slug
 * race on this write, and the loser is told the name is taken. Nothing else
 * enforces it, and nothing else has to.
 */
export async function createState(
  storage: FileStorageAdapter,
  spaceId: string,
  state: RepoState,
): Promise<boolean> {
  const written = await storage.putConditional(
    spaceId,
    statePath(state.slug),
    serialize(state),
    { ifNoneMatch: true },
    "application/json",
  );
  return written.ok;
}

/** Publish a new state, but only while the stored one is still `etag`. */
export async function commitState(
  storage: FileStorageAdapter,
  spaceId: string,
  state: RepoState,
  etag: string,
): Promise<string | null> {
  const written = await storage.putConditional(
    spaceId,
    statePath(state.slug),
    serialize(state),
    { ifMatch: etag },
    "application/json",
  );
  return written.ok ? written.etag : null;
}

/** The next state after applying `refUpdates`, with the log trimmed. */
export function applyEntry(
  state: RepoState,
  packs: string[],
  refUpdates: RefUpdate[],
): RepoState {
  const refs = { ...state.refs };
  for (const update of refUpdates) {
    if (update.to === null) delete refs[update.name];
    else refs[update.name] = update.to;
  }

  const seq = state.seq + 1;
  const entry: LogEntry = { seq, at: new Date().toISOString(), packs, refUpdates };
  return {
    ...state,
    refs,
    packs: [...state.packs, ...packs],
    seq,
    log: [...state.log, entry].slice(-LOG_ENTRIES),
  };
}

/**
 * Whether `updates` can still be applied to `state`.
 *
 * Asked after a lost compare-and-swap: another push landed first, but it only
 * invalidates this one if it moved a ref this push is also moving. Pushes to
 * different branches do not conflict and must not be rejected as though they
 * did.
 */
export function conflictsWith(state: RepoState, updates: RefUpdate[]): boolean {
  return updates.some((update) => (state.refs[update.name] ?? null) !== update.from);
}
