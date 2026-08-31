import { authenticateJobTokenOrSpaceRole, type CallerCredentials } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import type { VektorMcpConfig } from "#agent/tools.ts";
import {
  badRequestResponse,
  parseJsonBody,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { handleMcpRequest, type JsonRpcRequest, type JsonRpcResponse } from "#cli/mcp.ts";
import { getLocalOrigin } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { listOAuthIntegrationsForUser } from "#db/space/oauthIntegrations.ts";
import { createJobToken, parseJobToken } from "#jobs/jobToken.ts";

function jsonRpcResponse(body: JsonRpcResponse): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text).toString(),
    },
  });
}

/**
 * The same credentials-to-job-token bridge `chat/acp.ts` uses: a job token
 * scoped to whoever the caller's session or access token names, minted here so
 * the tools below can call back into the space's own API routes and be held to
 * that user's actual grants — never to more than a viewer already had.
 */
async function resolveMcpAuth(
  credentials: CallerCredentials,
  spaceId: string,
): Promise<{ jobToken: string; userId: string | null }> {
  const providedJobToken = credentials.jobToken;
  if (providedJobToken) {
    // Job-to-job: another job driving this space's MCP surface on someone
    // else's behalf. Verify and reuse the token as-is, rather than minting a
    // fresh one that would silently drop whatever user it carries.
    const parsed = parseJobToken(providedJobToken, spaceId);
    if (!parsed) throw unauthorizedResponse();
    return { jobToken: providedJobToken, userId: parsed.userId };
  }

  const auth = await authenticateJobTokenOrSpaceRole(
    credentials,
    spaceId,
    Permission.VIEWER,
  );
  const userId = auth.type === "user" ? auth.user.id : (auth.userId ?? null);
  return { jobToken: createJobToken(spaceId, Date.now().toString(), userId), userId };
}

/**
 * Send one MCP JSON-RPC message.
 *
 * The protocol layer is the CLI's: `#cli/mcp.ts` speaks it over stdio for the
 * `vektor mcp` command, and `handleMcpRequest` is the transport-agnostic core
 * both wrap around the same tool surface (`#agent/tools.ts`).
 *
 * The space is named by the `X-Space-Id` header, the same one
 * `chat/completions` and `chat/acp` read, since every tool this surface
 * exposes (list/read/write a document, run a workflow, …) is scoped to one.
 * Tools run with whatever access the caller's own credentials — a session, a
 * personal or space access token, or a job token already scoped to this space
 * — actually grant in it. A request with no `id` is a notification and gets a
 * bare `202`, per JSON-RPC.
 *
 * @tag AI
 * @jobToken
 * @note MCP over HTTP: one JSON-RPC 2.0 request per call, the same tool surface (list/read/write documents, run workflows, …) the CLI's `vektor mcp` speaks over stdio. Outside `/api/v1` because MCP clients expect a fixed, version-free endpoint.
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = context.req.raw.headers.get("X-Space-Id");
    if (!spaceId) {
      throw badRequestResponse("X-Space-Id header is required");
    }

    const { jobToken, userId } = await resolveMcpAuth(context.var.credentials, spaceId);

    const request = await parseJsonBody<JsonRpcRequest>(context.req.raw);
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw badRequestResponse("Expected a single JSON-RPC request object");
    }

    // A notification (no `id`) gets no reply, per JSON-RPC — there is no
    // per-connection state here for it to act on (`notifications/cancelled`
    // cancels a request on the *same* transport, and each HTTP request is its
    // own). Acknowledge receipt and drop it.
    if (!Object.hasOwn(request, "id")) {
      return new Response(null, { status: 202 });
    }

    const oauthIntegrations = userId
      ? await listOAuthIntegrationsForUser(await openSpaceStore(spaceId), userId).catch(
          () => [],
        )
      : [];

    const mcpConfig: VektorMcpConfig = {
      apiUrl: getLocalOrigin(),
      spaceId,
      jobToken,
      connectedProviders: oauthIntegrations.map((integration) => integration.provider),
    };

    return jsonRpcResponse(await handleMcpRequest(mcpConfig, request));
  }, "MCP request failed");
