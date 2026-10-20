import { basename } from "node:path";
import type {
  Extension,
  ExtensionManifest,
  JobDefinition,
} from "#db/space/extensions.ts";
import type { Platform } from "#platform/platform.ts";
import { kebabToTitle } from "#utils/utils.ts";
import { createZipBuffer, type ZipEntry } from "#utils/zip.ts";

const EXTENSION_ID = "local-jobs";

type LocalPackage = { extension: Extension; packageBuffer: Buffer };

/** Built once per platform: the files are read at first use and not watched. */
const packages = new WeakMap<Platform, LocalPackage | null>();

function build(platform: Platform): LocalPackage | null {
  const files = platform.localJobFiles();
  if (files.length === 0) return null;

  const jobs: JobDefinition[] = files.map(({ name }) => {
    const id = basename(name, ".mjs");
    return { id, name: kebabToTitle(id), entry: `jobs/${name}` };
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
    ...files.map(({ name, data }) => ({ name: `jobs/${name}`, data })),
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

function load(platform: Platform): LocalPackage | null {
  if (!packages.has(platform)) packages.set(platform, build(platform));
  return packages.get(platform) ?? null;
}

export function getLocalExtension(platform: Platform): Extension | null {
  return load(platform)?.extension ?? null;
}

export function getLocalExtensionPackage(platform: Platform): Buffer | null {
  return load(platform)?.packageBuffer ?? null;
}
