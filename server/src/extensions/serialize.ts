import type { Extension } from "#db/space/extensions.ts";

/** The extension metadata every extension route answers with. */
export function serializeExtension(ext: Extension) {
  return {
    id: ext.id,
    name: ext.manifest.name,
    version: ext.manifest.version,
    description: ext.manifest.description,
    enabled: ext.enabled,
    source: ext.source,
    sourceRef: ext.sourceRef,
    sourcePublisher: ext.sourcePublisher,
    entries: ext.manifest.entries,
    routes: ext.manifest.routes,
    jobs: ext.manifest.jobs,
    createdAt: ext.createdAt.toISOString(),
    updatedAt: ext.updatedAt.toISOString(),
    createdBy: ext.createdBy,
  };
}
