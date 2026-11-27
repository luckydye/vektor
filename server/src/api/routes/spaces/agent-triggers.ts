/**
 * /api/v1/spaces/:spaceId/agent-triggers
 *
 * GET:  list the caller's agent triggers
 * POST: create a trigger that gives the agent a prompt at a due time, as a new
 *       chat session of the caller or as a post in `sessionId`
 *
 * Body: {
 *   prompt: string,
 *   sessionId?: string,       // a bot's channel or thread to post into

 *   runAt?: string,           // ISO 8601 instant, for a one-shot trigger
 *   cronExpression?: string,  // standard 5-field cron, for a recurring one
 *   timezone?: string         // IANA timezone for the cron expression
 * }
 */

import { authenticateJobTokenOrSpaceRole, requireChatSession } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  type AgentSchedule,
  createAgentSchedule,
  listAgentSchedules,
} from "#db/space/agentSchedules.ts";
import { validateCronExpression } from "#db/space/workflowSchedules.ts";

/** The user a trigger belongs to; a job token without one has no chat history to run in. */
export async function requireTriggerOwner(
  context: ApiContext,
  spaceId: string,
): Promise<string> {
  const auth = await authenticateJobTokenOrSpaceRole(
    context.var.platform,
    context.var.credentials,
    spaceId,
    Permission.EDITOR,
  );
  const userId = auth.type === "user" ? auth.user.id : auth.userId;
  if (!userId) {
    throw forbiddenResponse("Agent triggers belong to a user; this job token has none");
  }
  return userId;
}

export function toAgentTriggerDto(trigger: AgentSchedule) {
  return {
    id: trigger.id,
    prompt: trigger.prompt,
    sessionId: trigger.sessionId,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    enabled: trigger.enabled,
    nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
    lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
  };
}

/**
 * List the caller's agent triggers
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const userId = await requireTriggerOwner(context, spaceId);
    const store = await openSpaceStore(context.var.platform, spaceId);
    const triggers = await listAgentSchedules(store, userId);
    return jsonResponse({ triggers: triggers.map(toAgentTriggerDto) });
  }, "Failed to list agent triggers");

/**
 * Create an agent trigger
 *
 * @tag AI
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const userId = await requireTriggerOwner(context, spaceId);
    const { prompt, runAt, cronExpression, timezone, sessionId } = await parseJsonBody(
      context.req.raw,
    );

    if (typeof prompt !== "string" || !prompt.trim()) {
      throw badRequestResponse("prompt is required and must be a non-empty string");
    }
    if (sessionId !== undefined) {
      if (typeof sessionId !== "string") throw badRequestResponse("sessionId must be a string");
      // Checked again when it fires: the schedule posts as its creator.
      await requireChatSession(
        context.var.platform,
        context.var.credentials,
        spaceId,
        sessionId,
        "post",
      );
    }
    if ((runAt === undefined) === (cronExpression === undefined)) {
      throw badRequestResponse("Give exactly one of runAt and cronExpression");
    }
    if (timezone !== undefined && typeof timezone !== "string") {
      throw badRequestResponse("timezone must be a string");
    }

    let due: Date | undefined;
    if (runAt !== undefined) {
      due = typeof runAt === "string" ? new Date(runAt) : undefined;
      if (!due || Number.isNaN(due.getTime())) {
        throw badRequestResponse("runAt must be an ISO 8601 date-time");
      }
      if (due.getTime() <= Date.now()) {
        throw badRequestResponse("runAt must be in the future");
      }
    } else {
      if (typeof cronExpression !== "string") {
        throw badRequestResponse("cronExpression must be a string");
      }
      const validation = validateCronExpression(cronExpression, timezone);
      if (!validation.valid) {
        throw badRequestResponse(`Invalid cron expression: ${validation.message}`);
      }
    }

    const store = await openSpaceStore(context.var.platform, spaceId);
    const trigger = await createAgentSchedule(store, {
      prompt,
      sessionId,
      runAt: due,
      cronExpression: typeof cronExpression === "string" ? cronExpression : undefined,
      timezone,
      createdBy: userId,
    });
    return jsonResponse({ trigger: toAgentTriggerDto(trigger) });
  }, "Failed to create agent trigger");
