import type { ApiRoute } from "#api/routes.ts";
import type { ApiRouteMethod, ApiRouteModule } from "#api/server/types.ts";
import { routeDocs } from "./operations.ts";
import { SCHEMAS } from "./schemas.ts";
import type {
  JsonSchema,
  OpenApiDocument,
  PathItem,
  OperationDoc,
  QueryParameterDoc,
  RouteDoc,
} from "./types.ts";

/** The methods OpenAPI can describe. `ALL`, PROPFIND and friends have no slot. */
const OPENAPI_METHODS = [
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
] as const satisfies readonly ApiRouteMethod[];

type OpenApiMethod = (typeof OPENAPI_METHODS)[number];

const DEFAULT_SECURITY = [{ accessToken: [] }, { sessionCookie: [] }];

/** Path-parameter descriptions shared by every route that takes one. */
const PARAM_DESCRIPTIONS: Record<string, string> = {
  documentId: "Document id or slug.",
  extensionId: "Extension id.",
  linkId: "Share link id.",
  runId: "Workflow run id.",
  scheduleId: "Workflow schedule id.",
  sessionId: "AI chat session id.",
  spaceId: "Space id or slug.",
  tokenId: "Access token id.",
  userId: "User id.",
};

const TAG_DESCRIPTIONS: Record<string, string> = {
  "Access tokens": "Long-lived credentials for scripts, CI and the CLI.",
  AI: "Model configuration and the chat endpoints built on it.",
  Auth: "Sign-in, sessions and CLI pairing.",
  CalDAV: "Calendar access over CalDAV. Mostly WebDAV methods OpenAPI cannot describe.",
  Categories: "The category tree documents are filed under.",
  Comments: "Discussion attached to documents.",
  Discovery: "Unauthenticated endpoints describing the instance itself.",
  Documents: "Reading and writing documents, their revisions and their properties.",
  Extensions: "Extensions installed into a space.",
  Files: "Uploaded files and attachments.",
  Git: "Repository documents over Git smart HTTP.",
  Integrations: "Third-party connections owned by a space.",
  Jobs: "Background jobs and their runs.",
  Marketplace: "The extension store this instance is configured to browse.",
  Media: "Server-side fetching of external URLs.",
  Permissions: "Roles, feature grants and what the caller may do.",
  Search: "Full-text and property search.",
  Secrets: "Write-only values a space's jobs and integrations read.",
  Sharing: "Public and link-based access to documents.",
  Spaces: "The top-level containers everything else belongs to.",
  Users: "Accounts and profiles.",
  Workflows: "Automated document workflows, their runs and schedules.",
};

const DESCRIPTION = `The HTTP API of a Vektor instance.

Requests authenticate with either a space access token
(\`Authorization: Bearer at_…\`) or the session cookie a signed-in browser
carries. Endpoints marked without security need neither. Every endpoint is
rate limited; a rejected request answers \`429\` with a \`Retry-After\` header.

This document is generated from the server's own route registry, so it
describes exactly the routes this instance serves.`;

/** Turn a bracket-parameter pattern into an OpenAPI path template. */
export function toOpenApiPath(pattern: string): string {
  return pattern.replace(/\[\.\.\.(.+?)\]/g, "{$1}").replace(/\[(.+?)\]/g, "{$1}");
}

function patternParameters(pattern: string): { name: string; catchAll: boolean }[] {
  return pattern
    .split("/")
    .flatMap((segment) => {
      const rest = segment.match(/^\[\.\.\.(.+)\]$/);
      if (rest) return [{ name: rest[1], catchAll: true }];
      const param = segment.match(/^\[(.+)\]$/);
      return param ? [{ name: param[1], catchAll: false }] : [];
    })
    .filter((parameter, index, all) => {
      return all.findIndex((other) => other.name === parameter.name) === index;
    });
}

/** Whether the module actually answers this method — `ALL` answers everything. */
export function servesMethod(module: ApiRouteModule, method: string): boolean {
  return Boolean(module[method as ApiRouteMethod] ?? module.ALL);
}

function isOpenApiMethod(method: string): method is OpenApiMethod {
  return (OPENAPI_METHODS as readonly string[]).includes(method);
}

function asOperationDoc(operation: string | OperationDoc): OperationDoc {
  return typeof operation === "string" ? { summary: operation } : operation;
}

/**
 * A readable, stable id per operation: the method plus the path with its
 * version prefix dropped and its parameters read as `ByX`. Collisions are
 * impossible — one operation per method per pattern, and the pattern is in the id.
 */
export function operationId(method: string, pattern: string): string {
  const words = pattern
    .split("/")
    .filter((segment) => segment && segment !== "api" && segment !== "v1")
    .flatMap((segment) => {
      const param = segment.match(/^\[(?:\.\.\.)?(.+)\]$/);
      return param ? ["by", param[1]] : segment.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    });

  return [
    method.toLowerCase(),
    ...words.map((word) => word[0].toUpperCase() + word.slice(1)),
  ].join("");
}

function pathParameterObjects(pattern: string, doc: RouteDoc): JsonSchema[] {
  return patternParameters(pattern).map(({ name, catchAll }) => ({
    name,
    in: "path",
    required: true,
    description:
      doc.params?.[name] ??
      PARAM_DESCRIPTIONS[name] ??
      (catchAll ? "Remaining path segments." : `The \`${name}\` path parameter.`),
    schema: { type: "string" },
    ...(catchAll
      ? {
          // A catch-all matches several segments, which a path parameter cannot
          // express: the slashes are meant literally, not percent-encoded.
          "x-catch-all": true,
        }
      : {}),
  }));
}

function queryParameterObjects(query: QueryParameterDoc[] = []): JsonSchema[] {
  return query.map((parameter) => ({
    name: parameter.name,
    in: "query",
    required: parameter.required ?? false,
    description: parameter.description,
    schema: parameter.schema ?? { type: "string" },
  }));
}

function successResponse(operation: OperationDoc): [string, JsonSchema] {
  const status = String(operation.responseStatus ?? 200);
  const mediaType = operation.responseMediaType ?? "application/json";
  return [
    status,
    {
      description: operation.responseDescription ?? "Success",
      content: { [mediaType]: { schema: operation.response ?? {} } },
    },
  ];
}

function responses(operation: OperationDoc, pattern: string, isPublic: boolean) {
  const takesInput = Boolean(operation.requestBody) || (operation.query?.length ?? 0) > 0;
  const [status, success] = successResponse(operation);

  return {
    [status]: success,
    ...(takesInput ? { 400: ref("responses", "BadRequest") } : {}),
    ...(isPublic
      ? {}
      : {
          401: ref("responses", "Unauthorized"),
          403: ref("responses", "Forbidden"),
        }),
    ...(pattern.includes("[") ? { 404: ref("responses", "NotFound") } : {}),
    429: ref("responses", "RateLimited"),
    500: ref("responses", "ServerError"),
  };
}

function ref(section: string, name: string): JsonSchema {
  return { $ref: `#/components/${section}/${name}` };
}

function operationObject(
  method: string,
  pattern: string,
  doc: RouteDoc,
  operation: OperationDoc,
): JsonSchema {
  const parameters = [
    ...pathParameterObjects(pattern, doc),
    ...queryParameterObjects(operation.query),
  ];

  return {
    operationId: operationId(method, pattern),
    summary: operation.summary,
    ...(operation.description ? { description: operation.description } : {}),
    tags: [doc.tag],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(operation.requestBody
      ? {
          requestBody: {
            required: operation.requestBodyRequired ?? true,
            content: {
              [operation.requestBody.format === "binary"
                ? "application/octet-stream"
                : "application/json"]: { schema: operation.requestBody },
            },
          },
        }
      : {}),
    responses: responses(operation, pattern, doc.public === true),
    // An empty list is how OpenAPI says "no credentials needed" against the
    // document-wide default below.
    security: doc.public
      ? []
      : doc.jobToken
        ? [...DEFAULT_SECURITY, { jobToken: [] }]
        : DEFAULT_SECURITY,
  };
}

/**
 * Build the OpenAPI document for a route registry.
 *
 * Nothing here reads a request: the schema is a pure function of the routes the
 * server is compiled with, which is what makes it safe to generate once and
 * serve as a static document.
 */
export function buildOpenApiDocument(routes: readonly ApiRoute[]): OpenApiDocument {
  const paths: Record<string, PathItem> = {};
  const usedTags = new Set<string>();

  for (const { pattern, module } of [...routes].sort((a, b) =>
    a.pattern.localeCompare(b.pattern),
  )) {
    const doc = routeDocs[pattern];
    // An undocumented route is a bug `openapi.spec.ts` fails on. Serving a
    // schema that silently omits it would be the worse of the two answers, but
    // a 500 for the whole document would be worse still.
    if (!doc) continue;

    const path = toOpenApiPath(pattern);
    const item: PathItem = paths[path] ?? {};

    for (const [method, operation] of Object.entries(doc.operations)) {
      if (!operation || !isOpenApiMethod(method) || !servesMethod(module, method)) {
        continue;
      }
      item[method.toLowerCase()] = operationObject(
        method,
        pattern,
        doc,
        asOperationDoc(operation),
      );
    }

    if (Object.keys(item).length === 0) continue;
    if (doc.description) item.description = doc.description;
    usedTags.add(doc.tag);
    paths[path] = item;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Vektor API",
      version: "v1",
      description: DESCRIPTION,
      license: { name: "AGPL-3.0", identifier: "AGPL-3.0-only" },
    },
    servers: [{ url: "/", description: "This instance" }],
    tags: [...usedTags].sort().map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}),
    })),
    paths,
    components: {
      securitySchemes: {
        accessToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "at_…",
          description:
            "A space or personal access token, sent as `Authorization: Bearer at_…`.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "vektor.session_token",
          description: "The session cookie a signed-in browser carries.",
        },
        jobToken: {
          type: "apiKey",
          in: "header",
          name: "X-Job-Token",
          description:
            "Issued to a running job, and accepted only by the routes a job calls.",
        },
      },
      schemas: SCHEMAS,
      responses: {
        BadRequest: errorResponseObject("The request was malformed or rejected."),
        Unauthorized: errorResponseObject("No credentials, or credentials rejected."),
        Forbidden: errorResponseObject("The caller may not do this."),
        NotFound: errorResponseObject(
          "No such resource, or none the caller may know about.",
        ),
        RateLimited: errorResponseObject(
          "Rate limit exceeded. Retry after `Retry-After` seconds.",
        ),
        ServerError: errorResponseObject("Unhandled server error."),
      },
    },
    security: DEFAULT_SECURITY,
  };
}

function errorResponseObject(description: string): JsonSchema {
  return {
    description,
    content: { "application/json": { schema: ref("schemas", "Error") } },
  };
}
