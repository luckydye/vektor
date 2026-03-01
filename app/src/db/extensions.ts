import { eq } from "drizzle-orm";
import { inflateRawSync } from "node:zlib";
import { getSpaceDb } from "./db.ts";
import { extension } from "./schema/space.ts";

export interface ExtensionRouteMenuItem {
  title: string;
  icon?: string;
}

export interface ExtensionRoute {
  path: string;
  title?: string;
  description?: string;
  menuItem?: ExtensionRouteMenuItem;
  /** Where this view should be placed. Can include "page" (default) and/or home placements */
  placements?: Array<"page" | "home-top">;
}

export interface JobIOField {
  type: "string" | "number" | "boolean" | "object" | "file";
  required?: boolean;
}

export interface JobDefinition {
  id: string;
  name: string;
  entry: string;
  inputs?: Record<string, JobIOField>;
  outputs?: Record<string, JobIOField>;
}

export interface DataSourceDefinition {
  id: string;
  name: string;
  description?: string;
  /** Job id defined in manifest.jobs */
  jobId: string;
  inputs?: Record<string, JobIOField>;
  /** Optional default cache TTL hint for consumers */
  cacheTtlMs?: number;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  entries: {
    frontend?: string;
    view?: string;
  };
  routes?: ExtensionRoute[];
  jobs?: JobDefinition[];
  dataSources?: DataSourceDefinition[];
}

export interface Extension {
  id: string;
  manifest: ExtensionManifest;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface ExtensionManifestLoadError {
  id: string;
  error: string;
}

export async function listExtensions(spaceId: string): Promise<Extension[]> {
  const { extensions } = await listExtensionsWithErrors(spaceId);
  return extensions;
}

export async function listExtensionsWithErrors(
  spaceId: string,
): Promise<{ extensions: Extension[]; errors: ExtensionManifestLoadError[] }> {
  const db = await getSpaceDb(spaceId);
  const rows = await db.select().from(extension);

  const extensions: Extension[] = [];
  const errors: ExtensionManifestLoadError[] = [];
  for (const row of rows) {
    const result = safeExtractManifest(row.package, row.id);
    if (!result.manifest) {
      errors.push({
        id: row.id,
        error: result.error ?? "Invalid extension package",
      });
      continue;
    }
    extensions.push({
      id: row.id,
      manifest: result.manifest,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
    });
  }

  return { extensions, errors };
}

export async function getExtension(
  spaceId: string,
  extensionId: string,
): Promise<Extension | null> {
  const db = await getSpaceDb(spaceId);
  const rows = await db.select().from(extension).where(eq(extension.id, extensionId));

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  const result = safeExtractManifest(row.package, row.id);
  if (!result.manifest) {
    return null;
  }
  return {
    id: row.id,
    manifest: result.manifest,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

export async function getExtensionPackage(
  spaceId: string,
  extensionId: string,
): Promise<Buffer | null> {
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select({ package: extension.package })
    .from(extension)
    .where(eq(extension.id, extensionId));

  if (rows.length === 0) {
    return null;
  }

  return rows[0].package;
}

export async function createExtension(
  spaceId: string,
  extensionId: string,
  packageBuffer: Buffer,
  userId: string,
): Promise<Extension> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const manifest = extractManifest(packageBuffer);

  await db.insert(extension).values({
    id: extensionId,
    package: packageBuffer,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  });

  return {
    id: extensionId,
    manifest,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  };
}

export async function updateExtension(
  spaceId: string,
  extensionId: string,
  packageBuffer: Buffer,
): Promise<Extension | null> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  const existingRows = await db
    .select({
      id: extension.id,
      createdAt: extension.createdAt,
      createdBy: extension.createdBy,
    })
    .from(extension)
    .where(eq(extension.id, extensionId));

  const existing = existingRows[0];
  if (!existing) {
    return null;
  }

  await db
    .update(extension)
    .set({
      package: packageBuffer,
      updatedAt: now,
    })
    .where(eq(extension.id, extensionId));

  const manifest = extractManifest(packageBuffer);
  return {
    id: extensionId,
    manifest,
    createdAt: existing.createdAt,
    updatedAt: now,
    createdBy: existing.createdBy,
  };
}

function safeExtractManifest(
  zipBuffer: Buffer,
  extensionIdForLog?: string,
): { manifest: ExtensionManifest | null; error?: string } {
  try {
    return { manifest: extractManifest(zipBuffer) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid extension package";
    console.warn(
      `Skipping invalid extension manifest${extensionIdForLog ? ` for '${extensionIdForLog}'` : ""}:`,
      err,
    );
    return { manifest: null, error: message };
  }
}

export async function deleteExtension(
  spaceId: string,
  extensionId: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  const result = await db.delete(extension).where(eq(extension.id, extensionId));

  return result.rowsAffected > 0;
}

/**
 * Find an extension that handles a given route path
 */
export async function findExtensionForRoute(
  spaceId: string,
  routePath: string,
): Promise<{ extension: Extension; route: ExtensionRoute } | null> {
  const extensions = await listExtensions(spaceId);

  for (const ext of extensions) {
    if (!ext.manifest.routes) continue;
    for (const route of ext.manifest.routes) {
      if (route.path === routePath) {
        return { extension: ext, route };
      }
    }
  }

  return null;
}

// Extract manifest.json from zip buffer
// Uses a minimal zip parser to avoid external dependencies
function extractManifest(zipBuffer: Buffer): ExtensionManifest {
  const files = parseZip(zipBuffer);
  const manifestFile = files.find(
    (f) => f.name === "manifest.json" || f.name === "./manifest.json",
  );

  if (!manifestFile) {
    throw new Error("Extension package missing manifest.json");
  }

  const manifestText = manifestFile.data.toString("utf-8");
  const manifest = JSON.parse(manifestText) as ExtensionManifest;

  if (!manifest.id || typeof manifest.id !== "string") {
    throw new Error("Extension manifest missing required 'id' field");
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error("Extension manifest missing required 'name' field");
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("Extension manifest missing required 'version' field");
  }
  if (!manifest.entries || typeof manifest.entries !== "object") {
    throw new Error("Extension manifest missing required 'entries' field");
  }

  if (manifest.routes !== undefined) {
    if (!Array.isArray(manifest.routes)) {
      throw new Error("Extension manifest 'routes' must be an array");
    }
    for (const [index, route] of manifest.routes.entries()) {
      if (!route || typeof route !== "object") {
        throw new Error(`Extension manifest route at index ${index} is invalid`);
      }
      if (!route.path || typeof route.path !== "string") {
        throw new Error(
          `Extension manifest route at index ${index} is missing required 'path' field`,
        );
      }
      if (route.menuItem?.icon && typeof route.menuItem.icon === "string") {
        route.menuItem.icon = resolveMenuIcon(route.menuItem.icon, files);
        if (!route.menuItem.icon) {
          delete route.menuItem.icon;
        }
      }
    }
  }

  const jobIds = new Set<string>();
  if (manifest.jobs !== undefined) {
    if (!Array.isArray(manifest.jobs)) {
      throw new Error("Extension manifest 'jobs' must be an array");
    }
    for (const job of manifest.jobs) {
      if (!job || typeof job !== "object") {
        throw new Error("Extension manifest contains invalid job definition");
      }
      if (!job.id || typeof job.id !== "string") {
        throw new Error("Extension manifest job is missing required 'id' field");
      }
      if (!job.entry || typeof job.entry !== "string") {
        throw new Error(
          `Extension manifest job '${job.id}' is missing required 'entry' field`,
        );
      }
      jobIds.add(job.id);
    }
  }

  if (manifest.dataSources !== undefined) {
    if (!Array.isArray(manifest.dataSources)) {
      throw new Error("Extension manifest 'dataSources' must be an array");
    }
    const ids = new Set<string>();
    for (const ds of manifest.dataSources) {
      if (!ds || typeof ds !== "object") {
        throw new Error("Extension manifest contains invalid data source definition");
      }
      if (!ds.id || typeof ds.id !== "string") {
        throw new Error("Extension data source is missing required 'id' field");
      }
      if (ids.has(ds.id)) {
        throw new Error(`Extension data source id '${ds.id}' is duplicated`);
      }
      ids.add(ds.id);
      if (!ds.name || typeof ds.name !== "string") {
        throw new Error(
          `Extension data source '${ds.id}' is missing required 'name' field`,
        );
      }
      if (!ds.jobId || typeof ds.jobId !== "string") {
        throw new Error(
          `Extension data source '${ds.id}' is missing required 'jobId' field`,
        );
      }
      if (!jobIds.has(ds.jobId)) {
        throw new Error(
          `Extension data source '${ds.id}' references unknown jobId '${ds.jobId}'`,
        );
      }
      if (
        ds.cacheTtlMs !== undefined &&
        (typeof ds.cacheTtlMs !== "number" || ds.cacheTtlMs < 0)
      ) {
        throw new Error(`Extension data source '${ds.id}' has invalid 'cacheTtlMs'`);
      }
    }
  }

  return manifest;
}

function resolveMenuIcon(icon: string, files: ZipEntry[]): string {
  try {
    const trimmedIcon = icon.trim();

    // Backward compatible: allow inline SVG in manifest.
    if (trimmedIcon.startsWith("<svg")) {
      return trimmedIcon;
    }

    const normalisedPath = normaliseZipPath(trimmedIcon);
    if (!normalisedPath.toLowerCase().endsWith(".svg")) {
      console.warn(
        `Ignoring extension menu icon '${trimmedIcon}': icon must be inline SVG or a .svg asset path`,
      );
      return "";
    }

    const iconFile = findZipEntry(files, normalisedPath);
    if (!iconFile) {
      console.warn(
        `Ignoring extension menu icon '${trimmedIcon}': referenced file was not found in package`,
      );
      return "";
    }

    const svgContent = iconFile.data.toString("utf-8").trim();
    if (!svgContent.startsWith("<svg")) {
      console.warn(
        `Ignoring extension menu icon '${trimmedIcon}': file content is not SVG`,
      );
      return "";
    }

    return svgContent;
  } catch (err) {
    console.warn(`Ignoring extension menu icon '${icon}':`, err);
    return "";
  }
}

// Extract a specific file from zip buffer
export function extractFile(zipBuffer: Buffer, filePath: string): Buffer | null {
  const files = parseZip(zipBuffer);
  const file = findZipEntry(files, filePath);

  return file?.data ?? null;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function normaliseZipPath(filePath: string): string {
  const normalised = filePath.replace(/^\.?\//, "").trim();
  if (!normalised || normalised.includes("..")) {
    throw new Error(`Invalid extension asset path: '${filePath}'`);
  }
  return normalised;
}

function findZipEntry(files: ZipEntry[], filePath: string): ZipEntry | undefined {
  const normalisedPath = normaliseZipPath(filePath);
  return files.find((file) => normaliseZipPath(file.name) === normalisedPath);
}

// Minimal zip parser for reading uncompressed and deflate-compressed entries
function parseZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);

    // Local file header signature
    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    // uncompressedSize at offset + 22 not needed for our extraction
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);

    const fileName = buffer
      .subarray(offset + 30, offset + 30 + fileNameLength)
      .toString("utf-8");

    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let fileData: Buffer;

    if (compressionMethod === 0) {
      // Stored (no compression)
      fileData = compressedData;
    } else if (compressionMethod === 8) {
      // Deflate compression
      fileData = inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported compression method: ${compressionMethod}`);
    }

    // Skip directories
    if (!fileName.endsWith("/")) {
      entries.push({
        name: fileName,
        data: fileData,
      });
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}
