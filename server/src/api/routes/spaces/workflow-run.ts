import { authenticateJobTokenOrSpaceRole, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources } from "#acl/store.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import {
  errorResponse,
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  cancelRun,
  ensureSpaceRecovered,
  getRunForRead,
  waitForRunSettled,
} from "#jobs/runStore.ts";
import { workflowArtifactUrl } from "#jobs/workflowArtifacts.ts";
import type { Platform } from "#platform/platform.ts";

/**
 * Read one workflow run
 *
 * GET /api/v1/spaces/:spaceId/workflows/runs/:runId
 * Returns the current state of a script workflow run. The result itself is a
 * JSON artifact; a hidden child document holds only its storage key and run
 * metadata in private properties. Log lines are the `workflow-run:{runId}`
 * series.
 *
 * @tag Workflows
 * @jobToken
 * @query wait Seconds (at most 50) to hold the response until the run has settled.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const runId = requireParam(context.var.params, "runId");

    const auth = await authenticateJobTokenOrSpaceRole(
      context.var.platform,
      context.var.credentials,
      spaceId,
      Permission.VIEWER,
    );

    const waitSeconds = Number(new URL(context.req.url).searchParams.get("wait") ?? 0);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 50) {
      return errorResponse("wait must be between 0 and 50 seconds", 400);
    }

    const store = await openSpaceStore(context.var.platform, spaceId);
    await ensureSpaceRecovered(store);
    const found = await getRunForRead(store, runId);
    if (!found || found.spaceId !== spaceId) return notFoundResponse("Run");
    const aclUserId = auth.type === "user" ? auth.user.id : auth.userId;
    if (aclUserId) {
      const readable = await filterReadableResources(
        store.platform,
        spaceId,
        ResourceType.DOCUMENT,
        [found.documentId],
        {
          userId: aclUserId,
          userGroups: await getUserGroups(context.var.platform, aclUserId),
        },
      );
      if (!readable.has(found.documentId)) return notFoundResponse("Run");
    }
    // Read again after waiting: a settled run is no longer active and reads from its document.
    await waitForRunSettled(runId, waitSeconds * 1000);
    const run = waitSeconds > 0 ? await getRunForRead(store, runId) : found;
    if (!run) return notFoundResponse("Run");
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
      resultArtifact: run.resultArtifactPath
        ? {
            key: run.resultArtifactPath,
            url: workflowArtifactUrl(store.platform, spaceId, run.resultArtifactPath),
          }
        : null,
    });
  }, "Failed to get run");

function cancelWorkflowRun(platform: Platform, context: Parameters<ApiRouteHandler>[0]) {
  return withApiErrorHandling(
    async () => {
      const user = requireUser(context);
      const spaceId = requireParam(context.var.params, "spaceId");
      const runId = requireParam(context.var.params, "runId");
      await verifyAccess(
        platform,
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        user.id,
        Permission.EDITOR,
      );
      const store = await openSpaceStore(platform, spaceId);
      await ensureSpaceRecovered(store);
      const run = await getRunForRead(store, runId);
      if (!run || run.spaceId !== spaceId) return notFoundResponse("Run");
      await cancelRun(platform, runId);
      return jsonResponse({ ok: true });
    },
    {
      fallbackMessage: "Failed to cancel run",
      onError: () => errorResponse("Failed to cancel run", 500),
    },
  );
}

/**
 * Act on a running workflow, e.g. answer a pending step
 *
 * @tag Workflows
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  cancelWorkflowRun(context.var.platform, context);

/**
 * Cancel or delete a workflow run
 *
 * @tag Workflows
 * @jobToken
 */
export const DELETE: ApiRouteHandler = (context) =>
  cancelWorkflowRun(context.var.platform, context);
