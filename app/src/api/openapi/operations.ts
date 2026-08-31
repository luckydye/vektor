import type { QueryParameterDoc, RouteDoc } from "./types.ts";

/** The cursor-paging parameters every listing route accepts. */
const PAGINATION: QueryParameterDoc[] = [
  {
    name: "limit",
    description: "Page size.",
    schema: { type: "integer", minimum: 1 },
  },
  {
    name: "cursor",
    description: "Opaque cursor from the previous page's `nextCursor`.",
  },
];

/**
 * What each registered route pattern is, in the words of whoever reads the
 * schema rather than the code. The generator in `document.ts` derives
 * everything mechanical — paths, path parameters, security, error responses —
 * from the route registry itself; this table is only the part no machine can
 * infer.
 *
 * Every pattern in `apiRoutes` needs an entry (`openapi.spec.ts` fails when one
 * is missing), and every method listed here must be one the route module
 * actually serves.
 */
export const routeDocs: Record<string, RouteDoc> = {
  "/.well-known/caldav": {
    tag: "CalDAV",
    description:
      "CalDAV service discovery. Also answers the WebDAV methods (PROPFIND) that OpenAPI cannot describe.",
    public: true,
    operations: {
      OPTIONS: "Advertise CalDAV support",
    },
  },

  "/.well-known/vektor": {
    tag: "Discovery",
    public: true,
    operations: {
      GET: {
        summary: "Instance discovery document",
        description:
          "Identifies the server as a Vektor instance and names the API version it speaks.",
        response: {
          type: "object",
          properties: {
            service: { type: "string", const: "vektor" },
            version: { type: "integer" },
            apiVersion: { type: "string" },
            documentEndpoint: { type: "string" },
            openapiEndpoint: { type: "string" },
          },
        },
      },
      OPTIONS: "CORS preflight for the discovery document",
    },
  },

  "/[spaceSlug]/git/[repo]/[...gitPath]": {
    tag: "Git",
    description:
      "Git smart HTTP for a repository document. This is the clone URL, so it lives outside `/api`.",
    params: {
      spaceSlug: "Slug of the space the repository belongs to.",
      repo: "Repository document slug.",
      gitPath: "Remaining smart-HTTP path, e.g. `info/refs` or `git-upload-pack`.",
    },
    operations: {
      GET: "Git smart HTTP reference discovery",
      POST: "Git smart HTTP upload-pack / receive-pack",
    },
  },

  "/api/auth/[...all]": {
    tag: "Auth",
    description:
      "The better-auth handler. Its own endpoints (sign-in, sign-up, callbacks, sign-out) live under this prefix and are documented by better-auth.",
    public: true,
    params: { all: "better-auth sub-path." },
    operations: {
      GET: "better-auth endpoint",
      POST: "better-auth endpoint",
    },
  },

  "/api/v1/auth/cli": {
    tag: "Auth",
    description: "CLI pairing, authenticated by the one-time code it mints.",
    public: true,
    operations: {
      GET: "Poll a pending CLI login",
      POST: "Start a CLI login and mint a pairing code",
    },
  },

  "/api/v1/auth/cli/token": {
    tag: "Auth",
    public: true,
    operations: {
      POST: "Exchange a paired CLI code for an access token",
    },
  },

  "/api/v1/chat/acp": {
    tag: "AI",
    jobToken: true,
    operations: {
      POST: "Run an agent turn over the Agent Client Protocol",
    },
  },

  "/api/mcp": {
    tag: "AI",
    jobToken: true,
    description:
      "MCP over HTTP: one JSON-RPC 2.0 request per call, the same tool surface (list/read/write documents, run workflows, …) the CLI's `vektor mcp` speaks over stdio. Outside `/api/v1` because MCP clients expect a fixed, version-free endpoint.",
    operations: {
      POST: {
        summary: "Send one MCP JSON-RPC message",
        description:
          "The space is named by the `X-Space-Id` header; tools run with whatever access the caller's own credentials grant in it. A request with no `id` is a notification and gets a bare `202`, per JSON-RPC.",
        requestBody: {
          type: "object",
          required: ["jsonrpc", "method"],
          properties: {
            jsonrpc: { type: "string", const: "2.0" },
            id: { oneOf: [{ type: "string" }, { type: "integer" }] },
            method: { type: "string" },
            params: { type: "object", additionalProperties: true },
          },
        },
        response: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/chat/completions": {
    tag: "AI",
    jobToken: true,
    operations: {
      POST: {
        summary: "Proxy a chat completion to the space's AI provider",
        description:
          "Takes an OpenAI-shaped completion request and forwards it with the space's configured provider and credentials. The space is named by the `X-Space-Id` header, and the caller needs viewer permission on it.",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/caldav/calendars/[userId]/[spaceId]/[eventId]": {
    tag: "CalDAV",
    params: { eventId: "Calendar object (`.ics`) name." },
    operations: {
      GET: "Read one calendar object",
      PUT: "Create or replace one calendar object",
      OPTIONS: "Advertise the methods this calendar object supports",
    },
  },

  "/api/caldav/calendars/[userId]/[spaceId]": {
    tag: "CalDAV",
    description:
      "A space's calendar. Also answers the WebDAV methods (PROPFIND, REPORT, MKCALENDAR) that OpenAPI cannot describe.",
    operations: {
      OPTIONS: "Advertise the methods this calendar supports",
    },
  },

  "/api/caldav/calendars/[userId]": {
    tag: "CalDAV",
    description:
      "The user's calendar home. Also answers WebDAV PROPFIND for calendar discovery.",
    operations: {
      OPTIONS: "Advertise the methods the calendar home supports",
    },
  },

  "/api/caldav/principals/[userId]": {
    tag: "CalDAV",
    description: "The CalDAV principal. Also answers WebDAV PROPFIND.",
    operations: {
      OPTIONS: "Advertise the methods the principal supports",
    },
  },

  "/api/v1/spaces": {
    tag: "Spaces",
    operations: {
      GET: {
        summary: "List the spaces the caller can read",
        description:
          "A session lists the caller's spaces, an access token the single space it belongs to, and an anonymous caller the publicly readable ones.",
        response: { type: "array", items: { $ref: "#/components/schemas/Space" } },
      },
      POST: {
        summary: "Create a space",
        requestBody: {
          type: "object",
          required: ["name", "slug"],
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            preferences: { $ref: "#/components/schemas/Preferences" },
          },
        },
        responseStatus: 201,
        response: {
          type: "object",
          properties: { space: { $ref: "#/components/schemas/Space" } },
        },
      },
    },
  },

  "/api/v1/spaces/[spaceId]": {
    tag: "Spaces",
    operations: {
      GET: {
        summary: "Read one space",
        response: { $ref: "#/components/schemas/Space" },
      },
      PATCH: {
        summary: "Update a space",
        requestBody: {
          type: "object",
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            preferences: { $ref: "#/components/schemas/Preferences" },
          },
        },
      },
      DELETE: "Delete a space and everything in it",
    },
  },

  "/api/v1/spaces/[spaceId]/audit-logs": {
    tag: "Spaces",
    operations: {
      GET: { summary: "List the space's audit log", query: [...PAGINATION] },
    },
  },

  "/api/v1/spaces/[spaceId]/members": {
    tag: "Spaces",
    operations: { GET: "List the members of a space with their roles" },
  },

  "/api/v1/spaces/[spaceId]/notification-preference": {
    tag: "Spaces",
    operations: {
      GET: "Read the caller's notification preference for this space",
      PATCH: {
        summary: "Update the caller's notification preference for this space",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/properties": {
    tag: "Documents",
    operations: {
      GET: "List the document property keys used in a space, with their values",
    },
  },

  "/api/v1/spaces/[spaceId]/access-tokens": {
    tag: "Access tokens",
    operations: {
      GET: "List the space's access tokens (never the secrets)",
      POST: {
        summary: "Issue a space access token",
        description: "The token secret is returned once, in this response only.",
        requestBody: { type: "object", additionalProperties: true },
        responseStatus: 201,
      },
    },
  },

  "/api/v1/spaces/[spaceId]/access-tokens/[tokenId]": {
    tag: "Access tokens",
    operations: {
      GET: "Read one space access token",
      PATCH: {
        summary: "Update a space access token",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Revoke a space access token",
    },
  },

  "/api/v1/spaces/[spaceId]/ai-chat/sessions": {
    tag: "AI",
    operations: { GET: "List the caller's AI chat sessions in a space" },
  },

  "/api/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId]": {
    tag: "AI",
    operations: {
      GET: "Read one AI chat session",
      PUT: {
        summary: "Create or replace an AI chat session",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Delete an AI chat session",
    },
  },

  "/api/v1/spaces/[spaceId]/categories": {
    tag: "Categories",
    jobToken: true,
    operations: {
      GET: {
        summary: "List the categories of a space",
        response: { type: "array", items: { $ref: "#/components/schemas/Category" } },
      },
      POST: {
        summary: "Create a category",
        requestBody: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string" },
            color: { type: "string" },
            icon: { type: "string" },
          },
        },
        responseStatus: 201,
      },
      PUT: {
        summary: "Reorder the categories of a space",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/categories/[id]": {
    tag: "Categories",
    jobToken: true,
    params: { id: "Category id or slug." },
    operations: {
      GET: {
        summary: "Read one category",
        response: { $ref: "#/components/schemas/Category" },
      },
      PUT: {
        summary: "Update a category",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Delete a category",
    },
  },

  "/api/v1/spaces/[spaceId]/comments": {
    tag: "Comments",
    operations: {
      GET: {
        summary: "List comments on a resource",
        query: [
          {
            name: "documentId",
            description: "Document whose comments to list.",
            required: true,
          },
        ],
      },
      POST: {
        summary: "Create a comment",
        requestBody: { type: "object", additionalProperties: true },
        responseStatus: 201,
      },
      PATCH: {
        summary: "Update a comment",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Delete a comment",
    },
  },

  "/api/v1/spaces/[spaceId]/documents": {
    tag: "Documents",
    jobToken: true,
    operations: {
      GET: {
        summary: "List the documents of a space",
        query: [
          ...PAGINATION,
          { name: "type", description: "Only documents of this document type." },
          {
            name: "categorySlugs",
            description: "Comma-separated category slugs to list documents from.",
          },
          {
            name: "grouped",
            description: "With `categorySlugs`, group the result by category.",
            schema: { type: "boolean" },
          },
          {
            name: "parentId",
            description: "List the children of this document instead of the space.",
          },
          {
            name: "includeFiles",
            description: "Append the space's uploaded files as `file` entries.",
            schema: { type: "boolean" },
          },
        ],
        response: { $ref: "#/components/schemas/DocumentPage" },
      },
      POST: {
        summary: "Create a document",
        requestBody: {
          type: "object",
          properties: {
            slug: { type: "string" },
            type: { type: "string" },
            content: { type: "string" },
            parentId: { type: ["string", "null"] },
            properties: { $ref: "#/components/schemas/Properties" },
          },
        },
        responseStatus: 201,
      },
    },
  },

  "/api/v1/spaces/[spaceId]/documents/archived": {
    tag: "Documents",
    operations: {
      GET: { summary: "List the archived documents of a space", query: [...PAGINATION] },
    },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]": {
    tag: "Documents",
    jobToken: true,
    params: { documentId: "Document id or slug." },
    operations: {
      GET: {
        summary: "Read one document",
        query: [
          {
            name: "draft",
            description:
              "Read the current draft instead of the published revision. Requires editor permission.",
            schema: { type: "boolean" },
          },
        ],
        response: { $ref: "#/components/schemas/DocumentResponse" },
      },
      POST: {
        summary: "Publish the document's current draft",
        requestBody: { type: "object", additionalProperties: true },
        requestBodyRequired: false,
      },
      PUT: {
        summary: "Replace a document",
        requestBody: { type: "object", additionalProperties: true },
      },
      PATCH: {
        summary: "Update parts of a document",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Archive or delete a document",
    },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/access": {
    tag: "Documents",
    operations: { GET: "Who may read or edit this document, and how they got there" },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/breadcrumbs": {
    tag: "Documents",
    operations: { GET: "The document's ancestors, root first" },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/children": {
    tag: "Documents",
    operations: { GET: "The document's direct children" },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/contributors": {
    tag: "Documents",
    operations: { GET: "The accounts that have revised this document" },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/diff": {
    tag: "Documents",
    operations: {
      GET: {
        summary: "Diff a revision against its parent",
        query: [
          { name: "rev", description: "Revision number to diff.", required: true },
        ],
      },
    },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/edit": {
    tag: "Documents",
    jobToken: true,
    operations: {
      POST: {
        summary: "Apply an edit to the document's draft",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/git": {
    tag: "Git",
    operations: { GET: "Repository state for a repository document" },
  },

  "/api/v1/spaces/[spaceId]/documents/[documentId]/revisions": {
    tag: "Documents",
    operations: {
      GET: {
        summary: "List the revisions of a document",
        query: [...PAGINATION],
        response: { type: "array", items: { $ref: "#/components/schemas/Revision" } },
      },
      POST: {
        summary: "Create a revision, or restore an earlier one",
        requestBody: { type: "object", additionalProperties: true },
        responseStatus: 201,
      },
      PATCH: {
        summary: "Update a revision's message or suggestion status",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/marketplace/extensions": {
    tag: "Marketplace",
    operations: { GET: "List the extensions in the configured store" },
  },

  "/api/v1/marketplace/extensions/[extensionId]": {
    tag: "Marketplace",
    operations: { GET: "Read one store listing" },
  },

  "/api/v1/spaces/[spaceId]/extensions": {
    tag: "Extensions",
    jobToken: true,
    operations: {
      GET: "List the extensions installed in a space",
      POST: {
        summary: "Upload an extension package",
        requestBody: { type: "string", format: "binary" },
        responseStatus: 201,
      },
    },
  },

  "/api/v1/spaces/[spaceId]/extensions/install": {
    tag: "Extensions",
    operations: {
      POST: {
        summary: "Install an extension from the store",
        requestBody: {
          type: "object",
          required: ["extensionId"],
          properties: {
            extensionId: { type: "string" },
            version: { type: "string" },
          },
        },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/extensions/[extensionId]": {
    tag: "Extensions",
    jobToken: true,
    operations: {
      GET: "Read one installed extension",
      PATCH: {
        summary: "Enable or disable an installed extension",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Uninstall an extension",
    },
  },

  "/api/v1/spaces/[spaceId]/extensions/[extensionId]/package": {
    tag: "Extensions",
    operations: {
      GET: {
        summary: "Download the installed extension package",
        responseMediaType: "application/zip",
        response: { type: "string", format: "binary" },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/extensions/[extensionId]/assets/[...path]": {
    tag: "Extensions",
    params: { path: "Path of the asset inside the extension package." },
    operations: {
      GET: {
        summary: "Serve a file from the extension package",
        responseMediaType: "*/*",
        response: { type: "string", format: "binary" },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/integrations": {
    tag: "Integrations",
    operations: { GET: "List the integrations configured for a space" },
  },

  "/api/v1/spaces/[spaceId]/integrations/[provider]": {
    tag: "Integrations",
    params: { provider: "Integration provider id, e.g. `github`." },
    operations: {
      GET: "Read one integration's connection state",
      DELETE: "Disconnect an integration",
    },
  },

  "/api/v1/spaces/[spaceId]/integrations/[provider]/connect": {
    tag: "Integrations",
    operations: {
      POST: {
        summary: "Begin connecting an integration",
        description: "Answers with the provider's authorization URL to send the user to.",
        requestBody: { type: "object", additionalProperties: true },
        requestBodyRequired: false,
      },
    },
  },

  "/api/v1/spaces/[spaceId]/integrations/[provider]/callback": {
    tag: "Integrations",
    operations: { GET: "OAuth redirect target that completes a connection" },
  },

  "/api/v1/spaces/[spaceId]/integrations/[provider]/proxy": {
    tag: "Integrations",
    jobToken: true,
    operations: {
      POST: {
        summary: "Call the provider's API with the space's stored credentials",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/jobs/run": {
    tag: "Jobs",
    jobToken: true,
    operations: {
      POST: {
        summary: "Run a job",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/jobs/runs": {
    tag: "Jobs",
    operations: { GET: { summary: "List job runs", query: [...PAGINATION] } },
  },

  "/api/v1/spaces/[spaceId]/permissions": {
    tag: "Permissions",
    operations: {
      GET: {
        summary: "List the space's roles and feature overrides",
        query: [
          {
            name: "type",
            description: "Which entries to list.",
            schema: { type: "string", enum: ["role", "feature", "all"], default: "all" },
          },
        ],
      },
      POST: {
        summary: "Grant, deny or revoke a permission",
        requestBody: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["grant", "deny", "revoke"] },
            role: { type: "string" },
            feature: { type: "string" },
            userId: { type: "string" },
            email: { type: "string", format: "email" },
            groupId: { type: "string" },
            resourceType: {
              type: "string",
              enum: ["space", "document", "document_tree", "category"],
            },
            resourceId: { type: "string" },
          },
        },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/permissions/me": {
    tag: "Permissions",
    operations: { GET: "What the caller may do in this space" },
  },

  "/api/v1/spaces/[spaceId]/search": {
    tag: "Search",
    operations: {
      GET: {
        summary: "Search the documents of one space",
        query: [
          { name: "q", description: "Search query." },
          ...PAGINATION,
          {
            name: "filters",
            description: "JSON-encoded `[{ key, value }]` document property filters.",
          },
        ],
        response: { $ref: "#/components/schemas/SearchResponse" },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/search/rebuild": {
    tag: "Search",
    operations: { POST: "Rebuild the space's search index" },
  },

  "/api/v1/spaces/[spaceId]/secrets": {
    tag: "Secrets",
    description: "Secret values are write-only: a read answers with names, never values.",
    operations: {
      GET: "List the space's secret names",
      POST: {
        summary: "Create a secret",
        requestBody: {
          type: "object",
          required: ["name", "value"],
          properties: { name: { type: "string" }, value: { type: "string" } },
        },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/secrets/[name]": {
    tag: "Secrets",
    jobToken: true,
    params: { name: "Secret name." },
    operations: {
      GET: "Read one secret's metadata",
      PUT: {
        summary: "Set a secret's value",
        requestBody: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
      DELETE: "Delete a secret",
      HEAD: "Check whether a secret exists",
    },
  },

  "/api/v1/spaces/[spaceId]/settings/ai-provider": {
    tag: "AI",
    operations: {
      GET: "Read the space's AI provider configuration (never the API key)",
      PUT: {
        summary: "Configure the space's AI provider",
        requestBody: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            apiKey: { type: "string" },
            baseUrl: { type: "string" },
          },
        },
      },
      DELETE: "Remove the space's AI provider configuration",
    },
  },

  "/api/v1/spaces/[spaceId]/shares": {
    tag: "Sharing",
    operations: {
      GET: "List the space's share links",
      POST: {
        summary: "Create a share link",
        requestBody: { type: "object", additionalProperties: true },
        responseStatus: 201,
      },
    },
  },

  "/api/v1/spaces/[spaceId]/shares/[linkId]": {
    tag: "Sharing",
    operations: { DELETE: "Revoke a share link" },
  },

  "/api/v1/spaces/[spaceId]/uploads": {
    tag: "Files",
    jobToken: true,
    operations: {
      GET: "List the files uploaded to a space",
      POST: {
        summary: "Upload a file",
        requestBody: { type: "string", format: "binary" },
        responseStatus: 201,
      },
    },
  },

  "/api/v1/spaces/[spaceId]/uploads/[...path]": {
    tag: "Files",
    jobToken: true,
    params: { path: "Storage path of the file." },
    operations: {
      GET: {
        summary: "Download an uploaded file",
        responseMediaType: "*/*",
        response: { type: "string", format: "binary" },
      },
      DELETE: "Delete an uploaded file",
    },
  },

  "/api/v1/spaces/[spaceId]/workflows/runs": {
    tag: "Workflows",
    jobToken: true,
    operations: {
      GET: { summary: "List workflow runs", query: [...PAGINATION] },
      POST: {
        summary: "Start a workflow run",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/workflows/runs/[runId]": {
    tag: "Workflows",
    jobToken: true,
    operations: {
      GET: "Read one workflow run",
      POST: {
        summary: "Act on a running workflow, e.g. answer a pending step",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Cancel or delete a workflow run",
    },
  },

  "/api/v1/spaces/[spaceId]/workflows/schedules": {
    tag: "Workflows",
    operations: {
      GET: "List workflow schedules",
      POST: {
        summary: "Create a workflow schedule",
        requestBody: { type: "object", additionalProperties: true },
      },
    },
  },

  "/api/v1/spaces/[spaceId]/workflows/schedules/[scheduleId]": {
    tag: "Workflows",
    operations: {
      GET: "Read one workflow schedule",
      PATCH: {
        summary: "Update a workflow schedule",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Delete a workflow schedule",
    },
  },

  "/api/v1/access-tokens": {
    tag: "Access tokens",
    description: "The caller's own tokens, across the spaces they belong to.",
    operations: {
      GET: "List the caller's personal access tokens",
      POST: {
        summary: "Issue a personal access token",
        description: "The token secret is returned once, in this response only.",
        requestBody: { type: "object", additionalProperties: true },
        responseStatus: 201,
      },
    },
  },

  "/api/v1/access-tokens/[tokenId]": {
    tag: "Access tokens",
    operations: {
      PATCH: {
        summary: "Update one of the caller's access tokens",
        requestBody: { type: "object", additionalProperties: true },
      },
      DELETE: "Revoke one of the caller's access tokens",
    },
  },

  "/api/v1/proxy-media": {
    tag: "Media",
    operations: {
      GET: {
        summary: "Proxy a remote media file",
        description:
          "Fetches an external image or video on the server's behalf so a document can embed it without leaking the reader's address. Requires a session.",
        query: [{ name: "url", description: "Absolute media URL.", required: true }],
        responseMediaType: "*/*",
        response: { type: "string", format: "binary" },
      },
    },
  },

  "/api/v1/search": {
    tag: "Search",
    operations: {
      GET: {
        summary: "Search across the other spaces the caller can read",
        description:
          "Requires a session: a space-scoped token has no other spaces to widen to, and answers with an empty result.",
        query: [
          { name: "q", description: "Search query." },
          {
            name: "excludeSpaceId",
            description:
              "The space the caller is searching in, whose own results come from the space search route.",
          },
          {
            name: "filters",
            description: "JSON-encoded `[{ key, value }]` document property filters.",
          },
        ],
      },
    },
  },

  "/api/v1/url-metadata": {
    tag: "Media",
    operations: {
      GET: {
        summary: "Read link preview metadata for a URL",
        query: [{ name: "url", description: "Absolute URL to inspect.", required: true }],
      },
    },
  },

  "/api/v1/users": {
    tag: "Users",
    operations: {
      GET: {
        summary: "List user profiles the caller may see",
        description:
          "`?id=` reads one minimal profile and `?spaceId=` the members of a space the caller belongs to. Unscoped it is the instance register — every account for an instance admin, and an empty list for anyone else.",
        query: [
          { name: "id", description: "Read a single profile by user id." },
          { name: "spaceId", description: "Members of a space the caller belongs to." },
          ...PAGINATION,
        ],
      },
    },
  },

  "/api/v1/users/me": {
    tag: "Users",
    operations: {
      GET: {
        summary: "The caller's own profile",
        response: { $ref: "#/components/schemas/CurrentUser" },
      },
    },
  },

  "/api/v1/users/suggestions": {
    tag: "Users",
    operations: {
      GET: {
        summary: "Invite suggestions from the caller's own groups",
        query: [
          {
            name: "q",
            description: "Case-insensitive substring of a name or email address.",
          },
        ],
      },
    },
  },

  "/api/v1/openapi.json": {
    tag: "Discovery",
    public: true,
    operations: {
      GET: {
        summary: "This OpenAPI document",
        response: { type: "object", additionalProperties: true },
      },
      OPTIONS: "CORS preflight for the OpenAPI document",
    },
  },
};
