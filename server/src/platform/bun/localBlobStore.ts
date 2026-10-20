import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  type BlobStore,
  type ByteRange,
  type ConditionalPutResult,
  containedKey,
  isSafeSpaceId,
  type ListOptions,
  type PutCondition,
  type StoredFileInfo,
  type StoredFileListing,
  type StoredFileStat,
  type StoredUpload,
} from "#files/storage.ts";

/**
 * A filesystem stand-in for an object store's entity tag.
 *
 * The inode is in it because mtime and size alone are not enough: two writes in
 * the same millisecond that happen to produce the same length would otherwise
 * be indistinguishable, and a conditional write would accept a stale tag.
 * {@link LocalBlobStore.putConditional} renames into place, so a new
 * version always lands on a new inode.
 */
function fileEtag(info: Stats): string {
  const parts = [info.size, Math.floor(info.mtimeMs), info.ino];
  return `"${parts.map((part) => part.toString(36)).join("-")}"`;
}

class LocalBlobStore implements BlobStore {
  readonly locks = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  /** Where a key lives, or null when it would land outside the space. */
  resolvePath(spaceId: string, key: string): string | null {
    const contained = containedKey(spaceId, key);
    return contained ? join(this.root, contained) : null;
  }

  url(spaceId: string, key: string): string {
    return `/api/v1/spaces/${spaceId}/uploads/${key}`;
  }

  async put(
    spaceId: string,
    key: string,
    buffer: Buffer,
    _contentType?: string,
  ): Promise<string> {
    const filePath = this.resolvePath(spaceId, key);
    // A write is the one caller that must not fail quietly: silently storing
    // nothing would report a URL that serves 404 forever.
    if (!filePath) throw new Error(`Refusing to write outside the space: ${key}`);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return this.url(spaceId, key);
  }

  /**
   * Emulated with a serialized check-then-rename.
   *
   * The lock is per process, which is the whole scope this adapter serves: a
   * local filesystem backs one node, and two of them sharing a directory is not
   * a supported deployment. Create-if-absent needs no lock at all — `wx` is
   * atomic in the kernel.
   */
  async putConditional(
    spaceId: string,
    key: string,
    buffer: Buffer,
    condition: PutCondition,
    _contentType?: string,
  ): Promise<ConditionalPutResult> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) throw new Error(`Refusing to write outside the space: ${key}`);
    await mkdir(dirname(filePath), { recursive: true });

    if ("ifNoneMatch" in condition) {
      try {
        const handle = await open(filePath, "wx");
        try {
          await handle.write(buffer);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false };
        throw error;
      }
      const written = await this.stat(spaceId, key);
      return written ? { ok: true, etag: written.etag } : { ok: false };
    }

    return this.serialize(filePath, async () => {
      const current = await this.stat(spaceId, key);
      if (!current || current.etag !== condition.ifMatch) return { ok: false };

      // Renamed rather than overwritten so the new version lands on its own
      // inode, which is what makes the entity tag change every time.
      const stagingPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
      try {
        await writeFile(stagingPath, buffer);
        await rename(stagingPath, filePath);
      } catch (error) {
        await unlink(stagingPath).catch(() => {});
        throw error;
      }

      const written = await this.stat(spaceId, key);
      return written ? { ok: true, etag: written.etag } : { ok: false };
    });
  }

  /** Run `work` with no other conditional write to `filePath` interleaved. */
  serialize<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(filePath) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      filePath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async putHashed(
    spaceId: string,
    extension: string,
    body: ReadableStream<Uint8Array>,
    _contentType?: string,
  ): Promise<StoredUpload> {
    const stagingPath = join(this.root, spaceId, ".staging", randomUUID());
    await mkdir(dirname(stagingPath), { recursive: true });

    const hash = createHash("sha256");
    let size = 0;
    try {
      const handle = await open(stagingPath, "w");
      try {
        for await (const chunk of body) {
          hash.update(chunk);
          size += chunk.byteLength;
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }

      const digest = hash.digest("hex");
      const key = `${digest.slice(0, 2)}/${digest}.${extension}`;
      const filePath = this.resolvePath(spaceId, key);
      // The digest cannot escape the space, so only a hostile `extension` could
      // — and a write that would land outside must fail rather than report a
      // URL for bytes nobody can serve.
      if (!filePath) throw new Error(`Refusing to write outside the space: ${key}`);
      await mkdir(dirname(filePath), { recursive: true });
      await rename(stagingPath, filePath);
      return { key, url: this.url(spaceId, key), size };
    } catch (error) {
      await unlink(stagingPath).catch(() => {});
      throw error;
    }
  }

  async putStream(
    spaceId: string,
    key: string,
    body: ReadableStream<Uint8Array>,
    _contentType?: string,
  ): Promise<void> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) throw new Error(`Refusing to write outside the space: ${key}`);
    const stagingPath = join(this.root, spaceId, ".staging", randomUUID());
    await mkdir(dirname(stagingPath), { recursive: true });
    try {
      const handle = await open(stagingPath, "w");
      try {
        for await (const chunk of body) await handle.write(chunk);
      } finally {
        await handle.close();
      }
      await mkdir(dirname(filePath), { recursive: true });
      await rename(stagingPath, filePath);
    } catch (error) {
      await unlink(stagingPath).catch(() => {});
      throw error;
    }
  }

  async read(spaceId: string, key: string): Promise<Buffer | null> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return null;
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  async stat(spaceId: string, key: string): Promise<StoredFileStat | null> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return null;
    try {
      const info = await stat(filePath);
      // A directory is not a stored object, and answering with its size would
      // send a caller on to request bytes that do not exist.
      if (!info.isFile()) return null;
      return { size: info.size, updatedAt: info.mtime, etag: fileEtag(info) };
    } catch {
      return null;
    }
  }

  async readStream(
    spaceId: string,
    key: string,
    range?: ByteRange,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return null;
    // `createReadStream` does not reject a missing file — it emits on the
    // stream, which by then is already the response body. Ask first.
    if (!(await this.stat(spaceId, key))) return null;
    const stream = range
      ? createReadStream(filePath, { start: range.start, end: range.end })
      : createReadStream(filePath);
    return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  }

  async delete(spaceId: string, key: string): Promise<void> {
    const filePath = this.resolvePath(spaceId, key);
    if (!filePath) return;
    await unlink(filePath).catch(() => {});
  }

  async deleteAll(spaceId: string): Promise<void> {
    if (!isSafeSpaceId(spaceId)) return;
    await rm(join(this.root, spaceId), { recursive: true, force: true });
  }

  async list(spaceId: string, options: ListOptions = {}): Promise<StoredFileListing> {
    const spaceRoot = containedKey(spaceId, options.prefix ?? ".");
    if (spaceRoot === null && options.prefix !== undefined) {
      return { files: [] };
    }
    const root = join(this.root, spaceId);
    const keys = await this.collectKeys(root, options.prefix);
    // Sorted so a cursor can be a key: the page after `cursor` is well defined
    // only if the order is, and lexical order is the one S3 also lists in.
    keys.sort();

    const after = options.cursor;
    const page = after ? keys.filter((key) => key > after) : keys;
    const limited = options.limit ? page.slice(0, options.limit) : page;

    const files: StoredFileInfo[] = [];
    for (const key of limited) {
      const info = await stat(join(root, key)).catch(() => null);
      if (!info) continue;
      files.push({ key, size: info.size, updatedAt: info.mtime });
    }

    const more = limited.length < page.length;
    return more ? { files, cursor: limited.at(-1) } : { files };
  }

  /**
   * Keys under `prefix`, or every content-addressable key when it is omitted.
   *
   * The `.staging` directory is skipped: an upload in flight is not a stored
   * object, and it disappears again either way.
   */
  async collectKeys(root: string, prefix?: string): Promise<string[]> {
    const walk = async (dir: string, base: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const found: string[] = [];
      for (const entry of entries) {
        if (entry.name === ".staging") continue;
        const key = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          found.push(...(await walk(join(dir, entry.name), key)));
        } else if (entry.isFile()) {
          found.push(key);
        }
      }
      return found;
    };

    if (prefix === undefined) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const found: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
        found.push(...(await walk(join(root, entry.name), entry.name)));
      }
      return found;
    }

    // A prefix is a key prefix, not necessarily a directory: list its parent
    // and keep what starts with it, the way an object store would.
    const slash = prefix.lastIndexOf("/");
    const parent = slash === -1 ? "" : prefix.slice(0, slash);
    const keys = await walk(join(root, parent), parent);
    return keys.filter((key) => key.startsWith(prefix));
  }
}

/**
 * A local adapter rooted at `root`, which holds one directory per space.
 *
 * Exported so a root can be chosen rather than inherited from the process's
 * working directory — a test wants its own, and a configured deployment will
 * want one that is not relative to wherever the binary was started.
 */
export function createLocalBlobStore(root: string): BlobStore {
  return new LocalBlobStore(root);
}
