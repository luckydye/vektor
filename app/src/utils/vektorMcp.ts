export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type VektorMcpConfig = {
  apiUrl: string;
  spaceId: string;
  jobToken: string;
  documentId?: string;
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

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseLooseObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    const parsed = JSON.parse(trimmed) as unknown;
    return assertObject(parsed, label);
  }
  return assertObject(value, label);
}

function expectString(
  args: Record<string, unknown>,
  key: string,
  options: { optional?: boolean } = {},
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (options.optional) {
      return undefined;
    }
    throw new Error(`${key} is required`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function expectNumber(
  args: Record<string, unknown>,
  key: string,
  options: { optional?: boolean } = {},
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (options.optional) {
      return undefined;
    }
    throw new Error(`${key} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function expectObject(
  args: Record<string, unknown>,
  key: string,
  options: { optional?: boolean } = {},
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (options.optional) {
      return undefined;
    }
    throw new Error(`${key} is required`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function apiRequest(
  config: VektorMcpConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("X-Job-Token", config.jobToken);
  headers.set("X-Space-Id", config.spaceId);
  headers.set("X-Requested-With", "XMLHttpRequest");
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  const response = await fetch(new URL(path, config.apiUrl), {
    ...init,
    headers,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Vektor API ${response.status} ${response.statusText}: ${text || "empty response"}`,
    );
  }
  if (!text) {
    return null;
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  return text;
}

export async function listTools(config: VektorMcpConfig): Promise<McpTool[]> {
  return [
    {
      name: "list_documents",
      description: "List documents in current Vektor space.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          type: { type: "string" },
          categorySlugs: { type: "string" },
        },
      },
    },
    {
      name: "search_documents",
      description: "Search documents in current Vektor space.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          filters: { type: "string" },
        },
      },
    },
    {
      name: "get_document",
      description: "Get document by ID from current Vektor space.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          rev: { type: "number" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "upload_artifact",
      description:
        "Upload a file artifact to the current Vektor space. Pass raw text in content, or base64-encoded bytes with encoding=base64 for binary files.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          content: { type: "string" },
          contentType: { type: "string" },
          encoding: { type: "string", enum: ["base64"] },
          documentId: { type: "string" },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "install_extension",
      description:
        "Install or update a Vektor extension from a ZIP package. Pass base64-encoded ZIP content. The ZIP must contain manifest.json at root and dist/ with JS entry points.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          content: { type: "string" },
        },
        required: ["filename", "content"],
      },
    },
    ...(config.documentId
      ? [
          {
            name: "get_current_document",
            description: "Get current document from AI chat context.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          } satisfies McpTool,
        ]
      : []),
  ];
}

export async function callTool(config: VektorMcpConfig, name: string, rawArgs: unknown) {
  const args = assertObject(rawArgs ?? {}, "tool arguments");

  switch (name) {
    case "list_documents":
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents${buildQuery({
          limit: expectNumber(args, "limit", { optional: true }),
          offset: expectNumber(args, "offset", { optional: true }),
          type: expectString(args, "type", { optional: true }),
          categorySlugs: expectString(args, "categorySlugs", { optional: true }),
        })}`,
      );
    case "search_documents":
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/search${buildQuery({
          q: expectString(args, "q", { optional: true }),
          limit: expectNumber(args, "limit", { optional: true }),
          offset: expectNumber(args, "offset", { optional: true }),
          filters: expectString(args, "filters", { optional: true }),
        })}`,
      );
    case "get_document": {
      const documentId = expectString(args, "documentId")!;
      const rev = expectNumber(args, "rev", { optional: true });
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}${buildQuery(
          { rev },
        )}`,
      );
    }
    case "get_current_document":
      if (!config.documentId) {
        throw new Error("Current document not available");
      }
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(config.documentId)}`,
      );
    case "upload_artifact": {
      const form = new FormData();
      const filename = expectString(args, "filename")!;
      const content = expectString(args, "content")!;
      const contentType =
        expectString(args, "contentType", { optional: true }) ?? "application/octet-stream";
      const encoding = expectString(args, "encoding", { optional: true });
      const bytes =
        encoding === "base64"
          ? Buffer.from(content, "base64")
          : new TextEncoder().encode(content);
      form.set("filename", filename);
      form.set("file", new Blob([bytes], { type: contentType }), filename);
      const documentId = expectString(args, "documentId", { optional: true });
      if (documentId) {
        form.set("documentId", documentId);
      }
      return await apiRequest(config, `/api/v1/spaces/${config.spaceId}/uploads`, {
        method: "POST",
        body: form,
        headers: { Origin: new URL(config.apiUrl).origin },
      });
    }
    case "install_extension": {
      const form = new FormData();
      const filename = expectString(args, "filename")!;
      const content = expectString(args, "content")!;
      const bytes = Buffer.from(content, "base64");
      form.set("file", new Blob([bytes], { type: "application/zip" }), filename);
      return await apiRequest(config, `/api/v1/spaces/${config.spaceId}/extensions`, {
        method: "POST",
        body: form,
        headers: { Origin: new URL(config.apiUrl).origin },
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

export function createParseErrorResponse(): JsonRpcResponse {
  return createError(null, -32700, "Parse error");
}

export async function handleMcpRequest(
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
      case "initialize":
        return createResult(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "vektor-mcp",
            version: "1.0.0",
          },
        });
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
