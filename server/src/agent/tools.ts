/**
 * The Vektor MCP tool surface: the tool catalogue plus the HTTP calls that back
 * it. Shared by two consumers — the in-app agent loop (`#agent/core.ts`), which
 * calls the tools directly, and the CLI's stdio MCP server (`#cli/mcp.ts`),
 * which wraps them in JSON-RPC. Nothing here knows about JSON-RPC.
 */

import { readWorkflowRunLogLines } from "#utils/workflowRunLogs.ts";

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
  jobToken?: string;
  accessToken?: string;
  documentId?: string;
  connectedProviders?: string[];
};

export function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function expectString(args: Record<string, unknown>, key: string): string;
export function expectString(
  args: Record<string, unknown>,
  key: string,
  options: { optional: true },
): string | undefined;
export function expectString(
  args: Record<string, unknown>,
  key: string,
  options: { optional?: boolean } = {},
): string | undefined {
  const value = args[key];
  // Models without strict schemas fill unused optional fields with "".
  if (value === undefined || value === null || (options.optional && value === "")) {
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

function expectNumber(args: Record<string, unknown>, key: string): number;
function expectNumber(
  args: Record<string, unknown>,
  key: string,
  options: { optional: true },
): number | undefined;
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
): Record<string, unknown>;
function expectObject(
  args: Record<string, unknown>,
  key: string,
  options: { optional: true },
): Record<string, unknown> | undefined;
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
  if (config.jobToken) {
    headers.set("X-Job-Token", config.jobToken);
  } else if (config.accessToken) {
    headers.set("Authorization", `Bearer ${config.accessToken}`);
  }
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
      description:
        "List documents in the current Vektor space, newest first. " +
        "Pass nextCursor from a prior result as cursor to fetch the next page.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Documents per page, 1 to 5000 (default 100).",
          },
          cursor: {
            type: "string",
            description:
              "nextCursor returned by a previous list_documents call. Omit for the first page.",
          },
          type: {
            type: "string",
            description:
              'Only documents of this type, e.g. "database", "record" (a database row), "canvas", "workflow". Ignored with parentId.',
          },
          parentId: {
            type: "string",
            description:
              "List the direct children of this document, e.g. a database's rows.",
          },
          categorySlugs: {
            type: "string",
            description:
              "Comma-separated category slugs. Returns every match in one page: limit, cursor and parentId are ignored.",
          },
          properties: {
            type: "array",
            items: { type: "string" },
            description:
              'Properties to include for each document, e.g. ["Start","End"]; none are returned without this. Ask only for what the answer needs.',
          },
        },
      },
    },
    {
      name: "search_documents",
      description:
        "Search the current Vektor space by text (q), property filters, parent, or any combination; at least one is required. " +
        "Date ranges over properties (e.g. a database's date column) go in filters, not in q. " +
        'Results can include uploaded files (type "file", id is the file path, fileUrl set), which read_document cannot open.',
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search text." },
          limit: {
            type: "number",
            description: "Results per page, 1 to 100 (default 20).",
          },
          cursor: {
            type: "string",
            description:
              "nextCursor returned by a previous search_documents call. Omit for the first page.",
          },
          parentId: {
            type: "string",
            description: "Only direct children of this document, e.g. a database's rows.",
          },
          properties: {
            type: "array",
            items: { type: "string" },
            description:
              'Properties to include for each document, e.g. ["Start","End"]; none are returned without this. Ask only for what the answer needs.',
          },
          filters: {
            type: "array",
            description:
              "All must match. {key, value} matches a property equal to value, ignoring case; a list property matches if any item does; " +
              "null matches any non-empty value. " +
              "{key, from, before} matches a property whose value is a date at or after from and before before; either bound may be omitted. " +
              'Bounds are dates like "2026-09-28" or "2026-09-28T09:00:00+02:00". ' +
              'Reserved keys (value only): "_type" is the document type, "_date" the last update: "today", "week", "month", "older" or "2026-09-01/2026-09-30".',
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: ["string", "null"] },
                from: { type: "string" },
                before: { type: "string" },
              },
              required: ["key"],
            },
          },
        },
      },
    },
    {
      name: "read_document",
      description:
        "Read a document by ID or slug. Without rev it returns {document, space} with the live draft, one HTML block per line " +
        "(the line numbers edit_document uses); this needs editor access. A database also returns its columns. " +
        "Output past about 6000 characters is cut in the middle.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          properties: {
            type: "array",
            items: { type: "string" },
            description:
              'Hidden "_"-prefixed properties to include, e.g. ["_schema"]; the others are always returned.',
          },
          rev: {
            type: "number",
            description:
              "Historical revision (1 or higher); returns {revision: {rev, content}}. Omit to read the live draft.",
          },
        },
        required: ["documentId"],
      },
    },
    {
      name: "write_document",
      description:
        "Create or replace a document in the current Vektor space. Omit documentId to create, or provide it to replace the complete stored content (a new revision). Markdown is not converted: send HTML.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description: "Document ID to update. Omit to create a new document.",
          },
          content: {
            type: "string",
            description:
              "Complete stored content: HTML for ordinary documents and records (sanitized), complete HTML for app, canvas JSON ({shapes, strokes}) for canvas, script source for workflow.",
          },
          title: { type: "string", description: "Document title (create only)" },
          type: { type: "string", description: "Document type (create only)" },
          parentId: {
            type: "string",
            description:
              'Parent document ID (create only). A database only takes children of type "record".',
          },
        },
        required: ["content"],
      },
    },
    {
      name: "edit_document",
      description:
        "Apply partial edit operations to a document. Edits go through the collaboration channel, so they merge with concurrent changes from other users instead of overwriting them. Line operations (insert/replace/delete) edit HTML/text content by 1-based line numbers; json operations (set/unset/push) edit JSON content via simplified jq paths like .a.b[0].",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID to edit" },
          operations: {
            type: "array",
            description:
              "Applied in order; any failing op rejects the whole batch. " +
              'Line ops (1-based, inclusive, "$" = last line): {op:"insert", line:"5"|"$", content} inserts before line 5 ("$": after the last line), ' +
              '{op:"replace", range:"10:14", content}, {op:"delete", range:"3" or "3:$"}. ' +
              'Regex: {op:"sub", pattern, replacement} (JS regex, flags gs, $1 allowed, replacement defaults to ""; fails if the content is unchanged). ' +
              'JSON ops: {op:"set", path:".a.b[0]", value} (the parent must exist), {op:"unset", path} (must exist), {op:"push", path, value} (onto an existing array).',
            items: { type: "object" },
          },
        },
        required: ["documentId", "operations"],
      },
    },
    {
      name: "delete_document",
      description:
        "Delete a document from the current Vektor space. By default archives the document (recoverable). Set permanent to true to delete permanently, which needs owner permission.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID to delete" },
          permanent: {
            type: "boolean",
            description: "Permanently delete instead of archiving",
          },
        },
        required: ["documentId"],
      },
    },
    {
      name: "update_document_properties",
      description:
        "Update properties (e.g. title) on a document. Keys match ignoring case.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Document ID" },
          properties: {
            type: "object",
            description:
              'Key-value pairs. Values are stored as strings or string lists; {value, type} also sets a type, e.g. {value:"2026-10-01", type:"date"}. null deletes the property.',
          },
        },
        required: ["documentId", "properties"],
      },
    },
    {
      name: "run_workflow",
      description:
        "Start a run of a workflow document. Returns {runId} immediately; poll get_workflow_run for its status.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Workflow document ID" },
          inputs: {
            type: "object",
            description: "Runtime inputs for the workflow script",
          },
          sourceExtensionId: {
            type: "string",
            description: "Extension that initiated the run",
          },
        },
        required: ["documentId"],
      },
    },
    {
      name: "get_workflow_run",
      description: "Get status and result artifact reference for a workflow run.",
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
      description: "Get the script log and terminal error from a workflow run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Workflow run ID" },
        },
        required: ["runId"],
      },
    },
    {
      name: "list_workflow_runs",
      description:
        "List a cursor-paginated page of recent workflow-run history in the current space.",
      inputSchema: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description: "Filter run history to this workflow document ID.",
          },
          sourceExtensionId: {
            type: "string",
            description: "Filter by source extension",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum runs to return (default 20, maximum 200)",
          },
          cursor: {
            type: "string",
            description: "Cursor returned by the previous page",
          },
        },
      },
    },
    // The schedule routes need a signed-in user; a job token is rejected, so the
    // in-app agent never sees tools it cannot call.
    ...(config.jobToken
      ? []
      : ([
          {
            name: "schedule_workflow",
            description:
              "Create a cron schedule that runs a workflow document on a recurring basis. " +
              "cronExpression is a standard 5-field expression (minute hour day month weekday), " +
              'e.g. "*/5 * * * *" for every 5 minutes — minute resolution is the finest cron ' +
              'cadence supported. For a cadence faster than a minute (e.g. "poll every 10 ' +
              'seconds"), loop with a delay inside the workflow script itself instead of trying ' +
              "to express that in cronExpression.",
            inputSchema: {
              type: "object",
              properties: {
                documentId: {
                  type: "string",
                  description: "Workflow document ID to run",
                },
                cronExpression: {
                  type: "string",
                  description: 'Standard 5-field cron expression, e.g. "0 6 * * 1"',
                },
                timezone: {
                  type: "string",
                  description:
                    'IANA timezone for evaluating the expression, e.g. "Europe/Berlin". Defaults to the server\'s local time.',
                },
                inputs: {
                  type: "object",
                  description: "Runtime inputs passed to the workflow script on each run",
                },
                enabled: {
                  type: "boolean",
                  description: "Whether the schedule is active (default true)",
                },
              },
              required: ["documentId", "cronExpression"],
            },
          },
          {
            name: "list_workflow_schedules",
            description:
              "List cron schedules for workflow documents in the current space.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "delete_workflow_schedule",
            description: "Delete a workflow cron schedule. Run history is preserved.",
            inputSchema: {
              type: "object",
              properties: {
                scheduleId: { type: "string", description: "Schedule ID to delete" },
              },
              required: ["scheduleId"],
            },
          },
        ] satisfies McpTool[])),
    {
      name: "get_documentation",
      description:
        "Get Vektor documentation for a specific section (api, extensions, permissions) as raw markdown.",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: ["api", "extensions", "permissions"],
            description: "The documentation section to retrieve.",
          },
        },
        required: ["section"],
      },
    },
    ...(() => {
      // Providers are contributed by installed extensions, so the enum is the
      // set this user has actually connected — there is no built-in list.
      const providers = config.connectedProviders ?? [];
      if (providers.length === 0) return [];
      return [
        {
          name: "integration_api_request",
          description:
            "Call a connected integration's API using the current user's OAuth token. " +
            "Returns {ok, status, statusText, headers, body}; upstream errors are not raised, so check ok and status.",
          inputSchema: {
            type: "object",
            properties: {
              provider: { type: "string", enum: providers },
              method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
                description: "Default GET.",
              },
              path: {
                type: "string",
                description:
                  "Path relative to the provider's API base path, with any query string.",
              },
              headers: {
                type: "object",
                description: "Only Accept and Content-Type are forwarded.",
              },
              body: {
                type: "string",
                description: "Request body; ignored for GET and DELETE.",
              },
            },
            required: ["provider", "path"],
          },
        } satisfies McpTool,
      ];
    })(),
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

export async function uploadFile(
  config: VektorMcpConfig,
  options: {
    filename: string;
    contentBase64: string;
    contentType?: string;
    documentId?: string;
  },
) {
  const bytes = Buffer.from(options.contentBase64, "base64");
  const query = new URLSearchParams({ filename: options.filename });
  if (options.documentId) {
    query.set("documentId", options.documentId);
  }
  return await apiRequest(config, `/api/v1/spaces/${config.spaceId}/uploads?${query}`, {
    method: "POST",
    body: bytes,
    headers: {
      Origin: new URL(config.apiUrl).origin,
      "Content-Type": options.contentType ?? "application/octet-stream",
    },
  });
}

export async function installExtension(
  config: VektorMcpConfig,
  options: { filename: string; contentBase64: string },
) {
  const form = new FormData();
  const bytes = Buffer.from(options.contentBase64, "base64");
  form.set("file", new Blob([bytes], { type: "application/zip" }), options.filename);
  return await apiRequest(config, `/api/v1/spaces/${config.spaceId}/extensions`, {
    method: "POST",
    body: form,
    headers: { Origin: new URL(config.apiUrl).origin },
  });
}

/** The fields a listing needs: full records are ~800 characters each and crowd out the page. */
/**
 * A listing is pointers: properties only when asked for by name. `request` also
 * drops what the caller already knows: the parent it asked for, and the
 * snippet, which without a query is only the start of the raw body.
 */
function summarizeDocument(
  doc: Record<string, unknown>,
  request: { parentId?: string; hasQuery: boolean; properties?: string[] },
) {
  const { title, ...properties } = doc.properties as Record<string, unknown>;
  const wanted = new Set(request.properties?.map((key) => key.toLowerCase()));
  return {
    id: doc.id,
    title: title ?? doc.slug,
    type: doc.type ?? "document",
    parentId: request.parentId ? undefined : (doc.parentId ?? undefined),
    updatedAt: doc.updatedAt,
    properties:
      wanted.size > 0
        ? Object.fromEntries(
            Object.entries(properties).filter(([key]) => wanted.has(key.toLowerCase())),
          )
        : undefined,
    snippet: request.hasQuery ? doc.snippet || undefined : undefined,
    fileUrl: doc.fileUrl,
  };
}

/** Whether a property key is app-internal (`_schema`, `_kanban`, …) rather than content. */
function isHiddenProperty(key: string): boolean {
  return key.startsWith("_");
}

/** Drops hidden properties from each document in a response, except the named ones. */
function hideInternalProperties(response: unknown, requested: string[] = []): unknown {
  if (!response || typeof response !== "object") return response;
  const keep = new Set(requested.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(response).map(([key, value]) => {
      const properties = (value as { properties?: unknown } | null)?.properties;
      if (!properties || typeof properties !== "object") return [key, value];
      return [
        key,
        {
          ...value,
          properties: Object.fromEntries(
            Object.entries(properties).filter(
              ([name]) => !isHiddenProperty(name) || keep.has(name.toLowerCase()),
            ),
          ),
        },
      ];
    }),
  );
}

/**
 * A database's columns: its `_schema`, or, when it declares none, the keys its
 * rows hold, as the database view derives them.
 */
async function databaseColumns(
  config: VektorMcpConfig,
  database: { id: string; properties: Record<string, unknown> },
): Promise<Array<{ name: string; type: string | null }>> {
  const schema = database.properties._schema;
  const declared =
    typeof schema === "string" && schema
      ? ((JSON.parse(schema) as { columns?: Array<{ name: string; type: string }> })
          .columns ?? [])
      : [];
  if (declared.length > 0) return declared.map(({ name, type }) => ({ name, type }));

  const { properties } = (await apiRequest(
    config,
    `/api/v1/spaces/${config.spaceId}/properties${buildQuery({ parentId: database.id })}`,
  )) as { properties: Array<{ name: string; type: string | null }> };
  return properties.filter(
    ({ name }) => !isHiddenProperty(name) && name.toLowerCase() !== "title",
  );
}

function expectStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value;
}

export async function callTool(config: VektorMcpConfig, name: string, rawArgs: unknown) {
  const args = assertObject(rawArgs ?? {}, "tool arguments");

  switch (name) {
    case "list_documents": {
      const parentId = expectString(args, "parentId", { optional: true });
      const properties = expectStringArray(args, "properties");
      const response = (await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents${buildQuery({
          limit: expectNumber(args, "limit", { optional: true }) ?? 100,
          cursor: expectString(args, "cursor", { optional: true }),
          type: expectString(args, "type", { optional: true }),
          parentId,
          categorySlugs: expectString(args, "categorySlugs", { optional: true }),
        })}`,
      )) as { documents: Array<Record<string, unknown>>; nextCursor: string | null };
      return {
        documents: response.documents.map((doc) =>
          summarizeDocument(doc, { parentId, hasQuery: false, properties }),
        ),
        nextCursor: response.nextCursor,
      };
    }
    case "search_documents": {
      const q = expectString(args, "q", { optional: true });
      const parentId = expectString(args, "parentId", { optional: true });
      const properties = expectStringArray(args, "properties");
      const response = (await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/search${buildQuery({
          q,
          limit: expectNumber(args, "limit", { optional: true }),
          cursor: expectString(args, "cursor", { optional: true }),
          parentId,
          filters: args.filters === undefined ? undefined : JSON.stringify(args.filters),
        })}`,
      )) as { results: Array<Record<string, unknown>>; nextCursor: string | null };
      return {
        results: response.results.map((doc) =>
          summarizeDocument(doc, { parentId, hasQuery: q !== undefined, properties }),
        ),
        nextCursor: response.nextCursor,
      };
    }
    case "read_document": {
      const documentId = expectString(args, "documentId");
      const rev = expectNumber(args, "rev", { optional: true });
      // Without an explicit revision, read the live draft content (including
      // unsaved changes in the collaboration room) so partial edits via
      // edit_document reference the same state.
      const response = (await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}${buildQuery(
          rev !== undefined ? { rev } : { live: "true" },
        )}`,
      )) as {
        document?: { id: string; type?: string; properties: Record<string, unknown> };
      };
      const visible = hideInternalProperties(
        response,
        expectStringArray(args, "properties"),
      );
      return response.document?.type === "database"
        ? {
            ...(visible as object),
            columns: await databaseColumns(config, response.document),
          }
        : visible;
    }
    case "get_current_document":
      if (!config.documentId) {
        throw new Error("Current document not available");
      }
      return hideInternalProperties(
        await apiRequest(
          config,
          `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(config.documentId)}?live=true`,
        ),
      );
    case "write_document": {
      const documentId = expectString(args, "documentId", { optional: true });
      const content = expectString(args, "content");
      if (documentId) {
        return hideInternalProperties(
          await apiRequest(
            config,
            `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Origin: new URL(config.apiUrl).origin,
              },
              body: JSON.stringify({
                content,
              }),
            },
          ),
        );
      }
      const title = expectString(args, "title", { optional: true });
      const type = expectString(args, "type", { optional: true });
      const parentId = expectString(args, "parentId", { optional: true });
      const body: Record<string, unknown> = { content };
      if (title) body.properties = { title };
      if (type) {
        body.type = type;
      }
      if (parentId) body.parentId = parentId;
      return hideInternalProperties(
        await apiRequest(config, `/api/v1/spaces/${config.spaceId}/documents`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(config.apiUrl).origin,
          },
          body: JSON.stringify(body),
        }),
      );
    }
    case "edit_document": {
      const documentId = expectString(args, "documentId");
      const operations = args.operations;
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new Error("operations must be a non-empty array");
      }
      return hideInternalProperties(
        await apiRequest(
          config,
          `/api/v1/spaces/${config.spaceId}/documents/${encodeURIComponent(documentId)}/edit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: new URL(config.apiUrl).origin,
            },
            body: JSON.stringify({ operations }),
          },
        ),
      );
    }
    case "delete_document": {
      const documentId = expectString(args, "documentId");
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
      const documentId = expectString(args, "documentId");
      const properties = expectObject(args, "properties");
      // The keys being written are the ones the caller asked about.
      return hideInternalProperties(
        await apiRequest(
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
        ),
        Object.keys(properties),
      );
    }
    case "run_workflow": {
      const documentId = expectString(args, "documentId");
      const inputs = expectObject(args, "inputs", { optional: true });
      const sourceExtensionId = expectString(args, "sourceExtensionId", {
        optional: true,
      });
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
      const runId = expectString(args, "runId");
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/runs/${encodeURIComponent(runId)}`,
      );
    }
    case "get_workflow_log": {
      const runId = expectString(args, "runId");
      const run = (await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/runs/${encodeURIComponent(runId)}`,
      )) as {
        runId: string;
        createdAt: string;
        status: string;
        error: string | null;
      };
      const logs = await readWorkflowRunLogLines(
        (path) => apiRequest(config, path),
        config.spaceId,
        run,
      );
      return { status: run.status, error: run.error, logs };
    }
    case "list_workflow_runs": {
      const documentId = expectString(args, "documentId", { optional: true });
      const sourceExtensionId = expectString(args, "sourceExtensionId", {
        optional: true,
      });
      const limit = expectNumber(args, "limit", { optional: true });
      const cursor = expectString(args, "cursor", { optional: true });
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/runs${buildQuery({
          filterDocumentId: documentId,
          sourceExtensionId,
          limit,
          cursor,
        })}`,
      );
    }
    case "schedule_workflow": {
      const documentId = expectString(args, "documentId");
      const cronExpression = expectString(args, "cronExpression");
      const timezone = expectString(args, "timezone", { optional: true });
      const inputs = expectObject(args, "inputs", { optional: true });
      const enabled = typeof args.enabled === "boolean" ? args.enabled : undefined;
      const body: Record<string, unknown> = { documentId, cronExpression };
      if (timezone) body.timezone = timezone;
      if (inputs) body.inputs = inputs;
      if (enabled !== undefined) body.enabled = enabled;
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/schedules`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(config.apiUrl).origin,
          },
          body: JSON.stringify(body),
        },
      );
    }
    case "list_workflow_schedules": {
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/schedules`,
      );
    }
    case "delete_workflow_schedule": {
      const scheduleId = expectString(args, "scheduleId");
      return await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/workflows/schedules/${encodeURIComponent(scheduleId)}`,
        { method: "DELETE", headers: { Origin: new URL(config.apiUrl).origin } },
      );
    }
    case "get_documentation": {
      const section = expectString(args, "section");
      return await apiRequest(config, `/docs/${section}.md`);
    }
    case "integration_api_request": {
      const provider = expectString(args, "provider");
      const path = expectString(args, "path");
      const method = expectString(args, "method", { optional: true });
      const headers = expectObject(args, "headers", { optional: true });
      const body = expectString(args, "body", { optional: true });
      const response = (await apiRequest(
        config,
        `/api/v1/spaces/${config.spaceId}/integrations/${encodeURIComponent(provider)}/proxy`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(config.apiUrl).origin,
          },
          body: JSON.stringify({ method, path, headers, body }),
        },
      )) as { headers: Record<string, string>; body: string };
      // A JSON body as a string escapes every quote and newline a second time.
      const isJson = response.headers["content-type"]?.includes("json") && response.body;
      return isJson ? { ...response, body: JSON.parse(response.body) } : response;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
