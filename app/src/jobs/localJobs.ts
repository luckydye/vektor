import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Extension, ExtensionManifest, JobDefinition } from "../db/extensions.ts";

const JOBS_DIR = join(process.cwd(), "jobs");
const EXTENSION_ID = "local-jobs";

let cached: { extension: Extension; packageBuffer: Buffer } | null | undefined;

function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function createZipBuffer(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);

    chunks.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuffer.copy(centralHeader, 46);

    centralDirectory.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirBuffer = Buffer.concat(centralDirectory);
  const centralDirOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirBuffer.length, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralDirBuffer, endRecord]);
}

function build(): { extension: Extension; packageBuffer: Buffer } | null {
  let files: string[];
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".mjs"));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  const jobs: JobDefinition[] = files.map((file) => {
    const id = basename(file, ".mjs");
    return { id, name: kebabToTitle(id), entry: `jobs/${file}` };
  });

  const manifest: ExtensionManifest = {
    id: EXTENSION_ID,
    name: "Local Jobs",
    version: "1.0.0",
    entries: {},
    jobs,
  };

  const zipEntries: ZipEntry[] = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    ...files.map((file) => ({
      name: `jobs/${file}`,
      data: readFileSync(join(JOBS_DIR, file)),
    })),
  ];

  const packageBuffer = createZipBuffer(zipEntries);
  const now = new Date();

  return {
    extension: {
      id: EXTENSION_ID,
      manifest,
      createdAt: now,
      updatedAt: now,
      createdBy: "system",
    },
    packageBuffer,
  };
}

function load(): { extension: Extension; packageBuffer: Buffer } | null {
  if (cached === undefined) {
    cached = build();
  }
  return cached;
}

export function getLocalExtension(): Extension | null {
  return load()?.extension ?? null;
}

export function getLocalExtensionPackage(): Buffer | null {
  return load()?.packageBuffer ?? null;
}
