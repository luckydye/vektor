import { getDocument, getDocumentContent } from "#db/documents.ts";
import { createRun } from "./runStore.ts";
import { executeWorkflowScript } from "./workflowScript.ts";

/**
 * Starts a workflow run and returns its run id immediately; execution
 * proceeds in the background (errors are recorded in run state). Shared by
 * the on-demand `POST /workflows/runs` route and the cron scheduler.
 */
export async function startWorkflowRun(
  spaceId: string,
  documentId: string,
  options: {
    initiatedByUserId: string | null;
    sourceExtensionId?: string | null;
    runtimeInputs?: Record<string, unknown>;
  },
): Promise<string> {
  const doc = await getDocument(spaceId, documentId);
  if (!doc) {
    throw new Error("Workflow document not found");
  }
  if (doc.type !== "workflow") {
    throw new Error("Document type must be 'workflow'");
  }

  // Always run the current draft — workflows are scripts, not versioned publications.
  const code = await getDocumentContent(spaceId, documentId);
  if (!code?.trim()) {
    throw new Error("Workflow script is empty");
  }

  const runId = await createRun(
    spaceId,
    documentId,
    doc.createdBy,
    options.initiatedByUserId,
    options.sourceExtensionId ?? null,
    options.runtimeInputs ?? {},
  );
  // Fire and forget — errors are recorded in run state.
  executeWorkflowScript(spaceId, runId, code, {
    runtimeInputs: options.runtimeInputs,
  }).catch(() => {});

  return runId;
}
