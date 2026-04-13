import type { APIContext, APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  unauthorizedResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  createJobToken,
  parseJobToken,
  verifyJobToken,
} from "../../../../../jobs/jobToken.ts";
import { config } from "../../../../../config.ts";
import {
  createParseErrorResponse,
  handleMcpRequest,
  type JsonRpcRequest,
} from "../../../../../utils/vektorMcp.ts";

function getApiOrigin(request: Request): string {
  const configured = config().API_URL;
  if (configured) {
    return new URL(configured, request.url).origin;
  }
  return new URL(request.url).origin;
}

async function resolveJobToken(context: APIContext, spaceId: string): Promise<string> {
  if (!context.locals.user) {
    const providedJobToken = context.request.headers.get("X-Job-Token");
    if (!providedJobToken || !verifyJobToken(providedJobToken, spaceId)) {
      throw unauthorizedResponse();
    }
    const parsed = parseJobToken(providedJobToken, spaceId);
    if (!parsed) {
      throw unauthorizedResponse();
    }
    return providedJobToken;
  }

  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, "viewer");
  return createJobToken(spaceId, Date.now().toString(), user.id);
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

    return jsonResponse(response);
  }, "Failed to handle MCP request");
