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
import { getRun, cancelRun } from "../../../../../../../jobs/runStore.ts";

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs/:runId
 * Returns the current state of a workflow run.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const runId = requireParam(context.params, "runId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const run = getRun(runId);
    if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");

    const nodes: Record<string, unknown> = {};
    for (const [nodeId, nodeState] of run.nodes) {
      nodes[nodeId] = {
        status: nodeState.status,
        inputs: nodeState.inputs,
        outputs: nodeState.outputs,
        error: nodeState.error,
        logs: nodeState.logs,
        startedAt: nodeState.startedAt?.toISOString() ?? null,
        completedAt: nodeState.completedAt?.toISOString() ?? null,
      };
    }

    return jsonResponse({ status: run.status, nodes });
  }, "Failed to get run");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.params, "spaceId");
      const runId = requireParam(context.params, "runId");
      await verifySpaceRole(spaceId, user.id, "editor");
      const run = getRun(runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      cancelRun(runId);
      return jsonResponse({ ok: true });
    },
    {
      fallbackMessage: "Failed to cancel run",
      onError: (error) => {
        console.error("Cancel workflow run error:", error);
        return errorResponse("Failed to cancel run", 500);
      },
    },
  );
