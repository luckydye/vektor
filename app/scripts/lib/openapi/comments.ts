import type { ApiRouteMethod } from "#api/server/types.ts";
import type { OperationDoc, QueryParameterDoc, RouteDoc } from "./types.ts";

/**
 * Doc-comment convention this module parses: a JSDoc block directly above an
 * exported `export const GET: ApiRouteHandler = …` (etc.) documents that one
 * operation. The comment's first line is the summary; a blank line then
 * starts an optional longer description, ended by the first `@tag`.
 *
 * Recognized tags:
 *   @tag Name             Route-level: the OpenAPI tag operations group under.
 *   @public                Route-level: reachable without credentials.
 *   @jobToken              Route-level: also accepts a running job's token.
 *   @param name Text        Route-level: describes a `[name]` path segment.
 *   @note Text              Route-level: a path-wide note (e.g. "also answers
 *                            WebDAV PROPFIND"), kept alongside the operations.
 *   @query name[!][:type] Text   A query parameter. `!` marks it required;
 *                                `:type` is `string` (default), `integer` or
 *                                `boolean`.
 *   @paginated              Shorthand for the `limit`/`cursor` query pair
 *                            every listing route takes.
 *   @body [binary]           Takes a JSON (or, with `binary`, octet-stream)
 *                            request body. Add `?` (`@body?`) if optional.
 *   @status N                Success status, where it isn't 200.
 *   @media type/subtype      Success media type, where it isn't `application/json`.
 *                            `any` stands in for `*\/*`, which would close the
 *                            comment if written literally.
 *   @response ref             `$ref` of the success schema, e.g.
 *                              `#/components/schemas/Space`.
 *   @response array ref       Same, wrapped in `{ type: "array", items }`.
 *
 * A route whose handlers disagree on a route-level tag keeps the first one
 * seen; `@public` and `@jobToken` are on if any handler in the file sets them.
 *
 * A handful of routes (CalDAV, git smart HTTP, better-auth) answer every
 * method through one `export const ALL`, since OpenAPI has no way to describe
 * most of what they actually serve (WebDAV verbs, git's binary protocol).
 * Above `ALL`, stack one comment block per OpenAPI-describable method instead,
 * each starting with `@method NAME` in place of the method the export name
 * would otherwise supply.
 */

const HANDLER_PATTERN =
  /export const (GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|ALL):\s*ApiRouteHandler/g;

const PAGINATION: QueryParameterDoc[] = [
  { name: "limit", description: "Page size.", schema: { type: "integer" } },
  { name: "cursor", description: "Opaque cursor from the previous page's `nextCursor`." },
];

interface ParsedComment {
  summary: string;
  description?: string;
  tags: { name: string; value: string }[];
}

/**
 * Every `/** … *\/` block stacked directly above `beforeIndex` — usually one,
 * but an `ALL`-exporting handler carries one block per method it documents.
 * Returned in source order.
 */
function commentsBefore(source: string, beforeIndex: number): string[] {
  const comments: string[] = [];
  let cursor = beforeIndex;

  for (;;) {
    const gap = source.slice(0, cursor);
    const trailingWhitespace = gap.match(/\s*$/)?.[0].length ?? 0;
    const codeEnd = cursor - trailingWhitespace;
    if (!source.slice(0, codeEnd).endsWith("*/")) break;

    const start = source.lastIndexOf("/**", codeEnd);
    if (start === -1) break;
    comments.unshift(source.slice(start, codeEnd));
    cursor = start;
  }

  return comments;
}

function stripCommentMarkers(raw: string): string[] {
  return raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd());
}

function parseComment(raw: string): ParsedComment {
  const lines = stripCommentMarkers(raw);
  const tagStart = lines.findIndex((line) => line.trimStart().startsWith("@"));
  const prose = (tagStart === -1 ? lines : lines.slice(0, tagStart))
    .join("\n")
    .trim()
    .split(/\n\s*\n/);
  const tagLines = tagStart === -1 ? [] : lines.slice(tagStart);

  const tags: { name: string; value: string }[] = [];
  for (const line of tagLines) {
    const match = line.trimStart().match(/^@(\S+)\s*(.*)$/);
    if (match) tags.push({ name: match[1], value: match[2].trim() });
  }

  return {
    summary: prose[0]?.replace(/\n/g, " ").trim() ?? "",
    description: prose.slice(1).join("\n\n").trim() || undefined,
    tags,
  };
}

function queryParam(value: string): QueryParameterDoc {
  const match = value.match(/^(\w+)(!)?(?::(string|integer|boolean))?\s+(.*)$/);
  if (!match) throw new Error(`Malformed @query tag: "${value}"`);
  const [, name, required, type, description] = match;
  return {
    name,
    description,
    required: required === "!",
    ...(type && type !== "string" ? { schema: { type } } : {}),
  };
}

function applyTag(
  operation: OperationDoc,
  route: Partial<RouteDoc>,
  tag: { name: string; value: string },
): void {
  switch (tag.name) {
    case "tag":
      route.tag ??= tag.value;
      return;
    case "public":
      route.public = true;
      return;
    case "jobToken":
      route.jobToken = true;
      return;
    case "param": {
      const [name, ...rest] = tag.value.split(/\s+/);
      route.params = { ...route.params, [name]: rest.join(" ") };
      return;
    }
    case "note":
      route.description ??= tag.value;
      return;
    case "query":
      operation.query = [...(operation.query ?? []), queryParam(tag.value)];
      return;
    case "paginated":
      operation.query = [...(operation.query ?? []), ...PAGINATION];
      return;
    case "body":
      operation.requestBody =
        tag.value.trim() === "binary"
          ? { type: "string", format: "binary" }
          : { type: "object", additionalProperties: true };
      return;
    case "body?":
      operation.requestBody = { type: "object", additionalProperties: true };
      operation.requestBodyRequired = false;
      return;
    case "status":
      operation.responseStatus = Number(tag.value);
      return;
    case "media": {
      // "*/*" cannot be written literally inside a `/** */` comment — the
      // `*/` would close it early — so `any` stands in for it.
      const mediaType = tag.value === "any" ? "*/*" : tag.value;
      operation.responseMediaType = mediaType;
      if (mediaType !== "application/json") {
        operation.response = { type: "string", format: "binary" };
      }
      return;
    }
    case "response": {
      const [first, ...rest] = tag.value.split(/\s+/);
      const ref = { $ref: first === "array" ? rest.join(" ") : tag.value };
      operation.response = first === "array" ? { type: "array", items: ref } : ref;
      return;
    }
    default:
      throw new Error(`Unknown OpenAPI doc tag: "@${tag.name}"`);
  }
}

/** Builds one `OperationDoc` from a parsed comment, applying its tags to `route`. */
function toOperation(parsed: ParsedComment, route: Partial<RouteDoc>): OperationDoc {
  const operation: OperationDoc = { summary: parsed.summary };
  if (parsed.description) operation.description = parsed.description;
  for (const tag of parsed.tags) applyTag(operation, route, tag);
  return operation;
}

/**
 * Parse one route file's source into the `RouteDoc` its handler comments
 * describe. Returns `undefined` for a file with no doc-commented handlers —
 * the route file has not opted in, which the generator treats as "undocumented"
 * exactly like a missing `operations.ts` entry once did.
 */
export function parseRouteDoc(source: string): RouteDoc | undefined {
  const operations: RouteDoc["operations"] = {};
  const route: Partial<RouteDoc> = { operations };
  let found = false;

  for (const match of source.matchAll(HANDLER_PATTERN)) {
    const method = match[1] as ApiRouteMethod;
    const comments = commentsBefore(source, match.index);
    if (comments.length === 0) continue;
    found = true;

    if (method !== "ALL") {
      // The export name names the method; the nearest comment documents it.
      operations[method] = toOperation(parseComment(comments.at(-1) as string), route);
      continue;
    }

    // `ALL` answers every method, most of which OpenAPI cannot describe (see
    // the module doc comment) — each stacked block names the one it documents.
    for (const raw of comments) {
      const parsed = parseComment(raw);
      const methodTag = parsed.tags.find((tag) => tag.name === "method");
      if (!methodTag) {
        throw new Error(
          "A doc comment above an `ALL`-exporting handler needs `@method NAME`",
        );
      }
      const documentedMethod = methodTag.value.trim().toUpperCase() as ApiRouteMethod;
      const rest = { ...parsed, tags: parsed.tags.filter((tag) => tag !== methodTag) };
      operations[documentedMethod] = toOperation(rest, route);
    }
  }

  if (!found) return undefined;
  if (!route.tag) {
    throw new Error("A documented route handler needs an `@tag` somewhere in the file");
  }
  return route as RouteDoc;
}
