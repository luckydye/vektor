/**
 * /api/v1/spaces/:spaceId/nodes/tasks/:taskId/messages
 *
 * The mailbox of an agent running on a node, for the `read_messages` and
 * `send_message` tools of its MCP server. Only the job token minted for the
 * task's own user reaches it.
 *
 * GET:  take the messages other agents sent to this one
 * POST: send a message to the parent agent (`to: "parent"`) or a sibling sub-agent
 *
 * Body: { to: string, message: string }
 */

import { authenticateJobTokenOrSpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { nodeRegistry } from "#agent/nodes/registry.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";

async function mailboxOf(context: ApiContext) {
  const spaceId = requireParam(context.var.params, "spaceId");
  const taskId = requireParam(context.var.params, "taskId");
  const auth = await authenticateJobTokenOrSpaceRole(
    context.var.platform,
    context.var.credentials,
    spaceId,
    Permission.VIEWER,
  );
  const userId = auth.type === "user" ? auth.user.id : auth.userId;
  try {
    return nodeRegistry.forAgent(taskId, { spaceId, userId });
  } catch {
    throw notFoundResponse("Remote task");
  }
}

/**
 * Read an agent's messages
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const mailbox = await mailboxOf(context);
    return jsonResponse({ messages: mailbox.readMessages() });
  }, "Failed to read messages");

/**
 * Send a message from an agent
 *
 * @tag AI
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const mailbox = await mailboxOf(context);
    const { to, message } = await parseJsonBody(context.req.raw);
    if (typeof to !== "string" || !to || typeof message !== "string" || !message.trim()) {
      throw badRequestResponse("to and message are required strings");
    }
    try {
      mailbox.sendMessage(to, message);
    } catch (error) {
      throw badRequestResponse(error instanceof Error ? error.message : String(error));
    }
    return jsonResponse({ ok: true });
  }, "Failed to send message");
