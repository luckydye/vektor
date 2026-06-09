import type { APIRoute } from "astro";
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
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const runId = requireParam(context.params, "runId");

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

    return jsonResponse({ status: run.status, nodes, output });
  }, "Failed to get run");

function cancelWorkflowRun(context: Parameters<APIRoute>[0]) {
  return withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");
      const runId = requireParam(context.params, "runId");
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

export const POST: APIRoute = (context) => cancelWorkflowRun(context);

export const DELETE: APIRoute = (context) => cancelWorkflowRun(context);
