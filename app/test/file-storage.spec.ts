/**
 * The local storage adapter: the shared adapter contract, plus what only a
 * filesystem backend can get wrong.
 *
 * Run with:
 *   bunx --bun vitest run test/file-storage.spec.ts
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFileStorage, type FileStorageAdapter } from "#files/storage.ts";
import { describeFileStorageContract } from "./helpers/fileStorageContract.ts";

// Its own root, and no touching of the process adapter: the server project runs
// `isolate: false`, so a spec that changed either would change it for every
// spec after it.
let root: string;
let storage: FileStorageAdapter;
const SPACE = "space_1";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vektor-storage-"));
  storage = createLocalFileStorage(root);
  mkdirSync(join(root, SPACE, "adir"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describeFileStorageContract("local adapter", () => ({
  storage,
  space: SPACE,
  neighbour: "space_2",
}));

describe("local filesystem specifics", () => {
  it("is null for a directory, which is not a stored object", async () => {
    expect(await storage.stat(SPACE, "adir")).toBeNull();
  });

  it("does not delete a file outside the root that no space owns", async () => {
    const victim = join(root, "space_2", "loose.txt");
    writeFileSync(victim, "not yours");
    await storage.delete(SPACE, "../space_2/loose.txt");
    expect(existsSync(victim)).toBe(true);
  });
});
