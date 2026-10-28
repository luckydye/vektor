/**
 * POST /api/v1/jobs/:jobId/call
 *
 * A job runner's capability call for a running job (docs/job-runners.md).
 */

import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { answerRunnerCall } from "#jobs/runners.ts";

/**
 * Call a capability for a job on a runner
 *
 * Answers `{ value }`, or `{ error }` when the capability threw or the job was
 * not granted it.
 *
 * @tag Jobs
 * @note Authenticated by the job's own token, which the runner got with the job and which dies with it.
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const jobId = requireParam(context.var.params, "jobId");
    const token = context.req.raw.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) throw unauthorizedResponse();
    const body = await parseJsonBody<{ name?: unknown; args?: unknown }>(context.req.raw);
    if (typeof body.name !== "string") throw badRequestResponse("name is required");
    const args = body.args ?? [];
    if (!Array.isArray(args)) throw badRequestResponse("args must be an array");
    const answer = await answerRunnerCall(jobId, token, body.name, args);
    if (!answer) throw unauthorizedResponse();
    return jsonResponse(answer);
  }, "Failed to answer the job's call");
