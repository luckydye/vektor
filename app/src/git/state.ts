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
  /** The repository document this belongs to. */
  documentId: string;
  defaultBranch: string;
  createdAt: string;
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

/**
 * Keyed on the repository document's id rather than its slug: the id survives a
 * rename, so renaming a repository is a single row update instead of copying
 * every object it owns.
 */
export function repoPrefix(documentId: string): string {
  return `git/${documentId}`;
}

export function statePath(documentId: string): string {
  return `${repoPrefix(documentId)}/state.json`;
}

export function packPath(documentId: string, name: string, extension: string): string {
  return `${repoPrefix(documentId)}/pack/${name}.${extension}`;
}

export async function readState(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
): Promise<LoadedState | null> {
  const key = statePath(documentId);
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
 * The repository's state, created empty on first sight.
 *
 * The document row already says the repository exists, so this object only ever
 * describes its contents — and creating it lazily means there is nothing to
 * race on, and no prefix left behind by a creation that half-succeeded. Two
 * concurrent first requests both try; create-if-absent settles it and the loser
 * simply reads what the winner wrote.
 */
export async function ensureState(
  storage: FileStorageAdapter,
  spaceId: string,
  documentId: string,
  defaultBranch: string,
): Promise<LoadedState | null> {
  const existing = await readState(storage, spaceId, documentId);
  if (existing) return existing;

  const state: RepoState = {
    version: 1,
    documentId,
    defaultBranch,
    createdAt: new Date().toISOString(),
    refs: {},
    packs: [],
    seq: 0,
    log: [],
  };
  const written = await storage.putConditional(
    spaceId,
    statePath(documentId),
    serialize(state),
    { ifNoneMatch: true },
    "application/json",
  );
  if (written.ok) return { state, etag: written.etag };
  return readState(storage, spaceId, documentId);
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
    statePath(state.documentId),
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
