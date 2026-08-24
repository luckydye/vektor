import {
  AclFailure,
  AuthenticationRequiredError,
  CredentialRejectedError,
  InvalidAclRequestError,
  PermissionDeniedError,
  ResourceUnavailableError,
} from "#acl/errors.ts";
import type { ApiContext } from "#api/server/types.ts";
import type { PropertyFilter } from "#db/space/search.ts";
import { appLogger } from "#observability/logger.ts";

export function jsonResponse(data: unknown, status = 200): Response {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body).toString(),
    },
  });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

export function unauthorizedResponse(): Response {
  return errorResponse("Unauthorized", 401);
}

export function forbiddenResponse(message?: string): Response {
  return errorResponse(message || "Forbidden", 403);
}

export function notFoundResponse(resource: string): Response {
  return errorResponse(`${resource} not found`, 404);
}

export function badRequestResponse(message: string): Response {
  return errorResponse(message, 400);
}

/** Translate an ACL domain failure at the HTTP boundary. */
export function aclFailureResponse(error: AclFailure): Response {
  if (
    error instanceof AuthenticationRequiredError ||
    error instanceof CredentialRejectedError
  ) {
    return unauthorizedResponse();
  }
  if (error instanceof PermissionDeniedError) {
    return forbiddenResponse(error.detail);
  }
  if (error instanceof ResourceUnavailableError) {
    return notFoundResponse(error.resource);
  }
  if (error instanceof InvalidAclRequestError) {
    return badRequestResponse(error.message);
  }
  return errorResponse("Unhandled ACL failure", 500);
}

export function successResponse(data?: unknown): Response {
  return jsonResponse(data ?? { success: true }, 200);
}

export function createdResponse(data: unknown): Response {
  return jsonResponse(data, 201);
}

export async function withApiErrorHandling(
  handler: () => Promise<Response> | Response,
  optionsOrMessage:
    | string
    | {
        fallbackMessage?: string;
        onError?: (
          error: unknown,
        ) => Response | undefined | Promise<Response | undefined>;
      } = "Internal server error",
): Promise<Response> {
  const options =
    typeof optionsOrMessage === "string"
      ? { fallbackMessage: optionsOrMessage }
      : optionsOrMessage;

  try {
    return await handler();
  } catch (error) {
    if (error instanceof AclFailure) {
      return aclFailureResponse(error);
    }
    if (error instanceof Response) {
      return error;
    }
    if (options.onError) {
      const mapped = await options.onError(error);
      if (mapped) {
        return mapped;
      }
    }
    appLogger.error("Unhandled API error", {
      error,
    });
    return errorResponse(options.fallbackMessage ?? "Internal server error", 500);
  }
}

export function requireUser(context: ApiContext) {
  const user = context.var.user;
  if (!user) {
    throw unauthorizedResponse();
  }
  return user;
}

export function requireParam(
  params: Record<string, string | undefined>,
  key: string,
): string {
  const value = params[key];
  if (!value) {
    throw badRequestResponse(`${key} is required`);
  }
  return value;
}

export function parseQueryInt(
  searchParams: URLSearchParams,
  key: string,
  options: {
    defaultValue?: number;
    min?: number;
    max?: number;
  } = {},
): number {
  const { defaultValue, min, max } = options;
  const raw = searchParams.get(key);
  if (raw === null || raw.trim() === "") {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw badRequestResponse(`${key} is required`);
  }

  if (!/^-?\d+$/.test(raw)) {
    throw badRequestResponse(`${key} must be an integer`);
  }

  const value = Number.parseInt(raw, 10);

  if (min !== undefined && value < min) {
    throw badRequestResponse(`${key} must be >= ${min}`);
  }

  if (max !== undefined && value > max) {
    throw badRequestResponse(`${key} must be <= ${max}`);
  }

  return value;
}

export interface PaginatedResult<T> {
  data: T[];
  limit: number;
  nextCursor: string | null;
}

export function parsePaginationParams(
  searchParams: URLSearchParams,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; cursor: string | undefined } {
  const { defaultLimit = 50, maxLimit = 500 } = options;
  const limit = parseQueryInt(searchParams, "limit", {
    defaultValue: defaultLimit,
    min: 1,
    max: maxLimit,
  });
  const cursor = searchParams.get("cursor") ?? undefined;
  return { limit, cursor };
}

/** The `filters` search parameter: a JSON-encoded `PropertyFilter[]`, or none. */
export function parseSearchFilters(raw: string | null): PropertyFilter[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Filters must be an array");
    }
    for (const filter of parsed) {
      if (typeof filter.key !== "string" || !filter.key.trim()) {
        throw new Error("Each filter must have a non-empty 'key' string");
      }
      if (filter.value !== null && typeof filter.value !== "string") {
        throw new Error("Filter 'value' must be a string or null");
      }
    }
    return parsed;
  } catch (error) {
    throw badRequestResponse(
      `Invalid filters parameter: ${error instanceof Error ? error.message : "Parse error"}`,
    );
  }
}

export async function parseJsonBody<T = Record<string, unknown>>(
  request: Request,
): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequestResponse("Invalid JSON body");
  }
}

/**
 * Form/multipart counterpart to {@link parseJsonBody}. `formData()` throws on a
 * body that is not a form — a JSON payload, or none at all — and an unhandled
 * throw there surfaces as a 500 on what is really a malformed request.
 */
export async function parseFormBody(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw badRequestResponse("Expected a form submission");
  }
}

export async function parseJsonBodyOrEmpty<
  T extends Record<string, unknown> = Record<string, unknown>,
>(request: Request): Promise<Partial<T>> {
  const rawBody = await request.text();
  if (rawBody.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw badRequestResponse("Invalid JSON body");
  }
}
