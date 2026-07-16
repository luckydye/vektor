import { getFileStorage } from "#files/storage.ts";

export type WorkflowArtifactKind = "result" | "logs";

export type WorkflowArtifact = {
  key: string;
  url: string;
};

function artifactKey(runId: string, kind: WorkflowArtifactKind): string {
  return `artifacts/workflow/${runId}/${kind}.json`;
}

/**
 * Store workflow data outside SQLite as a JSON file.
 *
 * Workflow artifacts deliberately use their own storage namespace. They are not
 * user uploads, so they must not appear in the uploads list or file search index.
 */
export async function writeWorkflowArtifact(
  spaceId: string,
  runId: string,
  kind: WorkflowArtifactKind,
  value: unknown,
): Promise<WorkflowArtifact> {
  const key = artifactKey(runId, kind);
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const storage = getFileStorage();
  const url = await storage.put(spaceId, key, body, "application/json");
  return { key, url };
}

export async function readWorkflowArtifact<T>(
  spaceId: string,
  key: string,
): Promise<T | null> {
  const body = await getFileStorage().read(spaceId, key);
  if (!body) return null;

  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function workflowArtifactUrl(spaceId: string, key: string): string {
  return getFileStorage().url(spaceId, key);
}
