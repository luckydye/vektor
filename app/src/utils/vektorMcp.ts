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
  if (!headers.has("Origin")) {
    headers.set("Origin", new URL(config.apiUrl).origin);
  }
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
      name: "read_document",
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
      name: "write_document",
      description:
        "Create or update a document in the current Vektor space. Omit documentId to create a new document, provide it to update an existing one. Content can be HTML or Markdown.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID to update. Omit to create a new document." },
          content: { type: "string", description: "Document content (HTML or Markdown)" },
          title: { type: "string", description: "Document title (used when creating)" },
          type: { type: "string", description: "Document type (used when creating)" },
          parentId: { type: "string", description: "Parent document ID (used when creating)" },
        },
        required: ["content"],
      },
    },
    {
      name: "delete_document",
      description:
        "Delete a document from the current Vektor space. By default archives the document (recoverable). Set permanent to true to delete permanently.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID to delete" },
          permanent: { type: "boolean", description: "Permanently delete instead of archiving" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "update_document_properties",
      description:
        "Update properties (e.g. title) on a document. Set a property value to null to remove it.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID" },
          properties: {
            type: "object",
            description: "Key-value pairs to set. Use null to delete a property.",
          },
        },
        required: ["documentId", "properties"],
      },
    },
    {
      name: "run_workflow",
      description: "Start a workflow run for a workflow document.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Workflow document ID" },
          inputs: { type: "object", description: "Runtime inputs for workflow nodes" },
          sourceExtensionId: { type: "string", description: "Extension that initiated the run" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "get_workflow_run",
      description: "Get status and outputs of a workflow run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Workflow run ID" },
        },
        required: ["runId"],
      },
    },
    {
      name: "get_workflow_log",
      description:
        "Get logs from a workflow run. Returns logs and errors for all nodes, or a specific node if nodeId is provided.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Workflow run ID" },
          nodeId: { type: "string", description: "Filter logs to a specific node" },
        },
        required: ["runId"],
      },
    },
    {
      name: "list_workflow_runs",
      description: "List workflow runs in the current Vektor space.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Filter by workflow document ID" },
          sourceExtensionId: { type: "string", description: "Filter by source extension" },
        },
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
    case "read_document": {
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
    case "write_document": {
      const documentId = expectString(args, "documentId", { optional: true });
      const content = expectString(args, "content")!;
      if (documentId) {
        return await apiRequest(
          config,
          `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Origin: new URL(config.apiUrl).origin,
            },
            body: JSON.stringify({ content }),
          },
        );
      }
      const title = expectString(args, "title", { optional: true });
      const type = expectString(args, "type", { optional: true });
      const parentId = expectString(args, "parentId", { optional: true });
      const body: Record<string, unknown> = { content };
      if (title) body.properties = { title };
      if (type) body.type = type;
      if (parentId) body.parentId = parentId;
      return await apiRequest(config, `/api/v1/spaces/${config.spaceId}/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: new URL(config.apiUrl).origin,
        },
        body: JSON.stringify(body),
      });
    }
    case "delete_document": {
      const documentId = expectString(args, "documentId")!;
      const permanent = args.permanent === true;
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}${permanent ? "?permanent=true" : ""}`,
        {
          method: "DELETE",
          headers: { Origin: new URL(config.apiUrl).origin },
        },
      );
    }
    case "update_document_properties": {
      const documentId = expectString(args, "documentId")!;
      const properties = expectObject(args, "properties")!;
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(config.apiUrl).origin,
          },
          body: JSON.stringify({ properties }),
        },
      );
    }
    case "run_workflow": {
      const documentId = expectString(args, "documentId")!;
      const inputs = expectObject(args, "inputs", { optional: true });
      const sourceExtensionId = expectString(args, "sourceExtensionId", { optional: true });
      const body: Record<string, unknown> = { documentId };
      if (inputs) body.inputs = inputs;
      if (sourceExtensionId) body.sourceExtensionId = sourceExtensionId;
      return await apiRequest(config, `/api/v1/spaces/${config.spaceId}/workflows/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: new URL(config.apiUrl).origin,
        },
        body: JSON.stringify(body),
      });
    }
    case "get_workflow_run": {
      const runId = expectString(args, "runId")!;
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/runs/${encodeURIComponent(runId)}`,
      );
    }
    case "get_workflow_log": {
      const runId = expectString(args, "runId")!;
      const nodeId = expectString(args, "nodeId", { optional: true });
      const run = (await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/runs/${encodeURIComponent(runId)}`,
      )) as { nodes: Record<string, { logs: string[]; error: string | null; status: string }> };
      if (nodeId) {
        const node = run.nodes[nodeId];
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        return { nodeId, status: node.status, error: node.error, logs: node.logs };
      }
      const result: Record<string, { status: string; error: string | null; logs: string[] }> = {};
      for (const [id, node] of Object.entries(run.nodes)) {
        if (node.logs.length > 0 || node.error) {
          result[id] = { status: node.status, error: node.error, logs: node.logs };
        }
      }
      return result;
    }
    case "list_workflow_runs": {
      const documentId = expectString(args, "documentId", { optional: true });
      const sourceExtensionId = expectString(args, "sourceExtensionId", { optional: true });
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/runs${buildQuery({ documentId, sourceExtensionId })}`,
      );
    }
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
