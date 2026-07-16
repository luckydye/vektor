import type { ApiRouteHandler } from "#api/server/types.ts";
import { filterReadableResources, getUserGroups, ResourceType } from "#db/acl.ts";
import {
  errorResponse,
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  cancelRun,
  ensureSpaceRecovered,
  getRunForRead,
  readRunLogs,
} from "#jobs/runStore.ts";
import { workflowArtifactUrl } from "#jobs/workflowArtifacts.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

/**
 * GET /api/v1/spaces/:spaceId/workflows/runs/:runId
 * Returns the current state of a script workflow run. The result itself is a
 * JSON artifact; a hidden child document holds only its storage key and run
 * metadata in private properties.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const runId = requireParam(context.var.params, "runId");

    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");

    await ensureSpaceRecovered(spaceId);
    const run = await getRunForRead(spaceId, runId);
    if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
    const aclUserId = auth.type === "user" ? auth.user.id : auth.userId;
    if (aclUserId) {
      const readable = await filterReadableResources(
        spaceId,
        ResourceType.DOCUMENT,
        [run.documentId],
        aclUserId,
        await getUserGroups(aclUserId),
      );
      if (!readable.has(run.documentId)) return notFoundResponse("Run");
    }
    const logs = await readRunLogs(run);

    return jsonResponse({
      runId,
      documentId: run.documentId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      sourceExtensionId: run.sourceExtensionId,
      runtimeInputs: run.runtimeInputs,
      error: run.error,
      logs,
      resultArtifact: run.resultArtifactPath
        ? {
            key: run.resultArtifactPath,
            url: workflowArtifactUrl(spaceId, run.resultArtifactPath),
          }
        : null,
      logArtifact: run.logArtifactPath
        ? {
            key: run.logArtifactPath,
            url: workflowArtifactUrl(spaceId, run.logArtifactPath),
          }
        : null,
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
      await cancelRun(runId);
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
