/**
 * Extension Manifest Schema
 *
 * Example manifest.json:
 * {
 *   "id": "my-extension",
 *   "name": "My Extension",
 *   "version": "1.0.0",
 *   "entries": {
 *     "frontend": "dist/main.js"
 *   }
 * }
 */

export type ExtensionManifest = {
  /** Unique extension identifier (lowercase, kebab-case) */
  id: string;
  /** Display name */
  name: string;
  /** Semantic version (e.g., "1.0.0") */
  version: string;
  /** Entry points for different contexts */
  entries: {
    /** Path to frontend entry file (relative to zip root) */
    frontend?: string;
  };
  /** Optional description */
  description?: string;
  /** Optional author info */
  author?: string;
};

export function validateManifest(data: unknown): ExtensionManifest {
  if (!data || typeof data !== "object") {
    throw new Error("Manifest must be an object");
  }

  const manifest = data as Record<string, unknown>;

  if (typeof manifest.id !== "string" || !manifest.id) {
    throw new Error("Manifest 'id' is required and must be a string");
  }

  if (!/^[a-z0-9-]+$/.test(manifest.id)) {
    throw new Error("Manifest 'id' must be lowercase alphanumeric with hyphens only");
  }

  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("Manifest 'name' is required and must be a string");
  }

  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("Manifest 'version' is required and must be a string");
  }

  if (!manifest.entries || typeof manifest.entries !== "object") {
    throw new Error("Manifest 'entries' is required and must be an object");
  }

  const entries = manifest.entries as Record<string, unknown>;

  if (entries.frontend !== undefined && typeof entries.frontend !== "string") {
    throw new Error("Manifest 'entries.frontend' must be a string");
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entries: {
      frontend: entries.frontend as string | undefined,
    },
    description:
      typeof manifest.description === "string" ? manifest.description : undefined,
    author: typeof manifest.author === "string" ? manifest.author : undefined,
  };
}
