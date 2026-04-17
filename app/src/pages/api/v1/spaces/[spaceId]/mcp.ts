import type { APIContext, APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  unauthorizedResponse,
  verifySpaceRole,
  withApiErrorHandling,
  authenticateWithToken,
} from "#db/api.ts";
import {
  createJobToken,
  parseJobToken,
  verifyJobToken,
} from "../../../../../jobs/jobToken.ts";
import { getTokenUserId } from "../../../../../db/accessTokens.ts";
import { config } from "../../../../../config.ts";
import {
  createParseErrorResponse,
  handleMcpRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../../../../utils/vektorMcp.ts";

function getApiOrigin(request: Request): string {
  // Use the request's own origin for internal API calls — avoids routing
  // back through a reverse proxy (nginx) which may block loopback requests.
  return new URL(request.url).origin;
}

async function resolveJobToken(context: APIContext, spaceId: string): Promise<string> {
  // 1. X-Job-Token header (internal calls from agent workers)
  const providedJobToken = context.request.headers.get("X-Job-Token");
  if (providedJobToken) {
    const parsed = parseJobToken(providedJobToken, spaceId);
    if (!parsed) throw unauthorizedResponse();
    return providedJobToken;
  }

  // 2. Access token (Bearer at_... or at_...)
  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    const userId = getTokenUserId(tokenResult.tokenId);
    return createJobToken(spaceId, Date.now().toString(), userId);
  }

  // 3. Session cookie
  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, "viewer");
  return createJobToken(spaceId, Date.now().toString(), user.id);
}

/** Verify caller has at least viewer access to the space. */
async function requireSpaceAuth(context: APIContext, spaceId: string): Promise<void> {
  const jobToken = context.request.headers.get("X-Job-Token");
  if (jobToken) {
    if (!parseJobToken(jobToken, spaceId)) throw unauthorizedResponse();
    return;
  }

  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) return;

  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, "viewer");
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function sseResponse(data: JsonRpcResponse): Response {
  const body = `event: message\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const body = await context.request.text();

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = JSON.parse(body) as JsonRpcRequest;
    } catch {
      return jsonResponse(createParseErrorResponse());
    }

    const response = await handleMcpRequest(
      {
        apiUrl: getApiOrigin(context.request),
        spaceId,
        jobToken: await resolveJobToken(context, spaceId),
        documentId:
          context.request.headers.get("X-Vektor-Document-Id")?.trim() || undefined,
      },
      rpcRequest,
    );

    if (!response) {
      return new Response(null, { status: 204 });
    }

    const accept = context.request.headers.get("Accept") ?? "";
    const wantsSSE = accept.includes("text/event-stream");

    const sessionId =
      context.request.headers.get("Mcp-Session-Id") ?? generateSessionId();

    if (wantsSSE) {
      const res = sseResponse(response);
      res.headers.set("Mcp-Session-Id", sessionId);
      return res;
    }

    const res = jsonResponse(response);
    res.headers.set("Mcp-Session-Id", sessionId);
    return res;
  }, "Failed to handle MCP request");

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await requireSpaceAuth(context, spaceId);

    const sessionId = context.request.headers.get("Mcp-Session-Id");
    if (!sessionId) {
      return new Response("Mcp-Session-Id header required", { status: 400 });
    }

    const stream = new ReadableStream({
      start(controller) {
        const keepAlive = setInterval(() => {
          controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
        }, 15_000);
        context.request.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Mcp-Session-Id": sessionId,
      },
    });
  }, "Failed to open MCP SSE stream");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    await requireSpaceAuth(context, spaceId);

    const sessionId = context.request.headers.get("Mcp-Session-Id");
    if (!sessionId) {
      return new Response("Mcp-Session-Id header required", { status: 400 });
    }
    return new Response(null, { status: 204 });
  }, "Failed to close MCP session");
