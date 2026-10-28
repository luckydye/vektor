/**
 * /api/v1/spaces/:spaceId/runners/:runnerId/describe
 *
 * POST: ask the runner what it offers (`describe`) and keep its answer
 */

import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  listJobRunnersWithSecrets,
  setJobRunnerDescription,
} from "#db/space/jobRunners.ts";
import { describeRunner } from "#runners/runners.ts";

/**
 * Describe a runner
 *
 * A runner that refuses `describe` runs jobs only.
 *
 * @tag Jobs
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );
    const store = await openSpaceStore(context.var.platform, spaceId);
    const runnerId = requireParam(context.var.params, "runnerId");
    const runner = (await listJobRunnersWithSecrets(store)).find(
      (r) => r.id === runnerId,
    );
    if (!runner) throw notFoundResponse("Runner");
    let description: Awaited<ReturnType<typeof describeRunner>>;
    try {
      description = await describeRunner(context.var.platform, runner);
    } catch (error) {
      throw badRequestResponse(
        `Runner "${runner.name}" could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await setJobRunnerDescription(store, runner.id, description);
    const { secret: _, ...summary } = runner;
    return jsonResponse({ runner: { ...summary, description } });
  }, "Failed to describe runner");
