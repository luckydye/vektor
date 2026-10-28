/**
 * /api/v1/spaces/:spaceId/runners
 *
 * GET: the space's job runners (docs/runners.md)
 * POST: register one; its secret is in this answer only
 */

import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createJobRunner, listJobRunners } from "#db/space/jobRunners.ts";

/**
 * List the space's job runners
 *
 * @tag Jobs
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.EDITOR,
    );
    const store = await openSpaceStore(context.var.platform, spaceId);
    return jsonResponse({ runners: await listJobRunners(store) });
  }, "Failed to list runners");

/**
 * Register a job runner
 *
 * The answer carries the secret the server sends the runner as a bearer
 * token; it is not shown again.
 *
 * @tag Jobs
 * @body
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
    const body = await parseJsonBody<{ name?: unknown; url?: unknown }>(context.req.raw);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 64)
      throw badRequestResponse("name must be 1–64 characters");
    const url =
      typeof body.url === "string" && URL.canParse(body.url) ? new URL(body.url) : null;
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw badRequestResponse("url must be an http(s) URL");
    }
    const store = await openSpaceStore(context.var.platform, spaceId);
    return createdResponse(
      await createJobRunner(store, { name, url: url.href, createdBy: user.id }),
    );
  }, "Failed to register runner");
