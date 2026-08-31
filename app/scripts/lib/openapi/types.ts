import type { ApiRouteMethod } from "#api/server/types.ts";

/** A JSON Schema fragment, as OpenAPI 3.1 embeds it. Kept open on purpose. */
export type JsonSchema = Record<string, unknown>;

/** One query-string parameter a route reads. */
export interface QueryParameterDoc {
  name: string;
  description: string;
  required?: boolean;
  /** Defaults to `{ type: "string" }`. */
  schema?: JsonSchema;
}

/**
 * What one method of a route does. A bare string is the shorthand for
 * `{ summary }`, which is all most routes need.
 */
export interface OperationDoc {
  summary: string;
  description?: string;
  query?: QueryParameterDoc[];
  /** Schema of an `application/json` request body. */
  requestBody?: JsonSchema;
  /** Whether that body is required. Defaults to true when a schema is given. */
  requestBodyRequired?: boolean;
  /** Schema of the success payload. Defaults to an untyped JSON value. */
  response?: JsonSchema;
  /** Success description. Defaults to a generic one. */
  responseDescription?: string;
  /** Success status, where the route answers with something other than 200. */
  responseStatus?: number;
  /** Media type of the success payload. Defaults to `application/json`. */
  responseMediaType?: string;
}

/** Everything the generator knows about one registered route pattern. */
export interface RouteDoc {
  /** The tag operations of this route are grouped under. */
  tag: string;
  description?: string;
  /** Path-parameter descriptions, overriding the shared defaults. */
  params?: Record<string, string>;
  /** Reachable without credentials, so the operation carries no security. */
  public?: boolean;
  /** Also authenticates a running job's `X-Job-Token`. */
  jobToken?: boolean;
  /**
   * Operations to emit. A module exporting `ALL` serves every method, so the
   * keys here are what the route is documented as answering.
   */
  operations: Partial<Record<ApiRouteMethod, string | OperationDoc>>;
}

/** One path template: its operations, keyed by lowercase method, and its description. */
export type PathItem = Record<string, JsonSchema | string>;

/** The subset of OpenAPI 3.1 this generator emits. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string; license?: JsonSchema };
  servers: { url: string; description?: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, PathItem>;
  components: JsonSchema;
  security: Record<string, string[]>[];
}
