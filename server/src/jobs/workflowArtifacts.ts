import type { Platform } from "#platform/platform.ts";

export type WorkflowArtifactKind = "result" | "resume";

export type WorkflowArtifact = {
  key: string;
  url: string;
};

/**
 * Artifact paths are derived from (runId, kind), so an artifact can be read back
 * without the run recording where it went.
 */
export function workflowArtifactKey(runId: string, kind: WorkflowArtifactKind): string {
  return `artifacts/workflow/${runId}/${kind}.json`;
}

/**
 * Store workflow data outside SQLite as a JSON file.
 *
 * Workflow artifacts deliberately use their own storage namespace. They are not
 * user uploads, so they must not appear in the uploads list or file search index.
 */
export async function writeWorkflowArtifact(
  platform: Platform,
  spaceId: string,
  runId: string,
  kind: WorkflowArtifactKind,
  value: unknown,
): Promise<WorkflowArtifact> {
  const key = workflowArtifactKey(runId, kind);
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const storage = platform.blobStore;
  const url = await storage.put(spaceId, key, body, "application/json");
  return { key, url };
}

export async function readWorkflowArtifact<T>(
  platform: Platform,
  spaceId: string,
  key: string,
): Promise<T | null> {
  const body = await platform.blobStore.read(spaceId, key);
  if (!body) return null;

  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function workflowArtifactUrl(
  platform: Platform,
  spaceId: string,
  key: string,
): string {
  return platform.blobStore.url(spaceId, key);
}
