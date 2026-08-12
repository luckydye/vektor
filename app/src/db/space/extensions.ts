import { and, eq } from "drizzle-orm";
import { config } from "#config";
import type { SpaceStore } from "#db/client/store.ts";
import { extension } from "#db/schema/space.ts";
import {
  type ExtensionManifest,
  type ExtensionRoute,
  type ExtensionRouteMenuItem,
  extractFile,
  extractManifest,
  type JobDefinition,
  type JobIOField,
} from "#extensions/manifest.ts";
import { getLocalExtension, getLocalExtensionPackage } from "#jobs/localJobs.ts";
import { appLogger } from "#observability/logger.ts";

export type {
  ExtensionManifest,
  ExtensionRoute,
  ExtensionRouteMenuItem,
  JobDefinition,
  JobIOField,
};
export { extractFile, extractManifest };

export type ExtensionSource = "upload" | "marketplace" | "system";

export interface Extension {
  id: string;
  manifest: ExtensionManifest;
  enabled: boolean;
  source: ExtensionSource;
  sourceRef: string | null;
  sourcePublisher: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface ExtensionManifestLoadError {
  id: string;
  error: string;
}

interface ExtensionQueryOptions {
  includeDisabled?: boolean;
}

export async function listExtensions(
  s: SpaceStore,
  options: ExtensionQueryOptions = {},
): Promise<Extension[]> {
  const { extensions } = await listExtensionsWithErrors(s, options);
  return extensions;
}

export async function listExtensionsWithErrors(
  s: SpaceStore,
  options: ExtensionQueryOptions = {},
): Promise<{ extensions: Extension[]; errors: ExtensionManifestLoadError[] }> {
  const rows = await s.db.select().from(extension);

  const extensions: Extension[] = [];
  const errors: ExtensionManifestLoadError[] = [];
  for (const row of rows) {
    if (!options.includeDisabled && !row.enabled) {
      continue;
    }
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
      enabled: row.enabled,
      source: (row.source as ExtensionSource) ?? "upload",
      sourceRef: row.sourceRef ?? null,
      sourcePublisher: row.sourcePublisher ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
    });
  }

  const local = getLocalExtension();
  if (local) extensions.push(local);

  return { extensions, errors };
}

export async function getExtension(
  s: SpaceStore,
  extensionId: string,
  options: ExtensionQueryOptions = {},
): Promise<Extension | null> {
  const local = getLocalExtension();
  if (local && extensionId === local.id) return local;
  const conditions = [eq(extension.id, extensionId)];
  if (!options.includeDisabled) {
    conditions.push(eq(extension.enabled, true));
  }
  const rows = await s.db
    .select()
    .from(extension)
    .where(and(...conditions));

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
    enabled: row.enabled,
    source: (row.source as ExtensionSource) ?? "upload",
    sourceRef: row.sourceRef ?? null,
    sourcePublisher: row.sourcePublisher ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
  };
}

export async function getExtensionPackage(
  s: SpaceStore,
  extensionId: string,
): Promise<Buffer | null> {
  const local = getLocalExtension();
  if (local && extensionId === local.id) return getLocalExtensionPackage();
  const rows = await s.db
    .select({ package: extension.package })
    .from(extension)
    .where(eq(extension.id, extensionId));

  if (rows.length === 0) {
    return null;
  }

  return rows[0].package;
}

export interface CreateExtensionOptions {
  source?: ExtensionSource;
  sourceRef?: string | null;
  sourcePublisher?: string | null;
}

export async function createExtension(
  s: SpaceStore,
  extensionId: string,
  packageBuffer: Buffer,
  userId: string,
  options: CreateExtensionOptions = {},
): Promise<Extension> {
  const now = new Date();
  const manifest = extractManifest(packageBuffer);
  const source = options.source ?? "upload";
  const sourceRef = options.sourceRef ?? null;
  const sourcePublisher = options.sourcePublisher ?? null;

  await s.db.insert(extension).values({
    id: extensionId,
    package: packageBuffer,
    enabled: true,
    source,
    sourceRef,
    sourcePublisher,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  });

  s.emit({ kind: "extensions" });

  return {
    id: extensionId,
    manifest,
    enabled: true,
    source,
    sourceRef,
    sourcePublisher,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  };
}

export async function updateExtension(
  s: SpaceStore,
  extensionId: string,
  packageBuffer: Buffer,
): Promise<Extension | null> {
  const now = new Date();

  const existingRows = await s.db
    .select({
      id: extension.id,
      enabled: extension.enabled,
      source: extension.source,
      sourceRef: extension.sourceRef,
      sourcePublisher: extension.sourcePublisher,
      createdAt: extension.createdAt,
      createdBy: extension.createdBy,
    })
    .from(extension)
    .where(eq(extension.id, extensionId));

  const existing = existingRows[0];
  if (!existing) {
    return null;
  }

  await s.db
    .update(extension)
    .set({
      package: packageBuffer,
      updatedAt: now,
    })
    .where(eq(extension.id, extensionId));

  s.emit({ kind: "extensions" });

  const manifest = extractManifest(packageBuffer);
  return {
    id: extensionId,
    manifest,
    enabled: existing.enabled,
    source: (existing.source as ExtensionSource) ?? "upload",
    sourceRef: existing.sourceRef ?? null,
    sourcePublisher: existing.sourcePublisher ?? null,
    createdAt: existing.createdAt,
    updatedAt: now,
    createdBy: existing.createdBy,
  };
}

export async function setExtensionEnabled(
  s: SpaceStore,
  extensionId: string,
  enabled: boolean,
): Promise<Extension | null> {
  const local = getLocalExtension();
  if (local && extensionId === local.id) return null;
  const now = new Date();
  const rows = await s.db
    .select({
      id: extension.id,
      package: extension.package,
      source: extension.source,
      sourceRef: extension.sourceRef,
      sourcePublisher: extension.sourcePublisher,
      createdAt: extension.createdAt,
      createdBy: extension.createdBy,
    })
    .from(extension)
    .where(eq(extension.id, extensionId));

  const existing = rows[0];
  if (!existing) {
    return null;
  }

  await s.db
    .update(extension)
    .set({
      enabled,
      updatedAt: now,
    })
    .where(eq(extension.id, extensionId));

  s.emit({ kind: "extensions" });

  const result = safeExtractManifest(existing.package, extensionId);
  if (!result.manifest) {
    return null;
  }

  return {
    id: extensionId,
    manifest: result.manifest,
    enabled,
    source: (existing.source as ExtensionSource) ?? "upload",
    sourceRef: existing.sourceRef ?? null,
    sourcePublisher: existing.sourcePublisher ?? null,
    createdAt: existing.createdAt,
    updatedAt: now,
    createdBy: existing.createdBy,
  };
}

export function safeExtractManifest(
  zipBuffer: Buffer,
  extensionIdForLog?: string,
): { manifest: ExtensionManifest | null; error?: string } {
  try {
    return { manifest: extractManifest(zipBuffer) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid extension package";
    appLogger.warn(
      `Skipping invalid extension manifest${extensionIdForLog ? ` for '${extensionIdForLog}'` : ""}`,
      { error: err },
    );
    return { manifest: null, error: message };
  }
}

export async function deleteExtension(
  s: SpaceStore,
  extensionId: string,
): Promise<boolean> {
  const result = await s.db
    .delete(extension)
    .where(eq(extension.id, extensionId))
    .returning({ id: extension.id });

  if (result.length > 0) {
    s.emit({ kind: "extensions" });
  }

  return result.length > 0;
}

/**
 * Find an extension that handles a given route path
 */
export async function findExtensionForRoute(
  s: SpaceStore,
  routePath: string,
): Promise<{ extension: Extension; route: ExtensionRoute } | null> {
  const extensions = await listExtensions(s);

  for (const ext of extensions) {
    if (!ext.manifest.routes) continue;
    for (const route of ext.manifest.routes) {
      const placements = route.placements ?? ["standalone"];
      const isStandalone =
        placements.includes("standalone") || placements.includes("page");
      if (route.path === routePath && isStandalone) {
        return { extension: ext, route };
      }
    }
  }

  return null;
}

export const ALL_EXTENSION_SOURCES: ExtensionSource[] = [
  "upload",
  "marketplace",
  "system",
];

/**
 * Returns the set of extension sources the server will accept, as configured
 * by the VEKTOR_EXTENSION_ALLOWED_SOURCES environment variable.
 * Defaults to all sources when the variable is unset.
 */
export function getExtensionSourcePolicy(): ExtensionSource[] {
  const raw = config().EXTENSION_ALLOWED_SOURCES;
  if (!raw) return [...ALL_EXTENSION_SOURCES];

  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ExtensionSource => ["upload", "marketplace", "system"].includes(s));

  return parts.length > 0 ? parts : [...ALL_EXTENSION_SOURCES];
}
