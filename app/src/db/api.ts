import type { Attributes, Span } from "@opentelemetry/api";
import type { APIContext } from "astro";
import { appLogger } from "#observability/logger.ts";
import { withSpan } from "#observability/otel.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "../noAuth.ts";
import type { ValidateTokenResult } from "./accessTokens.ts";
import { getTokenUserId, validateAccessToken } from "./accessTokens.ts";
import {
  type Feature,
  getUserGroups,
  hasFeature,
  hasPermission,
  ResourceType,
} from "./acl.ts";
import { getSpace } from "./spaces.ts";

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

export function successResponse(data?: unknown): Response {
  return jsonResponse(data ?? { success: true }, 200);
}

export function createdResponse(data: unknown): Response {
  return jsonResponse(data, 201);
}

export async function withApiErrorHandling(
  handler: (span?: Span) => Promise<Response> | Response,
  optionsOrMessage:
    | string
    | {
        fallbackMessage?: string;
        onError?: (
          error: unknown,
        ) => Response | undefined | Promise<Response | undefined>;
        telemetry?: {
          context: APIContext;
          spanName: string;
          attributes?: Attributes;
        };
      } = "Internal server error",
): Promise<Response> {
  const options =
    typeof optionsOrMessage === "string"
      ? { fallbackMessage: optionsOrMessage }
      : optionsOrMessage;

  try {
    if (options.telemetry) {
      const { context, spanName, attributes } = options.telemetry;
      return await withSpan(
        spanName,
        {
          traceparent: context.request.headers.get("traceparent"),
          tracestate: context.request.headers.get("tracestate"),
          attributes,
        },
        async (span) => handler(span),
      );
    }

    return await handler();
  } catch (error) {
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

export function requireUser(context: APIContext) {
  const user = context.locals.user;
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
  total: number;
  limit: number;
  offset: number;
}

export function parsePaginationParams(
  searchParams: URLSearchParams,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const { defaultLimit = 50, maxLimit = 500 } = options;
  const limit = parseQueryInt(searchParams, "limit", {
    defaultValue: defaultLimit,
    min: 1,
    max: maxLimit,
  });
  const offset = parseQueryInt(searchParams, "offset", {
    defaultValue: 0,
    min: 0,
  });
  return { limit, offset };
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

export async function verifySpaceOwnership(
  spaceId: string,
  userId: string,
  getSpace: (id: string) => Promise<{ createdBy: string } | null>,
) {
  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    const space = await getSpace(spaceId);
    if (!space) {
      throw notFoundResponse("Space");
    }
    return space;
  }

  const space = await getSpace(spaceId);
  if (!space) {
    throw notFoundResponse("Space");
  }
  if (space.createdBy !== userId) {
    throw forbiddenResponse();
  }
  return space;
}

export async function verifySpaceAccess(spaceId: string, userId: string): Promise<void> {
  const space = await getSpace(spaceId);
  if (!space) {
    throw notFoundResponse("Space");
  }

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return;
  }

  if (space.createdBy === userId) {
    return;
  }

  const userGroups = await getUserGroups(userId);
  const hasAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    "viewer",
    userGroups,
  );
  if (!hasAccess) {
    throw forbiddenResponse();
  }
}

export async function verifySpaceRole(
  spaceId: string,
  userId: string,
  requiredRole: string,
): Promise<void> {
  const space = await getSpace(spaceId);
  if (!space) {
    throw notFoundResponse("Space");
  }

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return;
  }

  if (space.createdBy === userId) {
    return;
  }

  const userGroups = await getUserGroups(userId);
  const hasRole = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    requiredRole,
    userGroups,
  );
  if (!hasRole) {
    throw forbiddenResponse();
  }
}

export async function verifyDocumentAccess(
  spaceId: string,
  documentId: string,
  userId: string | null,
): Promise<void> {
  const space = await getSpace(spaceId);
  if (!space) {
    throw notFoundResponse("Space");
  }

  // For unauthenticated users, check if document has public access
  if (!userId) {
    const hasPublicAccess = await hasPermission(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      "", // Empty userId for public check
      "viewer",
      ["public"],
    );
    if (!hasPublicAccess) {
      throw unauthorizedResponse();
    }
    return;
  }

  const userGroups = await getUserGroups(userId);
  const hasAccess = await hasPermission(
    spaceId,
    ResourceType.DOCUMENT,
    documentId,
    userId,
    "viewer",
    userGroups,
  );
  if (!hasAccess) {
    throw forbiddenResponse();
  }
}

export async function verifyDocumentRole(
  spaceId: string,
  documentId: string,
  userId: string | null,
  requiredRole: string,
): Promise<void> {
  // For unauthenticated users, check if document has public access with required role
  if (!userId) {
    const hasPublicAccess = await hasPermission(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      "", // Empty userId for public check
      requiredRole,
      ["public"],
    );
    if (!hasPublicAccess) {
      throw unauthorizedResponse();
    }
    return;
  }

  const userGroups = await getUserGroups(userId);
  const hasRole = await hasPermission(
    spaceId,
    ResourceType.DOCUMENT,
    documentId,
    userId,
    requiredRole,
    userGroups,
  );
  if (!hasRole) {
    throw forbiddenResponse();
  }
}

/**
 * Verify user has access to a specific feature, throws 403 if not.
 *
 * @example
 * await verifyFeatureAccess(spaceId, Feature.COMMENT, userId);
 * await verifyFeatureAccess(spaceId, Feature.VIEW_HISTORY, userId);
 */
export async function verifyFeatureAccess(
  spaceId: string,
  feature: Feature,
  userId: string,
): Promise<void> {
  const userGroups = await getUserGroups(userId);
  const hasAccess = await hasFeature(spaceId, feature, userId, userGroups);
  if (!hasAccess) {
    throw forbiddenResponse(
      `You don't have access to the ${feature.replace("_", " ")} feature`,
    );
  }
}

/**
 * Check if user can access an extension.
 * Returns true if user is an editor on the space OR has explicit ACL entry for the extension.
 */
export async function canAccessExtension(
  spaceId: string,
  extensionId: string,
  userId: string,
): Promise<boolean> {
  const space = await getSpace(spaceId);
  if (!space) {
    return false;
  }

  // Space owner has full access
  if (space.createdBy === userId) {
    return true;
  }

  const userGroups = await getUserGroups(userId);

  // Check if user has editor permission on space (editors can access all extensions)
  const isEditor = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    "editor",
    userGroups,
  );
  if (isEditor) {
    return true;
  }

  // Check if user has explicit ACL entry for this extension
  return await hasPermission(
    spaceId,
    ResourceType.EXTENSION,
    extensionId,
    userId,
    "viewer",
    userGroups,
  );
}

/**
 * Verify user has access to an extension, throws if not.
 */
export async function verifyExtensionAccess(
  spaceId: string,
  extensionId: string,
  userId: string,
): Promise<void> {
  const hasAccess = await canAccessExtension(spaceId, extensionId, userId);
  if (!hasAccess) {
    throw forbiddenResponse();
  }
}

/** Permission levels a token may be granted (real ACL hierarchy values). */
const TOKEN_GRANTABLE_PERMISSIONS = ["viewer", "editor", "owner"];

/** Resource types a token grant may target. Secrets/features are intentionally
 * excluded — those have dedicated, more tightly-scoped grant flows. */
const TOKEN_GRANTABLE_RESOURCE_TYPES: ResourceType[] = [
  ResourceType.SPACE,
  ResourceType.DOCUMENT,
  ResourceType.CATEGORY,
  ResourceType.EXTENSION,
];

/**
 * Authorize a request to grant an access token `permission` on a resource.
 *
 * Enforces two invariants that were previously missing (privilege escalation):
 *  1. `permission` / `resourceType` are valid values (rejects bogus inputs like
 *     the old "extensions" pseudo-permission that resolved to level 0).
 *  2. The caller may not grant a token MORE authority than the caller holds on
 *     that resource — a token is a delegation of the issuer's own access.
 *
 * Throws a 400/403 Response on violation.
 */
export async function verifyCanGrantTokenAccess(
  spaceId: string,
  callerUserId: string,
  resourceType: ResourceType,
  resourceId: string,
  permission: string,
): Promise<void> {
  if (!TOKEN_GRANTABLE_PERMISSIONS.includes(permission)) {
    throw badRequestResponse(
      `Permission must be one of: ${TOKEN_GRANTABLE_PERMISSIONS.join(", ")}`,
    );
  }
  if (!TOKEN_GRANTABLE_RESOURCE_TYPES.includes(resourceType)) {
    throw badRequestResponse(
      `Token access cannot be granted for resource type: ${resourceType}`,
    );
  }

  if (resourceType === ResourceType.DOCUMENT) {
    await verifyDocumentRole(spaceId, resourceId, callerUserId, permission);
  } else {
    // Space, category, and extension grants are gated on the caller's
    // space-level role (the level that lets them manage those resources).
    await verifySpaceRole(spaceId, callerUserId, permission);
  }
}

/**
 * Extract access token from Authorization header
 * Supports: "Bearer at_xxxxx" or "at_xxxxx"
 */
export function extractAccessToken(context: APIContext): string | null {
  const authHeader = context.request.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }

  // Handle "Bearer at_xxxxx" format
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    return token.startsWith("at_") ? token : null;
  }

  // Handle direct "at_xxxxx" format
  return authHeader.startsWith("at_") ? authHeader : null;
}

/**
 * Authenticate request using access token
 * Returns token validation result or throws unauthorized
 *
 * @example
 * ```ts
 * const tokenAuth = await authenticateWithToken(context, spaceId);
 * if (tokenAuth) {
 *   // Check permissions via ACL
 *   const canEdit = await hasPermission(
 *     spaceId,
 *     "document",
 *     documentId,
 *     getTokenUserId(tokenAuth.tokenId),
 *     "editor"
 *   );
 * }
 * ```
 */
export async function authenticateWithToken(
  context: APIContext,
  spaceId: string,
): Promise<ValidateTokenResult | null> {
  const token = extractAccessToken(context);
  if (!token) {
    return null;
  }

  const result = await validateAccessToken(token, spaceId);
  if (!result) {
    throw unauthorizedResponse();
  }

  return result;
}

/**
 * Verify token has required permission for a resource via ACL
 *
 * @example
 * ```ts
 * await verifyTokenPermission(tokenAuth, spaceId, "document", "doc123", "editor");
 * ```
 */
export async function verifyTokenPermission(
  tokenResult: ValidateTokenResult,
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  requiredPermission: string,
): Promise<void> {
  const tokenUserId = getTokenUserId(tokenResult.tokenId);

  const hasAccess = await hasPermission(
    spaceId,
    resourceType,
    resourceId,
    tokenUserId,
    requiredPermission,
  );

  if (!hasAccess) {
    throw forbiddenResponse(
      `Token does not have ${requiredPermission} permission for this ${resourceType}`,
    );
  }
}

/**
 * Verify a token holds a space-wide `feature` capability.
 *
 * Features are space-scoped (no resource id), so a feature-granted token can
 * act across the whole space — e.g. a token with `manage_extensions` can
 * install NEW extensions, not just ones that already exist. The check does not
 * fall back to a space role unless the role's defaults include the feature, so
 * a plain viewer/editor token (which lacks the feature by default) is rejected.
 */
export async function verifyTokenFeature(
  tokenResult: ValidateTokenResult,
  spaceId: string,
  feature: Feature,
): Promise<void> {
  const tokenUserId = getTokenUserId(tokenResult.tokenId);
  const hasIt = await hasFeature(spaceId, feature, tokenUserId);
  if (!hasIt) {
    throw forbiddenResponse(
      `Token does not have the ${feature} capability for this space`,
    );
  }
}

/**
 * Authenticate request with either user session or access token
 * Returns { type: "user", user } or { type: "token", token }
 */
export async function authenticateRequest(
  context: APIContext,
  spaceId: string,
): Promise<
  | { type: "user"; user: NonNullable<APIContext["locals"]["user"]> }
  | { type: "token"; token: ValidateTokenResult }
> {
  // Try user session first
  const user = context.locals.user;
  if (user) {
    return { type: "user", user };
  }

  // Try access token
  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    return { type: "token", token: tokenResult };
  }

  throw unauthorizedResponse();
}
