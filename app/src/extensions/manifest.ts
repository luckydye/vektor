import { inflateRawSync } from "node:zlib";

export interface ExtensionRouteMenuItem {
  title: string;
  icon?: string;
}

export interface ExtensionRoute {
  path: string;
  title?: string;
  description?: string;
  menuItem?: ExtensionRouteMenuItem;
  placements?: Array<"page" | "home-top" | "document">;
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
}

export interface ZipEntry {
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

export function parseZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);

    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);

    const fileName = buffer
      .subarray(offset + 30, offset + 30 + fileNameLength)
      .toString("utf-8");

    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let fileData: Buffer;

    if (compressionMethod === 0) {
      fileData = compressedData;
    } else if (compressionMethod === 8) {
      fileData = inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported compression method: ${compressionMethod}`);
    }

    if (!fileName.endsWith("/")) {
      entries.push({ name: fileName, data: fileData });
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}

function resolveMenuIcon(icon: string, files: ZipEntry[]): string {
  try {
    const trimmedIcon = icon.trim();

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

export function extractFile(zipBuffer: Buffer, filePath: string): Buffer | null {
  const files = parseZip(zipBuffer);
  const file = findZipEntry(files, filePath);
  return file?.data ?? null;
}

export function extractManifest(zipBuffer: Buffer): ExtensionManifest {
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
    }
  }

  // Validate that declared entry files are present in the ZIP.
  for (const [key, entryPath] of Object.entries(manifest.entries)) {
    if (entryPath && !findZipEntry(files, entryPath)) {
      throw new Error(
        `Extension manifest entries.${key} references '${entryPath}' which is not in the package`,
      );
    }
  }

  // Routes require a view entry to render; a view entry without routes is never loaded.
  const hasRoutes = manifest.routes && manifest.routes.length > 0;
  const hasViewEntry = Boolean(manifest.entries.view);
  if (hasRoutes && !hasViewEntry) {
    throw new Error(
      "Extension manifest has routes but no entries.view — add a view entry or remove the routes",
    );
  }
  if (hasViewEntry && !hasRoutes) {
    throw new Error(
      "Extension manifest has entries.view but no routes — add routes or remove the view entry",
    );
  }

  return manifest;
}
