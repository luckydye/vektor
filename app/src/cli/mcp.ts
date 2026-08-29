import {
  assertObject,
  callTool,
  expectString,
  listTools,
  type VektorMcpConfig,
} from "#agent/tools.ts";
import { authorizeRequest, resolveConfig, resolveCredential } from "./request.ts";

/**
 * Stateless JSON-RPC 2.0 / MCP protocol layer. Only the CLI speaks MCP over
 * stdio, so the envelope handling lives here rather than next to the tool
 * surface it wraps.
 */

const PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION];
const TOOL_LIST_CACHE_TTL_MS = 300_000;
const DISCOVER_CACHE_TTL_MS = 3_600_000;

const SERVER_INFO = {
  name: "vektor-mcp",
  version: "1.0.0",
};

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type McpRequestState = {
  // This tracks only work currently executing on the transport. It is not
  // protocol session state and is discarded when the request completes.
  activeRequestIds: Set<JsonRpcId>;
  cancelledRequestIds: Set<JsonRpcId>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

function createResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      ...assertObject(result, "MCP result"),
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": SERVER_INFO,
      },
    },
  };
}

function createError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function formatToolResult(result: unknown) {
  return {
    content: [
      {
        type: "text",
        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

function createParseErrorResponse(): JsonRpcResponse {
  return createError(null, -32700, "Parse error");
}

function createInvalidParamsError(id: JsonRpcId, message: string): JsonRpcResponse {
  return createError(id, -32602, message);
}

function validateRequestMetadata(id: JsonRpcId, params: unknown): JsonRpcResponse | null {
  let requestParams: Record<string, unknown>;
  let meta: Record<string, unknown>;
  try {
    requestParams = assertObject(params, "request params");
    meta = assertObject(requestParams._meta, "request params._meta");
  } catch (error) {
    return createInvalidParamsError(
      id,
      error instanceof Error ? error.message : String(error),
    );
  }

  const protocolVersion = meta["io.modelcontextprotocol/protocolVersion"];
  if (typeof protocolVersion !== "string") {
    return createInvalidParamsError(
      id,
      "request params._meta.io.modelcontextprotocol/protocolVersion must be a string",
    );
  }

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return createError(id, -32022, "Unsupported protocol version", {
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      requested: protocolVersion,
    });
  }

  try {
    assertObject(
      meta["io.modelcontextprotocol/clientCapabilities"],
      "request params._meta.io.modelcontextprotocol/clientCapabilities",
    );
  } catch (error) {
    return createInvalidParamsError(
      id,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (meta["io.modelcontextprotocol/clientInfo"] !== undefined) {
    try {
      const clientInfo = assertObject(
        meta["io.modelcontextprotocol/clientInfo"],
        "request params._meta.io.modelcontextprotocol/clientInfo",
      );
      expectString(clientInfo, "name");
      expectString(clientInfo, "version");
    } catch (error) {
      return createInvalidParamsError(
        id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return null;
}

function createDiscoveryResult() {
  return {
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: {
      tools: {},
    },
    ttlMs: DISCOVER_CACHE_TTL_MS,
    cacheScope: "public" as const,
  };
}

export async function handleMcpRequest(
  config: VektorMcpConfig,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return createError(null, -32600, "Invalid Request");
  }
  if (typeof request.id !== "string" && typeof request.id !== "number") {
    return createError(null, -32600, "Request ID must be a string or number");
  }

  const metadataError = validateRequestMetadata(request.id, request.params);
  if (metadataError) return metadataError;

  switch (request.method) {
    case "server/discover": {
      const params = assertObject(request.params, "server/discover params");
      if (Object.keys(params).some((key) => key !== "_meta")) {
        return createInvalidParamsError(
          request.id,
          "server/discover accepts no parameters other than _meta",
        );
      }
      return createResult(request.id, createDiscoveryResult());
    }
    case "tools/list": {
      const params = assertObject(request.params, "tools/list params");
      if (Object.keys(params).some((key) => key !== "_meta" && key !== "cursor")) {
        return createInvalidParamsError(
          request.id,
          "tools/list contains an unknown parameter",
        );
      }
      if (params.cursor !== undefined) {
        if (typeof params.cursor !== "string") {
          return createInvalidParamsError(
            request.id,
            "tools/list cursor must be a string",
          );
        }
        return createInvalidParamsError(request.id, "Invalid tools/list cursor");
      }
      const tools = await listTools(config);
      tools.sort((left, right) => left.name.localeCompare(right.name));
      return createResult(request.id, {
        tools,
        ttlMs: TOOL_LIST_CACHE_TTL_MS,
        cacheScope: "private",
      });
    }
    case "tools/call": {
      let name: string;
      let args: Record<string, unknown>;
      try {
        const params = assertObject(request.params, "tools/call params");
        const allowedParams = new Set([
          "_meta",
          "arguments",
          "inputResponses",
          "name",
          "requestState",
        ]);
        if (Object.keys(params).some((key) => !allowedParams.has(key))) {
          return createInvalidParamsError(
            request.id,
            "tools/call contains an unknown parameter",
          );
        }
        name = expectString(params, "name");
        args =
          params.arguments === undefined
            ? {}
            : assertObject(params.arguments, "tools/call arguments");
      } catch (error) {
        return createInvalidParamsError(
          request.id,
          error instanceof Error ? error.message : String(error),
        );
      }

      const tools = await listTools(config);
      if (!tools.some((tool) => tool.name === name)) {
        return createInvalidParamsError(request.id, `Unknown tool: ${name}`);
      }

      try {
        const result = await callTool(config, name, args);
        return createResult(request.id, formatToolResult(result));
      } catch (error) {
        return createResult(request.id, {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        });
      }
    }
    default:
      return createError(request.id, -32601, `Method not found: ${request.method}`);
  }
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function handleCancelledNotification(
  params: unknown,
  requestState: McpRequestState,
): void {
  try {
    const requestId = assertObject(params, "cancelled notification params").requestId;
    if (
      (typeof requestId === "string" || typeof requestId === "number") &&
      requestState.activeRequestIds.has(requestId)
    ) {
      requestState.cancelledRequestIds.add(requestId);
    }
  } catch {
    // Notifications never receive responses, including malformed cancellations.
  }
}

async function handleLine(
  line: string,
  mcpConfig: VektorMcpConfig,
  requestState: McpRequestState,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    writeResponse(createParseErrorResponse());
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeResponse(createError(null, -32600, "Invalid Request"));
    return;
  }

  const request = parsed as JsonRpcRequest;
  if (!Object.hasOwn(parsed, "id")) {
    if (request.jsonrpc === "2.0" && request.method === "notifications/cancelled") {
      handleCancelledNotification(request.params, requestState);
    }
    return;
  }

  if (typeof request.id !== "string" && typeof request.id !== "number") {
    writeResponse(createError(null, -32600, "Request ID must be a string or number"));
    return;
  }

  requestState.activeRequestIds.add(request.id);
  try {
    const response = await handleMcpRequest(mcpConfig, request);
    if (!requestState.cancelledRequestIds.delete(request.id)) {
      writeResponse(response);
    }
  } catch {
    if (!requestState.cancelledRequestIds.delete(request.id)) {
      writeResponse(createError(request.id, -32603, "Internal error"));
    }
  } finally {
    requestState.activeRequestIds.delete(request.id);
  }
}

export async function commandMcp(): Promise<void> {
  const { host, spaceId } = await resolveConfig();
  const credential = await resolveCredential();
  const mcpConfig: VektorMcpConfig = {
    apiUrl: host,
    spaceId,
    ...(credential.kind === "token"
      ? { accessToken: credential.token }
      : // No token to hand over: the key signs each request as it goes out.
        { authorize: (request) => authorizeRequest(request, credential) }),
    connectedProviders: [],
  };

  const decoder = new TextDecoder();
  let buffer = "";
  const requestState: McpRequestState = {
    activeRequestIds: new Set(),
    cancelledRequestIds: new Set(),
  };
  const pending = new Set<Promise<void>>();

  function handleNextLine(line: string): void {
    const handling = handleLine(line, mcpConfig, requestState);
    pending.add(handling);
    void handling.finally(() => pending.delete(handling));
  }

  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleNextLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  handleNextLine(buffer);
  await Promise.all(pending);
}
