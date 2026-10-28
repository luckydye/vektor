/**
 * POST /api/v1/runs/:runId/call
 *
 * A runner's call for a run it carries: a job's capability or log, an agent
 * turn's updates, or either one's result (docs/runners.md).
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
import { answerRunnerCall } from "#runners/runners.ts";

/**
 * Make a call for a run on a runner
 *
 * Answers `{ value }`, or `{ error }` when the call failed or the run was not
 * granted it.
 *
 * @tag Jobs
 * @note Authenticated by the run's own token, which the runner got with the run and which dies with it.
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const runId = requireParam(context.var.params, "runId");
    const token = context.req.raw.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) throw unauthorizedResponse();
    const body = await parseJsonBody<{ name?: unknown; args?: unknown }>(context.req.raw);
    if (typeof body.name !== "string") throw badRequestResponse("name is required");
    const args = body.args ?? [];
    if (!Array.isArray(args)) throw badRequestResponse("args must be an array");
    const answer = await answerRunnerCall(runId, token, body.name, args);
    if (!answer) throw unauthorizedResponse();
    return jsonResponse(answer);
  }, "Failed to answer the job's call");
