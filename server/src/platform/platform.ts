/**
 * Everything that differs between deployment targets, behind one interface per
 * concern. Each entry point creates one and passes it down; nothing reads it from module scope.
 */

import type { ApiRoute } from "#api/routes.ts";
import type { Database, DatabaseCredentials } from "#db/client/connection.ts";
import type { PlatformState } from "#db/client/db.ts";
import type { BlobStore } from "#files/storage.ts";
import type { Capabilities } from "#jobs/runtime/capabilities.ts";
import type { EmailMessage } from "#notifications/email.ts";
import type { SafeFetch } from "#utils/ssrf.ts";

/** The database holding users, sessions and the space index. */
export interface GlobalDatabase {
  open(): Database;
}

/**
 * Connections to space databases, by the driver URL a `space_index` location
 * resolves to. The file operations only ever see locations that name a file.
 */
export interface SpaceDatabase {
  open(url: string, credentials: DatabaseCredentials): Database;
  close(database: Database): void;
  exists(filePath: string): boolean;
  /** The database files in `directory`, which is created when missing. */
  listFiles(directory: string): string[];
  /** Move a database file and drop its journal; false when there was no file. */
  archive(filePath: string, archivePath: string): boolean;
  /** Delete a database file and its journal. */
  remove(filePath: string): void;
}

/** Storage for job cache entries, held under a budget by evicting the least recently read. */
export interface JobCacheStore {
  /** The entry, or null when missing. Reading is what marks it recently used. */
  read(scope: string, key: string): Promise<Buffer | null>;
  write(scope: string, key: string, entry: Buffer): Promise<void>;
  delete(scope: string, key: string): Promise<void>;
}

export interface ImageTransformOptions {
  /** Target box in px, 0 for unconstrained; never enlarges. */
  w: number;
  h: number;
  /** "webp" | "jpeg" | "png", or "" to keep the input format. */
  format: string;
  quality: number;
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
}

/** Throws when an image cannot be decoded. */
export interface ImageTransformer {
  /** Null when this host has no image support, so the original is served as is. */
  transform(input: Buffer, options: ImageTransformOptions): Promise<Buffer | null>;
  /** Throws when this host has no image support. */
  metadata(input: Buffer): Promise<ImageMetadata>;
}

export interface Embedder {
  /** Stored beside every vector, so a model change is detected as stale. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VmEvent {
  type: "log" | "call" | "done" | "error";
  callId?: string;
  name?: string;
  args?: unknown[];
  message?: string;
  output?: unknown;
}

/** One loaded VM runtime; the semantics are those of `native/exec/index.d.ts`. */
export interface JobVmRuntime {
  create(
    prelude: string,
    code: string,
    inputs: Record<string, unknown>,
    options: { timeoutMs?: number },
    onEvent: (event: VmEvent) => void,
  ): number;
  resolve(id: number, callId: string, value: unknown): void;
  reject(id: number, callId: string, message: string): void;
  touch(id: number): void;
  destroy(id: number): void;
}

export interface JobVm {
  load(): Promise<JobVmRuntime>;
  /** Capabilities the host itself backs: the scratch directory and `exec`. */
  hostCapabilities(signal?: AbortSignal): Capabilities;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface Mailer {
  /** Whether outgoing mail is configured on this host. */
  available(): boolean;
  send(message: EmailMessage): Promise<void>;
}

/** Where spaces live: one process hosting all of them, or one Durable Object each. */
export interface SpaceHost {
  /** The spaces background work runs for. */
  spaceIds(): Promise<string[]>;
  /** Run `task` every `intervalMs` without keeping the host alive; returns what stops it. */
  every(intervalMs: number, task: () => void): () => void;
}

/** Git over HTTP and the repository views, which need a git binary and local disk. */
export interface GitHost {
  routes: ApiRoute[];
  /** Drop whatever local copy of a deleted repository the host keeps. */
  forget(spaceId: string, documentId: string): Promise<void>;
}

export interface LocalJobFile {
  name: string;
  data: Buffer;
}

export interface Platform {
  globalDatabase: GlobalDatabase;
  spaceDatabase: SpaceDatabase;
  /** Uploads and everything else a space stores by key. */
  blobStore: BlobStore;
  /** Transformed image variants, derivable from the uploads and safe to lose. */
  transformCache: BlobStore;
  jobCache: JobCacheStore;
  imageTransformer: ImageTransformer;
  embedder: Embedder;
  jobVm: JobVm;
  passwordHasher: PasswordHasher;
  mailer: Mailer;
  spaceHost: SpaceHost;
  /** `fetch` for caller-influenced URLs, refusing private targets on every redirect hop. */
  fetch: SafeFetch;
  /** Null where the target cannot run git. */
  git: GitHost | null;
  /** Job bundles an operator dropped next to the server, served as a system extension. */
  localJobFiles(): LocalJobFile[];
  /** Connections and caches shared code keeps for this process, created by `createPlatformState`. */
  state: PlatformState;
}
