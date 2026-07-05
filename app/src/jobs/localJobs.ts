import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Extension, ExtensionManifest, JobDefinition } from "#db/extensions.ts";
import { createZipBuffer, kebabToTitle, type ZipEntry } from "#utils/zip.ts";

const JOBS_DIR = join(process.cwd(), "jobs");
const EXTENSION_ID = "local-jobs";

let cached: { extension: Extension; packageBuffer: Buffer } | null | undefined;

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
      enabled: true,
      source: "system" as const,
      sourceRef: null,
      sourcePublisher: null,
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
