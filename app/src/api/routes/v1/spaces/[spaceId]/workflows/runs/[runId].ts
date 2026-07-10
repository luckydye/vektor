import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  errorResponse,
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { cancelRun, ensureSpaceRecovered, getRunForRead } from "#jobs/runStore.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs/:runId
 * Returns the current state of a workflow run.
 * Nodes are returned in insertion order (= execution order for JS scripts).
 * Output is taken from the "_script" node's outputs (the script's return value).
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const runId = requireParam(context.var.params, "runId");

    await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");

    await ensureSpaceRecovered(spaceId);
    const run = await getRunForRead(spaceId, runId);
    if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");

    const nodes: Record<string, unknown> = {};
    for (const [id, nodeState] of run.nodes) {
      nodes[id] = {
        status: nodeState.status,
        inputs: nodeState.inputs,
        outputs: nodeState.outputs,
        error: nodeState.error,
        logs: nodeState.logs,
        startedAt: nodeState.startedAt?.toISOString() ?? null,
        completedAt: nodeState.completedAt?.toISOString() ?? null,
      };
    }

    // Output = the script's return value (stored on the _script node)
    const scriptNode = run.nodes.get("_script");
    const output =
      scriptNode?.outputs && Object.keys(scriptNode.outputs).length > 0
        ? scriptNode.outputs
        : null;

    return jsonResponse({
      runId,
      documentId: run.documentId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      sourceExtensionId: run.sourceExtensionId,
      runtimeInputs: run.runtimeInputs,
      nodes,
      output,
    });
  }, "Failed to get run");

function cancelWorkflowRun(context: Parameters<ApiRouteHandler>[0]) {
  return withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");
      const runId = requireParam(context.var.params, "runId");
      await verifySpaceRole(spaceId, user.id, "editor");
      await ensureSpaceRecovered(spaceId);
      const run = await getRunForRead(spaceId, runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      cancelRun(runId);
      return jsonResponse({ ok: true });
    },
    {
      fallbackMessage: "Failed to cancel run",
      onError: () => errorResponse("Failed to cancel run", 500),
    },
  );
}

export const POST: ApiRouteHandler = (context) => cancelWorkflowRun(context);

export const DELETE: ApiRouteHandler = (context) => cancelWorkflowRun(context);
