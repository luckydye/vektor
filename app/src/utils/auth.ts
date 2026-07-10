import type { ApiContext } from "#api/server/types.ts";
import { getTokenUserId } from "#db/accessTokens.ts";
import { getUserGroups, hasPermission, ResourceType } from "#db/acl.ts";
import {
  authenticateWithToken,
  forbiddenResponse,
  requireUser,
  tryAuthenticateRequest,
  unauthorizedResponse,
  verifyCategoryRole,
  verifyDocumentRole,
  verifySpaceRole,
  verifyTokenPermission,
} from "#db/api.ts";
import type { AclViewer } from "#db/documents.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

/**
 * Verify `userId` actually holds `requiredRole` on `target`, using the same
 * resolution as an interactive session would: document targets fall back to
 * the space role (see `hasPermission`), everything else is gated on the space
 * role directly. Throws a 403/404 Response on failure.
 */
async function enforceUserRoleOnTarget(
  spaceId: string,
  userId: string,
  requiredRole: string,
  target: { type: ResourceType; id: string },
): Promise<void> {
  if (target.type === ResourceType.DOCUMENT) {
    await verifyDocumentRole(spaceId, target.id, userId, requiredRole);
  } else if (target.type === ResourceType.CATEGORY) {
    await verifyCategoryRole(spaceId, target.id, userId, requiredRole);
  } else {
    await verifySpaceRole(spaceId, userId, requiredRole);
  }
}

/**
 * Authenticate a request that may originate from:
 *  - an HMAC job token (`X-Job-Token`) — a server-minted credential that
 *    carries the initiating user's id. When a user id is present the token is
 *    NOT trusted blindly: it is scoped to exactly what that user may do on the
 *    target (a token minted at space-viewer level must not become a skeleton
 *    key for documents the user cannot access).
 *    A user-less token (`userId === null`) is a system/background credential
 *    and remains fully trusted within its space;
 *  - a space access token (`Authorization: Bearer at_...`) — a long-lived
 *    credential whose authority is defined entirely by its ACL entries
 *    (`token:<id>`); or
 *  - a logged-in user session.
 *
 * For every credential that carries a user identity we MUST verify it actually
 * holds `requiredRole` on the target resource. By default the target is the
 * space itself; pass `resource` to check a more specific node (e.g. a document)
 * so resource-scoped credentials are neither over- nor under-privileged.
 */
export async function authenticateJobTokenOrSpaceRole(
  context: ApiContext,
  spaceId: string,
  requiredRole: string,
  resource?: { type: ResourceType; id: string },
): Promise<
  | { type: "job"; userId: string | null }
  | { type: "user"; user: NonNullable<App.Locals["user"]> }
> {
  const target = resource ?? { type: ResourceType.SPACE, id: spaceId };

  const jobToken = context.req.raw.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw forbiddenResponse("Invalid job token");
    // A token carrying a user id only grants that user's real access. Only
    // user-less system tokens keep the historical "fully trusted" behaviour.
    if (parsed.userId) {
      await enforceUserRoleOnTarget(spaceId, parsed.userId, requiredRole, target);
    }
    return { type: "job", userId: parsed.userId };
  }

  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    // Access tokens are NOT trusted job tokens: their authority is whatever the
    // ACL grants `token:<id>`. Enforce the required role before proceeding,
    // otherwise any valid (even viewer-scoped) token passes write gates.
    await verifyTokenPermission(
      tokenResult,
      spaceId,
      target.type,
      target.id,
      requiredRole,
    );
    return { type: "job", userId: getTokenUserId(tokenResult.tokenId) };
  }

  const user = requireUser(context);
  await enforceUserRoleOnTarget(spaceId, user.id, requiredRole, target);
  return { type: "user", user };
}

/**
 * Result of {@link authenticateSpaceAccess}.
 */
export interface SpaceAccess {
  /** The authenticated user, if session-based. */
  user?: NonNullable<App.Locals["user"]>;
  /**
   * Identity for per-document ACL filtering. `null` means a trusted system
   * caller (user-less job token) that sees everything; an empty string means
   * public access (use with `["public"]` groups).
   */
  aclUserId: string | null;
  /** Groups for ACL filtering, populated for user sessions and public access. */
  aclGroups?: string[];
  /** True when access was granted via the `public` group (unauthenticated). */
  isPublic: boolean;
}

/**
 * Convert a {@link SpaceAccess} result into an {@link AclViewer} for
 * per-document ACL filtering. Returns `null` for trusted system callers.
 */
export function spaceAccessToViewer(access: SpaceAccess): AclViewer | null {
  if (access.aclUserId === null) return null;
  return { userId: access.aclUserId, userGroups: access.aclGroups };
}

/**
 * Unified space-access guard. Handles every credential type:
 *
 *  - **HMAC job token** (`X-Job-Token`): user-scoped tokens are verified
 *    against the user's real role; user-less system tokens are trusted.
 *  - **Access token** (`Authorization: Bearer at_…`): verified via ACL
 *    (`token:<id>` identity).
 *  - **User session**: verified via `verifySpaceRole`.
 *  - **Unauthenticated**: admitted when the `public` group holds
 *    `requiredRole` on the space; otherwise throws 401.
 *
 * Throws a 401/403 Response on failure. On success returns the identity
 * information callers need for downstream per-document ACL filtering.
 *
 * @example
 * ```ts
 * // Simple gate (throws if unauthorized):
 * await authenticateSpaceAccess(context, spaceId, "viewer");
 *
 * // Gate + identity for ACL filtering:
 * const access = await authenticateSpaceAccess(context, spaceId, "viewer");
 * const viewer = spaceAccessToViewer(access);
 * const docs = await listDocuments(spaceId, 50, undefined, viewer);
 * ```
 */
export async function authenticateSpaceAccess(
  context: ApiContext,
  spaceId: string,
  requiredRole: string,
): Promise<SpaceAccess> {
  // 1. Job token
  const jobToken = context.req.raw.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw forbiddenResponse("Invalid job token");
    if (parsed.userId) {
      await verifySpaceRole(spaceId, parsed.userId, requiredRole);
      return {
        aclUserId: parsed.userId,
        aclGroups: await getUserGroups(parsed.userId),
        isPublic: false,
      };
    }
    // User-less system token — fully trusted within the space.
    return { aclUserId: null, isPublic: false };
  }

  // 2. Session or access token
  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "user") {
    await verifySpaceRole(spaceId, auth.user.id, requiredRole);
    return {
      user: auth.user,
      aclUserId: auth.user.id,
      aclGroups: await getUserGroups(auth.user.id),
      isPublic: false,
    };
  }
  if (auth?.type === "token") {
    await verifyTokenPermission(
      auth.token,
      spaceId,
      ResourceType.SPACE,
      spaceId,
      requiredRole,
    );
    return {
      aclUserId: getTokenUserId(auth.token.tokenId),
      isPublic: false,
    };
  }

  // 3. Unauthenticated — check public group access
  const hasPublicAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    "",
    requiredRole,
    ["public"],
  );
  if (!hasPublicAccess) {
    throw unauthorizedResponse();
  }
  return {
    aclUserId: "",
    aclGroups: ["public"],
    isPublic: true,
  };
}
