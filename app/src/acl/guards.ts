/**
 * The enforcement layer: everything a route calls to gate a request.
 *
 * Two tiers. `verify*` asks the ACL whether an identity holds a role/feature on
 * one resource. `authenticate*` sits above it, resolving whichever credential
 * the request carries (job token, access token, session, or none) to an
 * identity first. Both throw a 401/403/404 Response rather than returning a
 * verdict, so a route that forgets to handle the failure path fails closed.
 */

import {
  type AclViewer,
  allPermissions,
  Feature,
  isPermission,
  meetsPermissionLevel,
  Permission,
  PUBLIC_GROUP,
  ResourceType,
} from "#acl/permissions.ts";
import {
  getUserGroups,
  hasAnyResourceScopedAccess,
  hasFeature,
  hasPermission,
  listAccessibleResources,
} from "#acl/store.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  notFoundResponse,
  requireUser,
  unauthorizedResponse,
} from "#api/http.ts";
import type { ApiContext } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import type { ValidateTokenResult } from "#db/space/accessTokens.ts";
import { getTokenUserId, validateAccessToken } from "#db/space/accessTokens.ts";
import { getDocument, getDocumentAuthState } from "#db/space/documents.ts";
import { getSpace } from "#db/space/spaces.ts";
import { parseJobToken } from "#jobs/jobToken.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "#noAuth";

/** Distinguishes an access verdict from a failure to read the ACL. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof Response;
}

/**
 * Verify `userId` actually holds `requiredRole` on `target`, using the same
 * resolution as an interactive session would: document targets fall back to
 * the space role (see `hasPermission`), everything else is gated on the space
 * role directly. Throws a 403/404 Response on failure.
 */
async function enforceUserRoleOnTarget(
  spaceId: string,
  userId: string,
  requiredRole: Permission,
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
 *    credential that remains valid while its creator belongs to the space and
 *    whose authority is defined by its ACL entries (`token:<id>`); or
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
  requiredRole: Permission,
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
 * Authorize a request against one document, whichever credential it carries —
 * the document-scoped sibling of {@link authenticateJobTokenOrSpaceRole},
 * extended with the unauthenticated case. For a resource that belongs to a
 * document rather than to the space, an attachment above all.
 *
 * Returns the caller's ACL identity in the {@link SpaceAccess.aclUserId}
 * convention: `null` is a trusted system caller, `""` is public.
 */
export async function authenticateDocumentAccess(
  context: ApiContext,
  spaceId: string,
  documentId: string,
  requiredRole: Permission,
): Promise<{ aclUserId: string | null }> {
  const jobToken = context.req.raw.headers.get("X-Job-Token");
  if (jobToken) {
    // A token that does not parse is a bad credential, not an insufficient
    // one — 401, as the document routes have always answered a forged one.
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw unauthorizedResponse();
    // Only user-less system tokens read without a per-document check.
    if (parsed.userId) {
      await verifyDocumentRole(spaceId, documentId, parsed.userId, requiredRole);
    }
    return { aclUserId: parsed.userId };
  }

  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "token") {
    await verifyTokenPermission(
      auth.token,
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      requiredRole,
    );
    return { aclUserId: getTokenUserId(auth.token.tokenId) };
  }
  if (auth?.type === "user") {
    await verifyDocumentRole(spaceId, documentId, auth.user.id, requiredRole);
    return { aclUserId: auth.user.id };
  }

  // Unauthenticated — verifyDocumentRole handles the `public` group.
  await verifyDocumentRole(spaceId, documentId, null, requiredRole);
  return { aclUserId: "" };
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
   * public access (use with `[PUBLIC_GROUP]` groups).
   */
  aclUserId: string | null;
  /** Groups for ACL filtering, populated for user sessions and public access. */
  aclGroups?: string[];
  /**
   * True when access was granted via the `public` group (unauthenticated).
   * Callers that read this as "trusted, skip per-document filtering" must check
   * `documentScope` too: a public caller can also arrive on a document grant.
   */
  isPublic: boolean;
  /**
   * Set only when `allowResourceGrants` admitted a caller who holds no
   * space-wide role: the documents their grants reach, which is everything they
   * may see in the space. See {@link AclViewer.documentScope}.
   */
  documentScope?: string[] | null;
}

/**
 * Convert a {@link SpaceAccess} result into an {@link AclViewer} for
 * per-document ACL filtering. Returns `null` for trusted system callers.
 */
export function spaceAccessToViewer(access: SpaceAccess): AclViewer | null {
  if (access.aclUserId === null) return null;
  return {
    userId: access.aclUserId,
    userGroups: access.aclGroups,
    documentScope: access.documentScope,
  };
}

/** Options for {@link authenticateSpaceAccess}. */
export interface SpaceAccessOptions {
  /**
   * Admit a caller who holds no space-wide role but does hold a
   * document/tree/category grant in the space, confining them to the documents
   * those grants reach (`documentScope` on the result). Only for endpoints that
   * list documents, or things owned by documents, and then filter every row
   * against that scope. Endpoints exposing space-wide collections that cannot
   * be filtered per document (members, integrations) must leave it off.
   */
  allowResourceGrants?: boolean;
}

/**
 * The space-role check behind {@link authenticateSpaceAccess}, widened for
 * `allowResourceGrants` callers. Returns the caller's `documentScope`: `null`
 * when a space-wide role carries the whole space, or the allowlist a
 * resource-scoped grantee is confined to. Throws the original 403 when the
 * caller holds neither.
 */
async function spaceRoleOrDocumentScope(
  spaceId: string,
  userId: string,
  requiredRole: Permission,
  userGroups: string[] | undefined,
  options: SpaceAccessOptions | undefined,
  verifyRole: () => Promise<void>,
): Promise<string[] | null> {
  try {
    await verifyRole();
    return null;
  } catch (error) {
    if (!options?.allowResourceGrants) throw error;
    // Only widen on "forbidden" (no space-wide grant) — a 401/404 means the
    // credential or the space itself is the problem.
    if (!(error instanceof Response) || error.status !== 403) throw error;

    const documentIds = await listAccessibleResources(
      spaceId,
      userId,
      ResourceType.DOCUMENT,
      userGroups,
      requiredRole,
    );
    if (!documentIds || documentIds.length === 0) throw error;
    return documentIds;
  }
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
 * await authenticateSpaceAccess(context, spaceId, Permission.VIEWER);
 *
 * // Gate + identity for ACL filtering:
 * const access = await authenticateSpaceAccess(context, spaceId, Permission.VIEWER);
 * const viewer = spaceAccessToViewer(access);
 * const docs = await listDocuments(spaceId, { limit: 50, viewer });
 * ```
 */
export async function authenticateSpaceAccess(
  context: ApiContext,
  spaceId: string,
  requiredRole: Permission,
  options?: SpaceAccessOptions,
): Promise<SpaceAccess> {
  // 1. Job token
  const jobToken = context.req.raw.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw forbiddenResponse("Invalid job token");
    const { userId } = parsed;
    if (userId) {
      // A job token is the user's own access, resource grants included: work
      // they can start from the browser must not be refused because it went
      // through an agent or a workflow.
      const aclGroups = await getUserGroups(userId);
      const documentScope = await spaceRoleOrDocumentScope(
        spaceId,
        userId,
        requiredRole,
        aclGroups,
        options,
        () => verifySpaceRole(spaceId, userId, requiredRole),
      );
      return {
        aclUserId: userId,
        aclGroups,
        isPublic: false,
        documentScope,
      };
    }
    // User-less system token — fully trusted within the space.
    return { aclUserId: null, isPublic: false };
  }

  // 2. Session or access token
  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "user") {
    const aclGroups = await getUserGroups(auth.user.id);
    const documentScope = await spaceRoleOrDocumentScope(
      spaceId,
      auth.user.id,
      requiredRole,
      aclGroups,
      options,
      () => verifySpaceRole(spaceId, auth.user.id, requiredRole),
    );
    return {
      user: auth.user,
      aclUserId: auth.user.id,
      aclGroups,
      isPublic: false,
      documentScope,
    };
  }
  if (auth?.type === "token") {
    const tokenUserId = getTokenUserId(auth.token.tokenId);
    const documentScope = await spaceRoleOrDocumentScope(
      spaceId,
      tokenUserId,
      requiredRole,
      undefined,
      options,
      () =>
        verifyTokenPermission(
          auth.token,
          spaceId,
          ResourceType.SPACE,
          spaceId,
          requiredRole,
        ),
    );
    return {
      aclUserId: tokenUserId,
      isPublic: false,
      documentScope,
    };
  }

  // 3. Unauthenticated — check public group access. A space that does not
  // exist is a 401 like any other refusal, not the error reading its ACL would
  // raise.
  if (!(await getSpace(spaceId))) {
    throw unauthorizedResponse();
  }
  const hasPublicAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    "",
    requiredRole,
    [PUBLIC_GROUP],
  );
  if (!hasPublicAccess) {
    const documentScope = options?.allowResourceGrants
      ? await listAccessibleResources(
          spaceId,
          "",
          ResourceType.DOCUMENT,
          [PUBLIC_GROUP],
          requiredRole,
        )
      : null;
    // A document shared with the `public` group in an otherwise private space:
    // browsable, but only as far as that grant reaches.
    if (!documentScope || documentScope.length === 0) {
      throw unauthorizedResponse();
    }
    return {
      aclUserId: "",
      aclGroups: [PUBLIC_GROUP],
      isPublic: true,
      documentScope,
    };
  }
  return {
    aclUserId: "",
    aclGroups: [PUBLIC_GROUP],
    isPublic: true,
  };
}

export async function verifySpaceAccess(spaceId: string, userId: string): Promise<void> {
  const space = await getSpace(spaceId);
  if (!space) {
    throw notFoundResponse("Space");
  }

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return;
  }

  const userGroups = await getUserGroups(userId);
  const hasAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    Permission.VIEWER,
    userGroups,
  );
  if (!hasAccess) {
    throw forbiddenResponse();
  }
}

export async function verifySpaceRole(
  spaceId: string,
  userId: string,
  requiredRole: Permission,
): Promise<void> {
  const space = await getSpace(spaceId);
  if (!space) {
    throw notFoundResponse("Space");
  }

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
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

/**
 * Like `verifySpaceRole(..., Permission.VIEWER)`, but also lets through a user who
 * holds no space-wide grant but does hold a document/tree/category grant
 * somewhere in the space — they need to be able to reach the space
 * container their resource lives in. Only use this for endpoints that
 * expose bare space metadata; endpoints that list space-wide collections
 * (members, integrations, etc.) must keep using `verifySpaceRole`
 * directly so resource-scoped grantees aren't handed unrelated data.
 */
export async function verifyResourceAccess(
  spaceId: string,
  userId: string,
): Promise<void> {
  try {
    await verifySpaceRole(spaceId, userId, Permission.VIEWER);
    return;
  } catch (error) {
    // Only widen on "forbidden" (no space-wide grant) — a 404 (space
    // doesn't exist) or any other error must propagate unchanged.
    if (!(error instanceof Response) || error.status !== 403) {
      throw error;
    }
    const userGroups = await getUserGroups(userId);
    if (await hasAnyResourceScopedAccess(spaceId, userId, userGroups)) {
      return;
    }
    throw error;
  }
}

/**
 * The role a caller must hold on a document, raised to `editor` while it is
 * archived: archive is the trash, so a viewer-level grant — a public link
 * included — stops resolving without being revoked, and a restore brings the
 * shares back with it. `exists` is returned rather than thrown on because the
 * two guards below disagree about what a missing document means.
 */
async function requiredRoleForDocument(
  spaceId: string,
  documentId: string,
  requiredRole: Permission,
): Promise<{ exists: boolean; requiredRole: Permission }> {
  const state = await getDocumentAuthState(await openSpaceStore(spaceId), documentId);
  if (!state?.archived) {
    return { exists: state != null, requiredRole };
  }
  return {
    exists: true,
    requiredRole: meetsPermissionLevel(requiredRole, Permission.EDITOR)
      ? requiredRole
      : Permission.EDITOR,
  };
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

  // `exists` is ignored: unlike verifyDocumentRole, this guard has never told
  // "no such document" apart from "not allowed".
  const { requiredRole } = await requiredRoleForDocument(
    spaceId,
    documentId,
    Permission.VIEWER,
  );

  // For unauthenticated users, check if document has public access
  if (!userId) {
    const hasPublicAccess = await hasPermission(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      "", // Empty userId for public check
      requiredRole,
      [PUBLIC_GROUP],
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
    requiredRole,
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
  requiredRole: Permission,
): Promise<void> {
  // Reject references to documents that do not exist before evaluating access,
  // mirroring verifySpaceRole. Otherwise no-auth mode (where hasPermission short
  // -circuits to true) would authorize any documentId, real or not.
  const { exists, requiredRole: effectiveRole } = await requiredRoleForDocument(
    spaceId,
    documentId,
    requiredRole,
  );
  if (!exists) {
    throw notFoundResponse("Document");
  }

  // For unauthenticated users, check if document has public access with required role
  if (!userId) {
    const hasPublicAccess = await hasPermission(
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      "", // Empty userId for public check
      effectiveRole,
      [PUBLIC_GROUP],
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
    effectiveRole,
    userGroups,
  );
  if (!hasRole) {
    throw forbiddenResponse();
  }
}

export async function verifyCategoryRole(
  spaceId: string,
  categoryId: string,
  userId: string | null,
  requiredRole: Permission,
): Promise<void> {
  if (!userId) {
    const hasPublicAccess = await hasPermission(
      spaceId,
      ResourceType.CATEGORY,
      categoryId,
      "",
      requiredRole,
      [PUBLIC_GROUP],
    );
    if (!hasPublicAccess) {
      throw unauthorizedResponse();
    }
    return;
  }

  const userGroups = await getUserGroups(userId);
  const hasCategoryRole = await hasPermission(
    spaceId,
    ResourceType.CATEGORY,
    categoryId,
    userId,
    requiredRole,
    userGroups,
  );
  if (hasCategoryRole) return;

  const hasSpaceRole = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    requiredRole,
    userGroups,
  );
  if (!hasSpaceRole) {
    throw forbiddenResponse();
  }
}

/**
 * Verify user has access to a specific feature, throws 403 if not.
 *
 * @param documentId Resolve against this document's role rather than the space
 *   role, for a feature exercised on one document. See {@link hasFeature}.
 *
 * @example
 * await verifyFeatureAccess(spaceId, Feature.COMMENT, userId);
 * await verifyFeatureAccess(spaceId, Feature.VIEW_HISTORY, userId);
 */
export async function verifyFeatureAccess(
  spaceId: string,
  feature: Feature,
  userId: string,
  documentId?: string,
): Promise<void> {
  const userGroups = await getUserGroups(userId);
  const hasAccess = await hasFeature(spaceId, feature, userId, userGroups, documentId);
  if (!hasAccess) {
    throw forbiddenResponse(
      `You don't have access to the ${feature.replace("_", " ")} feature`,
    );
  }
}

/**
 * What a caller may read of a revision, once authorized. `metadata` is false for
 * a snapshot-exemption caller without `VIEW_HISTORY`: content, but not the
 * authorship, message, checksum or lineage `/revisions` gates.
 */
export interface RevisionAccess {
  metadata: boolean;
}

/**
 * The one rule for reading a document's revision history:
 *
 *  1. Exactly the published revision: plain read access, since the document GET
 *     serves the same content. Metadata is history, so the verdict says whether
 *     it may travel with it.
 *  2. Anything else: `Feature.VIEW_HISTORY`, never implied by a role.
 *
 * Reading history is one privilege and does not subdivide — whether a revision
 * was ever published decides nothing, since access to any revision is access to
 * all of them.
 *
 * @param userId The {@link SpaceAccess.aclUserId} convention: `null` is a
 *   trusted system caller, `""` is public. An access token passes
 *   `getTokenUserId(tokenId)`, which is its ACL identity.
 * @param revs The revisions whose **content** is about to be served. Omit for a
 *   listing of the whole history, which gets no snapshot exemption.
 */
export async function verifyRevisionAccess(
  spaceId: string,
  documentId: string,
  userId: string | null,
  revs?: readonly number[],
): Promise<RevisionAccess> {
  // A user-less system token is the space's own background work.
  if (userId === null) return { metadata: true };

  const requested = revs ?? [];

  let publishedRev: number | null = null;
  if (requested.length > 0) {
    const document = await getDocument(await openSpaceStore(spaceId), documentId);
    if (!document) {
      throw notFoundResponse("Document");
    }
    publishedRev = document.publishedRev;
  }

  const userGroups = userId === "" ? [PUBLIC_GROUP] : await getUserGroups(userId);
  const history = await hasFeature(
    spaceId,
    Feature.VIEW_HISTORY,
    userId,
    userGroups,
    documentId,
  );

  // Plain read access already buys the published snapshot's content.
  const snapshotOnly =
    requested.length > 0 && requested.every((rev) => rev === publishedRev);
  if (snapshotOnly) {
    return { metadata: history };
  }

  if (!history) {
    throw forbiddenResponse("You don't have access to the view history feature");
  }

  return { metadata: true };
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

  const userGroups = await getUserGroups(userId);

  // Check if user has editor permission on space (editors can access all extensions)
  const isEditor = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    Permission.EDITOR,
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
    Permission.VIEWER,
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

/** Resource types a token grant may target. Secrets/features are intentionally
 * excluded — those have dedicated, more tightly-scoped grant flows. */
const TOKEN_GRANTABLE_RESOURCE_TYPES: ResourceType[] = [
  ResourceType.SPACE,
  ResourceType.DOCUMENT,
  ResourceType.CATEGORY,
  ResourceType.EXTENSION,
];

/**
 * Validate a token grant and return the role it names. Shape only — authority is
 * bounded at use. Keeps values that name nothing (a typo'd role, the old
 * "extensions" pseudo-permission) out of the ACL, where they would sit as a
 * grant that silently does nothing. Throws a 400 Response.
 */
export function validateTokenGrant(
  resourceType: ResourceType,
  permission: string,
): Permission {
  if (!isPermission(permission)) {
    throw badRequestResponse(`Permission must be one of: ${allPermissions().join(", ")}`);
  }
  if (!TOKEN_GRANTABLE_RESOURCE_TYPES.includes(resourceType)) {
    throw badRequestResponse(
      `Token access cannot be granted for resource type: ${resourceType}`,
    );
  }
  // Owner is authority over the space; below that scope it names nothing, so a
  // token cannot be handed it there either.
  if (permission === Permission.OWNER && resourceType !== ResourceType.SPACE) {
    throw badRequestResponse("owner can only be granted on the space itself");
  }

  return permission;
}

/**
 * Extract access token from Authorization header
 * Supports: "Bearer at_xxxxx" or "at_xxxxx"
 */
export function extractAccessToken(context: ApiContext): string | null {
  const authHeader = context.req.raw.headers.get("Authorization");
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
 *     Permission.EDITOR
 *   );
 * }
 * ```
 */
export async function authenticateWithToken(
  context: ApiContext,
  spaceId: string,
): Promise<ValidateTokenResult | null> {
  const token = extractAccessToken(context);
  if (!token) {
    return null;
  }

  const result = await validateAccessToken(await openSpaceStore(spaceId), token);
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
 * await verifyTokenPermission(tokenAuth, spaceId, "document", "doc123", Permission.EDITOR);
 * ```
 */
export async function verifyTokenPermission(
  tokenResult: ValidateTokenResult,
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  requiredPermission: Permission,
): Promise<void> {
  const tokenUserId = getTokenUserId(tokenResult.tokenId);

  // A token is a delegation of a user's access, so an archived document raises
  // its bar too.
  const effectivePermission =
    resourceType === ResourceType.DOCUMENT
      ? (await requiredRoleForDocument(spaceId, resourceId, requiredPermission))
          .requiredRole
      : requiredPermission;

  const hasAccess = await hasPermission(
    spaceId,
    resourceType,
    resourceId,
    tokenUserId,
    effectivePermission,
  );

  if (!hasAccess) {
    throw forbiddenResponse(
      `Token does not have ${effectivePermission} permission for this ${resourceType}`,
    );
  }
}

/**
 * Verify a token holds a space-wide `feature` capability, so a token granted one
 * acts across the whole space. A plain viewer/editor token is rejected unless the
 * role's defaults include the feature.
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
  context: ApiContext,
  spaceId: string,
): Promise<
  | { type: "user"; user: NonNullable<App.Locals["user"]> }
  | { type: "token"; token: ValidateTokenResult }
> {
  // Try user session first
  const user = context.var.user;
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

/**
 * Like authenticateRequest, but returns null instead of throwing when the
 * caller is unauthenticated. Callers must separately verify that the space
 * grants the `public` group the required role before proceeding, otherwise
 * the request must be rejected with unauthorizedResponse().
 */
export async function tryAuthenticateRequest(
  context: ApiContext,
  spaceId: string,
): Promise<
  | { type: "user"; user: NonNullable<App.Locals["user"]> }
  | { type: "token"; token: ValidateTokenResult }
  | null
> {
  const user = context.var.user;
  if (user) {
    return { type: "user", user };
  }

  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    return { type: "token", token: tokenResult };
  }

  return null;
}

/**
 * Verify that the `public` group has the required role on a space, granting
 * unauthenticated callers access. Throws unauthorizedResponse() otherwise.
 */
export async function verifyPublicSpaceRole(
  spaceId: string,
  requiredRole: Permission,
): Promise<void> {
  const hasPublicAccess = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    "",
    requiredRole,
    [PUBLIC_GROUP],
  );
  if (!hasPublicAccess) {
    throw unauthorizedResponse();
  }
}
