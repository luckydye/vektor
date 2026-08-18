/**
 * The enforcement layer: everything a route calls to gate a request.
 *
 * One access question, asked in one place. {@link decideAccess} decides whether
 * an identity may act on a resource; {@link verifyAccess} throws that decision
 * and {@link canAccess} returns it as a boolean, and there is no third way to
 * ask. `authenticate*` sits on top, resolving whichever credential the request
 * carries (job token, access token, session, or none) to an identity first.
 * Guards throw a 401/403/404 Response rather than returning a decision, so a
 * route that forgets the failure path fails closed.
 *
 * Features are the exception: {@link verifyFeatureAccess} and
 * {@link verifyRevisionAccess} ask about a capability rather than a resource.
 */

import { isInstanceAdmin } from "#acl/instanceGroups.ts";
import {
  type AclViewer,
  allPermissions,
  Feature,
  isPermission,
  meetsPermissionLevel,
  Permission,
  PUBLIC_GROUP,
  ResourceType,
  tokenIdFromPrincipal,
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
import { getIndexedSpace } from "#db/auth/spaceIndex.ts";
import { initializeDatabases } from "#db/client/db.ts";
import { openSpaceStore } from "#db/client/store.ts";
import type { ValidateTokenResult } from "#db/space/accessTokens.ts";
import { getTokenUserId, validateAccessToken } from "#db/space/accessTokens.ts";
import { getDocument, getDocumentAuthState } from "#db/space/documents.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

/** Distinguishes an access decision from a failure to read the ACL. */
export function isAccessDenied(error: unknown): boolean {
  return error instanceof Response;
}

/** A resource to gate a request on. */
interface AclTarget {
  type: ResourceType;
  id: string;
  /**
   * Space targets only: also admit a caller who holds any resource-scoped grant
   * inside the space, who must reach the container their resource lives in.
   * Only for endpoints exposing bare space metadata — one that lists a
   * space-wide collection (members, integrations) would hand a resource-scoped
   * grantee unrelated data.
   */
  anyGrantInSpace?: boolean;
}

/**
 * Whether the space exists, from the index rather than by reading the space:
 * a guard needs the fact, not the metadata and preferences behind it.
 */
async function spaceExists(spaceId: string): Promise<boolean> {
  await initializeDatabases();
  return (await getIndexedSpace(spaceId)) !== null;
}

/**
 * Throw 404 unless the space exists, ahead of anything that opens its database
 * — a space that is not there must surface as a decision, not as a read error.
 * Exported for a route that reads the space before it can pick its guard.
 */
export async function requireSpace(spaceId: string): Promise<void> {
  if (!(await spaceExists(spaceId))) {
    throw notFoundResponse("Space");
  }
}

/**
 * The groups an ACL question resolves against: the `public` group for an
 * unauthenticated caller, none for an access token — its `token:<id>` principal
 * carries its own grants — and the user's own groups otherwise.
 */
async function aclGroups(userId: string | null): Promise<string[] | undefined> {
  if (!userId) return [PUBLIC_GROUP];
  if (tokenIdFromPrincipal(userId)) return undefined;
  return await getUserGroups(userId);
}

/** Why {@link decideAccess} answered the way it did. */
type AccessDecision = "ok" | "no-space" | "no-document" | "denied";

/**
 * **The** access question: may `userId` act on `target` at `requiredRole`?
 * Every guard in this file is a caller of it, so a rule added here holds for
 * sessions, access tokens, job tokens and public callers alike.
 *
 * @param userId The {@link SpaceAccess.aclUserId} convention: `null` or `""` is
 *   unauthenticated, `token:<id>` an access token, anything else a user.
 * @returns The decision, and the role it was actually decided at — which an
 *   archived document raises above the one that was asked for.
 */
async function decideAccess(
  spaceId: string,
  target: AclTarget,
  userId: string | null,
  requiredRole: Permission,
): Promise<{ decision: AccessDecision; requiredRole: Permission }> {
  if (!(await spaceExists(spaceId))) {
    return { decision: "no-space", requiredRole };
  }

  // A document is the one resource whose own state moves the bar, and the one
  // whose absence is worth telling apart from a refusal.
  let effectiveRole = requiredRole;
  if (target.type === ResourceType.DOCUMENT) {
    const document = await requiredRoleForDocument(spaceId, target.id, requiredRole);
    if (!document.exists) {
      return { decision: "no-document", requiredRole };
    }
    effectiveRole = document.requiredRole;
  }

  const principal = userId || "";
  const groups = await aclGroups(userId);
  let granted = await hasPermission(
    spaceId,
    target.type,
    target.id,
    principal,
    effectiveRole,
    groups,
  );
  // A resource-scoped grantee holds no row on the space itself. Widening here
  // rather than in a caller keeps the anonymous case on the same path: `""` is
  // refused like anyone else, not short-circuited into a 401.
  if (!granted && target.anyGrantInSpace) {
    granted = await hasAnyResourceScopedAccess(spaceId, principal, groups);
  }
  // An instance admin holds every role in every space, so the check sits here
  // rather than in the routes that care: it has to hold for a delete as much as
  // for a read, and asking it last leaves the ordinary path untouched.
  if (!granted) {
    granted = await isInstanceAdmin(principal);
  }
  return { decision: granted ? "ok" : "denied", requiredRole: effectiveRole };
}

/**
 * Answer {@link decideAccess} with a thrown 401/403/404 Response, so a route
 * that forgets the failure path fails closed. The single gate every route
 * passes through, whatever resource it is protecting.
 */
export async function verifyAccess(
  spaceId: string,
  target: AclTarget,
  userId: string | null,
  requiredRole: Permission,
): Promise<void> {
  const decided = await decideAccess(spaceId, target, userId, requiredRole);
  if (decided.decision === "ok") return;
  throw denialResponse(decided, target, userId);
}

/**
 * The Response a non-`ok` decision answers with. Split from {@link verifyAccess}
 * so a guard that widens a refusal can branch on the decision itself: the
 * 401/403 split below is presentation, and reading it back off a thrown
 * Response confuses "not allowed" with "not authenticated".
 */
function denialResponse(
  decided: { decision: AccessDecision; requiredRole: Permission },
  target: AclTarget,
  userId: string | null,
): Response {
  if (decided.decision === "no-space") return notFoundResponse("Space");
  if (decided.decision === "no-document") return notFoundResponse("Document");

  // An unauthenticated caller is told to authenticate; anyone else is told no.
  if (!userId) return unauthorizedResponse();
  if (tokenIdFromPrincipal(userId)) {
    return forbiddenResponse(
      `Token does not have ${decided.requiredRole} permission for this ${target.type}`,
    );
  }
  return forbiddenResponse();
}

/**
 * Answer {@link decideAccess} as a boolean, for a caller filtering a list
 * rather than gating a request.
 */
export async function canAccess(
  spaceId: string,
  target: AclTarget,
  userId: string | null,
  requiredRole: Permission,
): Promise<boolean> {
  return (await decideAccess(spaceId, target, userId, requiredRole)).decision === "ok";
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
      await verifyAccess(spaceId, target, parsed.userId, requiredRole);
    }
    return { type: "job", userId: parsed.userId };
  }

  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    // Access tokens are NOT trusted job tokens: their authority is whatever the
    // ACL grants `token:<id>`. Enforce the required role before proceeding,
    // otherwise any valid (even viewer-scoped) token passes write gates.
    await verifyAccess(
      spaceId,
      { type: target.type, id: target.id },
      getTokenUserId(tokenResult.tokenId),
      requiredRole,
    );
    return { type: "job", userId: getTokenUserId(tokenResult.tokenId) };
  }

  const user = requireUser(context);
  await verifyAccess(spaceId, target, user.id, requiredRole);
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
  // Ahead of the credential, not delegated to the guards below: authenticating
  // an access token opens the space store first, and a space that does not
  // exist must be a decision rather than the error opening its database.
  await requireSpace(spaceId);

  const jobToken = context.req.raw.headers.get("X-Job-Token");
  if (jobToken) {
    // A token that does not parse is a bad credential, not an insufficient
    // one — 401, as the document routes have always answered a forged one.
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw unauthorizedResponse();
    // Only user-less system tokens read without a per-document check.
    if (parsed.userId) {
      await verifyAccess(
        spaceId,
        { type: ResourceType.DOCUMENT, id: documentId },
        parsed.userId,
        requiredRole,
      );
    }
    return { aclUserId: parsed.userId };
  }

  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "token") {
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      getTokenUserId(auth.token.tokenId),
      requiredRole,
    );
    return { aclUserId: getTokenUserId(auth.token.tokenId) };
  }
  if (auth?.type === "user") {
    await verifyAccess(
      spaceId,
      { type: ResourceType.DOCUMENT, id: documentId },
      auth.user.id,
      requiredRole,
    );
    return { aclUserId: auth.user.id };
  }

  // Unauthenticated — the document check handles the `public` group.
  await verifyAccess(
    spaceId,
    { type: ResourceType.DOCUMENT, id: documentId },
    null,
    requiredRole,
  );
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
   * space-wide role: the resources of {@link SpaceAccessOptions.scopeType}
   * their grants reach, which is everything they may see in the space.
   */
  resourceScope?: string[] | null;
  /** The resource type {@link resourceScope} is expressed in. */
  scopeType?: ResourceType;
}

/**
 * Convert a {@link SpaceAccess} result into an {@link AclViewer} for
 * per-document ACL filtering. Returns `null` for trusted system callers.
 */
export function spaceAccessToViewer(access: SpaceAccess): AclViewer | null {
  if (access.aclUserId === null) return null;
  // A scope in any other resource type says nothing about which documents this
  // caller may read, so it must not be handed over as if it did.
  const scopedToDocuments =
    !access.scopeType || access.scopeType === ResourceType.DOCUMENT;
  return {
    userId: access.aclUserId,
    userGroups: access.aclGroups,
    documentScope: scopedToDocuments ? access.resourceScope : [],
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
  /**
   * The resource type such a grantee is confined to, documents unless set.
   * Categories ask the same question about their own rows.
   */
  scopeType?: ResourceType;
}

/** {@link SpaceAccessOptions.scopeType}, defaulted. */
function scopeType(options: SpaceAccessOptions | undefined): ResourceType {
  return options?.scopeType ?? ResourceType.DOCUMENT;
}

/**
 * The space-role check behind {@link authenticateSpaceAccess}, widened for
 * `allowResourceGrants` callers. Returns the caller's `resourceScope`: `null`
 * when a space-wide role carries the whole space, or the allowlist a
 * resource-scoped grantee is confined to. Throws the original 403 when the
 * caller holds neither.
 */
async function spaceRoleOrResourceScope(
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

    const scopedIds = await listAccessibleResources(
      spaceId,
      userId,
      scopeType(options),
      userGroups,
      requiredRole,
    );
    if (!scopedIds || scopedIds.length === 0) throw error;
    return scopedIds;
  }
}

/**
 * Unified space-access guard. Handles every credential type:
 *
 *  - **HMAC job token** (`X-Job-Token`): user-scoped tokens are verified
 *    against the user's real role; user-less system tokens are trusted.
 *  - **Access token** (`Authorization: Bearer at_…`): verified via ACL
 *    (`token:<id>` identity).
 *  - **User session**: verified against the space role.
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
      const resourceScope = await spaceRoleOrResourceScope(
        spaceId,
        userId,
        requiredRole,
        aclGroups,
        options,
        () =>
          verifyAccess(
            spaceId,
            { type: ResourceType.SPACE, id: spaceId },
            userId,
            requiredRole,
          ),
      );
      return {
        aclUserId: userId,
        aclGroups,
        isPublic: false,
        resourceScope,
        scopeType: scopeType(options),
      };
    }
    // User-less system token — fully trusted within the space.
    return { aclUserId: null, isPublic: false };
  }

  // 2. Session or access token
  const auth = await tryAuthenticateRequest(context, spaceId);
  if (auth?.type === "user") {
    const aclGroups = await getUserGroups(auth.user.id);
    const resourceScope = await spaceRoleOrResourceScope(
      spaceId,
      auth.user.id,
      requiredRole,
      aclGroups,
      options,
      () =>
        verifyAccess(
          spaceId,
          { type: ResourceType.SPACE, id: spaceId },
          auth.user.id,
          requiredRole,
        ),
    );
    return {
      user: auth.user,
      aclUserId: auth.user.id,
      aclGroups,
      isPublic: false,
      resourceScope,
      scopeType: scopeType(options),
    };
  }
  if (auth?.type === "token") {
    const tokenUserId = getTokenUserId(auth.token.tokenId);
    const resourceScope = await spaceRoleOrResourceScope(
      spaceId,
      tokenUserId,
      requiredRole,
      undefined,
      options,
      () =>
        verifyAccess(
          spaceId,
          { type: ResourceType.SPACE, id: spaceId },
          getTokenUserId(auth.token.tokenId),
          requiredRole,
        ),
    );
    return {
      aclUserId: tokenUserId,
      isPublic: false,
      resourceScope,
      scopeType: scopeType(options),
    };
  }

  // 3. Unauthenticated — admitted by the `public` group.
  const { decision } = await decideAccess(
    spaceId,
    { type: ResourceType.SPACE, id: spaceId },
    "",
    requiredRole,
  );
  // A space that does not exist is a 401 like any other refusal: its existence
  // is not something an anonymous caller gets to learn.
  if (decision === "no-space") {
    throw unauthorizedResponse();
  }
  if (decision !== "ok") {
    const resourceScope = options?.allowResourceGrants
      ? await listAccessibleResources(
          spaceId,
          "",
          scopeType(options),
          [PUBLIC_GROUP],
          requiredRole,
        )
      : null;
    // A document shared with the `public` group in an otherwise private space:
    // browsable, but only as far as that grant reaches.
    if (!resourceScope || resourceScope.length === 0) {
      throw unauthorizedResponse();
    }
    return {
      aclUserId: "",
      aclGroups: [PUBLIC_GROUP],
      isPublic: true,
      resourceScope,
      scopeType: scopeType(options),
    };
  }
  return {
    aclUserId: "",
    aclGroups: [PUBLIC_GROUP],
    isPublic: true,
  };
}

/**
 * The role a caller must hold on a document, raised to `editor` while it is
 * archived: archive is the trash, so a viewer-level grant — a public link
 * included — stops resolving without being revoked, and a restore brings the
 * shares back with it. Opens the space store, so only {@link decideAccess} may
 * call it — it has already established that the space is there.
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
 *     serves the same content. Metadata is history, so the decision says whether
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
 *   const canEdit = await canAccess(
 *     spaceId,
 *     { type: ResourceType.DOCUMENT, id: documentId },
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
