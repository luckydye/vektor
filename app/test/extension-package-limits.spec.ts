import { beforeEach, describe, expect, it } from "vitest";
import { extractFile, extractManifest } from "#extensions/manifest.ts";
import {
  clearExtensionPackageCache,
  extensionPackageCacheStats,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_ENTRY_BYTES,
} from "#extensions/packageCache.ts";
import { createZipBuffer, unzipSync } from "#utils/zip.ts";

const MB = 1024 * 1024;

/** Zeros compress ~1000:1, so these archives stay small on disk. */
function zeros(bytes: number): Buffer {
  return Buffer.alloc(bytes);
}

function manifestEntry(extra: Record<string, unknown> = {}) {
  return {
    name: "manifest.json",
    data: Buffer.from(
      JSON.stringify({
        id: "bomb-test",
        name: "Bomb Test",
        version: "1.0.0",
        entries: {},
        ...extra,
      }),
    ),
  };
}

describe("unzipSync limits", () => {
  it("rejects an entry that inflates past the entry limit", () => {
    const archive = createZipBuffer([{ name: "big.bin", data: zeros(2 * MB) }]);
    expect(archive.length).toBeLessThan(64 * 1024);

    expect(() =>
      unzipSync(archive, { maxEntryBytes: MB, maxTotalBytes: 8 * MB }),
    ).toThrow(/decompresses to 2097152 bytes, over the 1048576 byte entry limit/);
  });

  it("rejects an archive whose entries together pass the total limit", () => {
    const archive = createZipBuffer([
      { name: "a.bin", data: zeros(MB) },
      { name: "b.bin", data: zeros(MB) },
      { name: "c.bin", data: zeros(MB) },
    ]);

    expect(() => unzipSync(archive, { maxTotalBytes: 2 * MB })).toThrow(
      /more than the 2097152 byte archive limit/,
    );
  });

  it("unpacks an archive inside the limits", () => {
    const archive = createZipBuffer([{ name: "a.txt", data: Buffer.from("hello") }]);
    const files = unzipSync(archive, { maxTotalBytes: MB });
    expect(Buffer.from(files["a.txt"]).toString("utf-8")).toBe("hello");
  });
});

describe("extension package limits", () => {
  beforeEach(() => {
    clearExtensionPackageCache();
  });

  it("rejects a package with an oversized file", () => {
    const archive = createZipBuffer([
      manifestEntry(),
      { name: "big.bin", data: zeros(MAX_PACKAGE_ENTRY_BYTES + MB) },
    ]);

    expect(() => extractManifest(archive)).toThrow(/over the .* byte entry limit/);
    expect(() => extractFile(archive, "manifest.json")).toThrow(
      /over the .* byte entry limit/,
    );
  });

  it("rejects a package that inflates past the package limit", () => {
    const chunk = MAX_PACKAGE_ENTRY_BYTES - MB;
    const entries = [manifestEntry()];
    for (let i = 0; i * chunk <= MAX_PACKAGE_BYTES; i++) {
      entries.push({ name: `filler-${i}.bin`, data: zeros(chunk) });
    }

    expect(() => extractManifest(createZipBuffer(entries))).toThrow(
      /more than the .* byte archive limit/,
    );
  });

  it("accepts a package inside the limits", () => {
    const archive = createZipBuffer([
      manifestEntry({ jobs: [{ id: "noop", name: "Noop", entry: "jobs/noop.mjs" }] }),
      { name: "jobs/noop.mjs", data: Buffer.from("export default () => ({});\n") },
    ]);

    expect(extractManifest(archive).id).toBe("bomb-test");
    expect(extractFile(archive, "jobs/noop.mjs")?.toString("utf-8")).toContain("export");
  });
});

describe("extension package cache", () => {
  beforeEach(() => {
    clearExtensionPackageCache();
  });

  it("inflates a package once however often it is read", () => {
    const archive = createFilledPackage();

    extractManifest(archive);
    extractFile(archive, "asset.bin");
    extractFile(archive, "asset.bin");

    const stats = extensionPackageCacheStats();
    expect(stats.packages).toBe(1);
    expect(stats.bytes).toBeGreaterThanOrEqual(MB);
  });

  it("caches an updated package separately from the one it replaced", () => {
    extractManifest(createFilledPackage("v1"));
    extractManifest(createFilledPackage("v2"));

    expect(extensionPackageCacheStats().packages).toBe(2);
  });

  it("drops packages past the cache budget", () => {
    for (let i = 0; i < 12; i++) {
      extractManifest(createFilledPackage(`v${i}`, 8 * MB));
    }

    expect(extensionPackageCacheStats().bytes).toBeLessThanOrEqual(64 * MB);
  });
});

function createFilledPackage(version = "1.0.0", size = MB): Buffer {
  return createZipBuffer([
    manifestEntry({ version }),
    { name: "asset.bin", data: zeros(size) },
  ]);
}
