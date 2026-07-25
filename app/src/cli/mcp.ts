import { config } from "#config";
import {
  assertObject,
  callTool,
  expectString,
  listTools,
  parseLooseObject,
  type VektorMcpConfig,
} from "#mcp/tools.ts";
import { resolveHost, resolveSpaceId } from "./resolve.ts";

/**
 * JSON-RPC 2.0 / MCP protocol layer. Only the CLI speaks MCP over stdio, so the
 * envelope handling lives here rather than next to the tool surface it wraps.
 */

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

function createResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function createError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
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

async function handleMcpRequest(
  config: VektorMcpConfig,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  if (request.method.startsWith("notifications/")) {
    return null;
  }
  if (request.id === undefined) {
    return null;
  }

  try {
    switch (request.method) {
      case "initialize": {
        const params = assertObject(request.params ?? {}, "initialize params");
        const clientVersion =
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2024-11-05";
        const SUPPORTED_VERSIONS = ["2025-03-26", "2024-11-05"];
        const negotiatedVersion = SUPPORTED_VERSIONS.includes(clientVersion)
          ? clientVersion
          : SUPPORTED_VERSIONS[0];
        return createResult(request.id, {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "vektor-mcp",
            version: "1.0.0",
          },
        });
      }
      case "ping":
        return createResult(request.id, {});
      case "tools/list":
        return createResult(request.id, { tools: await listTools(config) });
      case "tools/call": {
        const params = assertObject(request.params, "tools/call params");
        const name =
          expectString(params, "name", { optional: true }) ??
          expectString(params, "tool", { optional: true }) ??
          expectString(params, "toolName", { optional: true });
        if (!name) {
          throw new Error("Tool name is required");
        }
        const result = await callTool(
          config,
          name,
          parseLooseObject(
            params.arguments ?? params.input ?? params.params ?? params.args,
            "tool arguments",
          ),
        );
        return createResult(request.id, formatToolResult(result));
      }
      default:
        return createError(request.id, -32601, `Method not found: ${request.method}`);
    }
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

function writeResponse(response: JsonRpcResponse | null): void {
  if (!response) return;
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function handleLine(line: string, mcpConfig: VektorMcpConfig): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    writeResponse(createParseErrorResponse());
    return;
  }

  writeResponse(await handleMcpRequest(mcpConfig, request));
}

export async function commandMcp(): Promise<void> {
  const apiUrl = resolveHost().replace(/\/+$/, "");
  const accessToken = config().CLI_ACCESS_TOKEN;
  const spaceId = await resolveSpaceId(apiUrl, accessToken);
  const mcpConfig: VektorMcpConfig = {
    apiUrl,
    spaceId,
    accessToken,
    connectedProviders: [],
  };

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(line, mcpConfig);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  await handleLine(buffer, mcpConfig);
}
