import type { SpaceStore } from "#db/client/store.ts";
import { getDocument, getDocumentContent } from "#db/space/documents.ts";
import { getLiveDocumentContent } from "#realtime/yjsRooms.ts";
import { createRun } from "./runStore.ts";
import { executeWorkflowScript } from "./workflowScript.ts";
import type { WorkflowStepCache } from "./workflowStepCache.ts";

/**
 * Starts a workflow run and returns its run id immediately; execution
 * proceeds in the background (errors are recorded in run state). Shared by
 * the on-demand `POST /workflows/runs` route and the cron scheduler.
 */
export async function startWorkflowRun(
  store: SpaceStore,
  documentId: string,
  options: {
    initiatedByUserId: string | null;
    sourceExtensionId?: string | null;
    runtimeInputs?: Record<string, unknown>;
    /** Prior run's step cache to resume from; matching steps replay instead of re-running. */
    seedCache?: WorkflowStepCache;
    /** The node to run on; see `JobRunContext.node`. */
    node?: string;
  },
): Promise<string> {
  const { spaceId } = store;
  const doc = await getDocument(store, documentId);
  if (!doc) {
    throw new Error("Workflow document not found");
  }
  if (doc.type !== "workflow") {
    throw new Error("Document type must be 'workflow'");
  }

  // Always run the current draft — workflows are scripts, not versioned publications.
  const code = getLiveDocumentContent(
    spaceId,
    documentId,
    doc.type,
    (await getDocumentContent(store, documentId)) ?? "",
  );
  if (!code?.trim()) {
    throw new Error("Workflow script is empty");
  }

  const runId = await createRun(
    store,
    documentId,
    doc.createdBy,
    options.initiatedByUserId,
    options.sourceExtensionId ?? null,
    options.runtimeInputs ?? {},
  );
  // Fire and forget — errors are recorded in run state.
  executeWorkflowScript(store.platform, spaceId, runId, code, {
    runtimeInputs: options.runtimeInputs,
    seedCache: options.seedCache,
    node: options.node,
  }).catch(() => {});

  return runId;
}
