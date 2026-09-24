/**
 * The enforcement layer: everything a route calls to gate a request.
 *
 * {@link decideAccess} decides; {@link verifyAccess} and {@link canAccess} are
 * the only two ways to ask it. `authenticate*` sits on top, resolving whichever
 * credential the request carries — job token, access token, session, share link,
 * or none — to an identity first.
 *
 * Two rules hold throughout:
 *  - Nothing here takes a request. Guards read a {@link CallerCredentials}
 *    struct, which the API router builds once per request.
 *  - A guard may resolve an id, a decision may not. That is what keeps the IdP
 *    round-trip out of a permission check.
 *
 * {@link verifyFeatureAccess} and {@link verifyRevisionAccess} are the odd pair:
 * they ask about a capability rather than a resource.
 */

import {
  AclFailure,
  AuthenticationRequiredError,
  CredentialRejectedError,
  InvalidAclRequestError,
  PermissionDeniedError,
  ResourceUnavailableError,
  ShareLinkPasswordRequiredError,
} from "#acl/errors.ts";
import {
  type AccessIdentity,
  principalOf,
  type ResolvedIdentity,
  resolveIdentity,
  toIdentity,
} from "#acl/identity.ts";
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
  hasAnyResourceScopedAccess,
  hasFeature,
  hasPermission,
  listAccessibleResources,
} from "#acl/store.ts";
import { getIndexedSpace } from "#db/auth/spaceIndex.ts";
import { initializeDatabases } from "#db/client/db.ts";
import { openSpaceStore } from "#db/client/store.ts";
import type { ValidateTokenResult } from "#db/space/accessTokens.ts";
import { hasCredentialGrant, validateAccessToken } from "#db/space/accessTokens.ts";
import { getDocument, getDocumentAuthState } from "#db/space/documents.ts";
import {
  findShareLink,
  markShareLinkUsed,
  shareLinkProof,
  validateShareLink,
  verifyShareLinkProof,
} from "#db/space/shareLinks.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

export { isAccessDenied } from "#acl/errors.ts";

/**
 * What a request carries that a guard may authenticate, as plain data — the
 * three reads the `authenticate*` family used to take a Hono context for.
 */
export interface CallerCredentials {
  /** `X-Job-Token`: a server-minted HMAC credential. */
  jobToken?: string | null;
  /** The raw `Authorization` header, which may carry a space access token. */
  authorization?: string | null;
  /** The session user, when the request edge resolved one. */
  user?: NonNullable<App.Locals["user"]> | null;
  /** The raw `Cookie` header, which may carry share links; see {@link SHARE_COOKIE}. */
  cookie?: string | null;
}

/** A resource to gate a request on. */
export interface AclTarget {
  type: ResourceType;
  id: string;
  /**
   * Also admit a caller who holds any resource-scoped grant inside the space,
   * who must reach the container their resource lives in. Only for endpoints
   * exposing metadata the whole space may see — one that lists a space-wide
   * collection (members, integrations) would hand a resource-scoped grantee
   * unrelated data. It answers presence in the space, not rank, so it never
   * satisfies a bar a resource's own state raised.
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
 * Fail with {@link ResourceUnavailableError} unless the space exists, ahead of
 * anything that opens its database — absence is a decision, not a read error.
 * Exported for a route that reads the space before it can pick its guard.
 */
export async function requireSpace(spaceId: string): Promise<void> {
  if (!(await spaceExists(spaceId))) {
    throw new ResourceUnavailableError("Space");
  }
}

/** Why {@link decideAccess} answered the way it did. */
export type AccessDecision = "ok" | "no-space" | "no-document" | "denied";

/**
 * **The** access question: may `identity` act on `target` at `requiredRole`?
 * Every guard here calls it, so a rule added here holds for sessions, access
 * tokens, job tokens and public callers alike.
 *
 * @returns The decision, and the role it was actually decided at — which an
 *   archived document raises above the one that was asked for.
 */
export async function decideAccess(
  spaceId: string,
  target: AclTarget,
  identity: ResolvedIdentity,
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

  const principal = principalOf(identity);
  const groups = identity.groups;
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
  // refused like anyone else, not short-circuited by its anonymity. Never
  // applied to a bar the target's own state raised: presence is not that rank.
  if (!granted && target.anyGrantInSpace && effectiveRole === requiredRole) {
    granted = await hasAnyResourceScopedAccess(spaceId, principal, groups);
  }
  // An instance admin holds every role in every space, so the check sits here
  // rather than in the routes that care: it has to hold for a delete as much as
  // for a read, and asking it last leaves the ordinary path untouched.
  if (!granted) {
    granted = identity.isInstanceAdmin;
  }
  return { decision: granted ? "ok" : "denied", requiredRole: effectiveRole };
}

/**
 * The domain failure a non-`ok` decision is answered with.
 *
 * Separate from {@link decideAccess} because only this end knows whether a
 * denied caller authenticated. Anonymous denial uses
 * {@link ResourceUnavailableError} so a private resource is indistinguishable
 * from an absent one; authenticated denial uses {@link PermissionDeniedError}.
 */
async function denialFailure(
  spaceId: string,
  decided: { decision: AccessDecision; requiredRole: Permission },
  target: AclTarget,
  identity: ResolvedIdentity,
): Promise<AclFailure> {
  if (decided.decision === "no-space") {
    return new ResourceUnavailableError("Space");
  }
  if (decided.decision === "no-document") {
    return new ResourceUnavailableError("Document");
  }

  // Do not confirm a private resource exists to an anonymous caller.
  if (!identity.userId) {
    const resource =
      target.type === ResourceType.DOCUMENT_TREE
        ? "Document"
        : `${target.type.charAt(0).toUpperCase()}${target.type.slice(1)}`;
    return new ResourceUnavailableError(resource);
  }
  // A credential hears which role it lacked, since whoever integrated it owns
  // both ends of the call. Only asked on the refusal path, so the query is free.
  if (await hasCredentialGrant(await openSpaceStore(spaceId), identity.userId)) {
    return new PermissionDeniedError(
      `This credential does not have ${decided.requiredRole} permission for this ${target.type}`,
    );
  }
  return new PermissionDeniedError();
}

/**
 * Answer {@link decideAccess} with a thrown {@link AclFailure}, so a caller that
 * forgets the failure path fails closed. The single gate every protected
 * operation passes through, whatever resource it is protecting.
 */
export async function verifyAccess(
  spaceId: string,
  target: AclTarget,
  who: AccessIdentity,
  requiredRole: Permission,
): Promise<void> {
  const identity = await toIdentity(who);
  const decided = await decideAccess(spaceId, target, identity, requiredRole);
  if (decided.decision === "ok") return;
  throw await denialFailure(spaceId, decided, target, identity);
}

/**
 * Answer {@link decideAccess} as a boolean, for a caller filtering a list
 * rather than gating a request.
 */
export async function canAccess(
  spaceId: string,
  target: AclTarget,
  who: AccessIdentity,
  requiredRole: Permission,
): Promise<boolean> {
  return (
    (await decideAccess(spaceId, target, await toIdentity(who), requiredRole))
      .decision === "ok"
  );
}

/**
 * Authenticate whichever credential the request carries, and verify it holds
 * `requiredRole` on the target:
 *  - HMAC job token (`X-Job-Token`): scoped to what its user may do, so a
 *    viewer-level token is no skeleton key. A user-less one is the space's own
 *    background work and stays trusted.
 *  - Access token (`Authorization: Bearer at_...`): its authority is the ACL
 *    entries under its own id.
 *  - User session: their space role.
 *
 * @param resource A more specific node than the space, so a resource-scoped
 *   credential is neither over- nor under-privileged.
 */
export async function authenticateJobTokenOrSpaceRole(
  credentials: CallerCredentials,
  spaceId: string,
  requiredRole: Permission,
  resource?: { type: ResourceType; id: string },
): Promise<
  | { type: "job"; userId: string | null }
  | { type: "user"; user: NonNullable<App.Locals["user"]> }
> {
  const target = resource ?? { type: ResourceType.SPACE, id: spaceId };

  const jobToken = credentials.jobToken;
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) {
      throw new CredentialRejectedError("Invalid job token");
    }
    // A token carrying a user id only grants that user's real access. Only
    // user-less system tokens keep the historical "fully trusted" behaviour.
    if (parsed.userId) {
      await verifyAccess(spaceId, target, parsed.userId, requiredRole);
    }
    return { type: "job", userId: parsed.userId };
  }

  const tokenResult = await authenticateWithToken(credentials, spaceId);
  if (tokenResult) {
    // Access tokens are NOT trusted job tokens: their authority is whatever the
    // ACL grants that token's id. Enforce the required role before proceeding,
    // otherwise any valid (even viewer-scoped) token passes write gates.
    await verifyAccess(
      spaceId,
      { type: target.type, id: target.id },
      tokenResult.tokenId,
      requiredRole,
    );
    return { type: "job", userId: tokenResult.tokenId };
  }

  const user = credentials.user;
  if (!user) throw new AuthenticationRequiredError();
  await verifyAccess(spaceId, target, user.id, requiredRole);
  return { type: "user", user };
}

/**
 * The document-scoped sibling of {@link authenticateJobTokenOrSpaceRole},
 * extended with the unauthenticated case. For a resource belonging to a document
 * rather than to the space — an attachment above all.
 *
 * @param options.shareLinks Whether the share cookie counts here. Off by
 *   default: a link serves a rendered page, not the application, so it reaches
 *   only what that page itself loads — turn it on there and nowhere else, or a
 *   link quietly grants everything a viewer may read about the document.
 * @returns The caller in the {@link SpaceAccess.aclUserId} convention: `null` is
 *   a trusted system caller, `""` is public.
 */
export async function authenticateDocumentAccess(
  credentials: CallerCredentials,
  spaceId: string,
  documentId: string,
  requiredRole: Permission,
  options: Pick<AclTarget, "anyGrantInSpace"> & { shareLinks?: boolean } = {},
): Promise<{ aclUserId: string | null }> {
  // Ahead of the credential, not delegated to the guards below: authenticating
  // an access token opens the space store first, and a space that does not
  // exist must be a decision rather than the error opening its database.
  await requireSpace(spaceId);

  const { shareLinks, ...targetOptions } = options;
  const target: AclTarget = {
    type: ResourceType.DOCUMENT,
    id: documentId,
    ...targetOptions,
  };

  const jobToken = credentials.jobToken;
  if (jobToken) {
    // A token that does not parse is a rejected credential, not an identity
    // that merely holds insufficient access.
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw new CredentialRejectedError();
    // Only user-less system tokens read without a per-document check.
    if (parsed.userId) {
      await verifyAccess(spaceId, target, parsed.userId, requiredRole);
    }
    return { aclUserId: parsed.userId };
  }

  const auth = await tryAuthenticateRequest(credentials, spaceId);
  if (auth?.type === "token") {
    await verifyAccess(spaceId, target, auth.token.tokenId, requiredRole);
    return { aclUserId: auth.token.tokenId };
  }
  // Asked as a boolean, not as a gate: a session that is refused may still be
  // carrying a link that admits it, and only the checks below know that.
  if (
    auth?.type === "user" &&
    (await canAccess(spaceId, target, auth.user.id, requiredRole))
  ) {
    return { aclUserId: auth.user.id };
  }

  // A caller reaches what their session grants *or* what the links they carry
  // do — asked after the session, because a link never downgrades someone who
  // is already admitted, and asked even when a session was refused: being
  // signed in to the instance is not a reason to see less of a shared page than
  // a stranger does. Every link carried is tried, not just the newest.
  if (shareLinks) {
    for (const principal of await shareLinkPrincipals(credentials, spaceId)) {
      if (await canAccess(spaceId, target, principal, requiredRole)) {
        return { aclUserId: principal };
      }
    }
  }

  // A refused session is told no as itself, rather than falling through to the
  // anonymous check and being told to authenticate.
  if (auth?.type === "user") {
    await verifyAccess(spaceId, target, auth.user.id, requiredRole);
  }

  // Unauthenticated — the document check handles the `public` group.
  await verifyAccess(spaceId, target, null, requiredRole);
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
   * document/tree/category grant, confined to what it reaches (`documentScope`
   * on the result). Only for endpoints that then filter every row against that
   * scope — a space-wide collection that cannot (members, integrations) must
   * leave it off.
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
 * `allowResourceGrants` callers. Preserves permission denial when the caller
 * holds neither.
 *
 * @returns `null` when a space-wide role carries the whole space, otherwise the
 *   allowlist a resource-scoped grantee is confined to.
 */
async function spaceRoleOrResourceScope(
  spaceId: string,
  identity: ResolvedIdentity,
  requiredRole: Permission,
  options: SpaceAccessOptions | undefined,
): Promise<string[] | null> {
  try {
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      identity,
      requiredRole,
    );
    return null;
  } catch (error) {
    if (!options?.allowResourceGrants) throw error;
    // Only widen permission denial (no space-wide grant); rejected credentials
    // and unavailable spaces are not candidates for a resource-scoped grant.
    if (!(error instanceof PermissionDeniedError)) {
      throw error;
    }

    const scopedIds = await listAccessibleResources(
      spaceId,
      identity,
      scopeType(options),
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
 *    (the token's own id as the identity).
 *  - **User session**: verified against the space role.
 *  - **Unauthenticated**: admitted when the `public` group holds
 *    `requiredRole` on the space; otherwise the space is unavailable to it.
 *
 * Failure distinguishes rejected credentials, insufficient permission, and a
 * space unavailable to an anonymous caller. On success returns what a caller
 * needs to filter rows per document, via {@link spaceAccessToViewer}.
 */
export async function authenticateSpaceAccess(
  credentials: CallerCredentials,
  spaceId: string,
  requiredRole: Permission,
  options?: SpaceAccessOptions,
): Promise<SpaceAccess> {
  // 1. Job token
  const jobToken = credentials.jobToken;
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) {
      throw new CredentialRejectedError("Invalid job token");
    }
    const { userId } = parsed;
    if (userId) {
      // A job token is the user's own access, resource grants included: work
      // they can start from the browser must not be refused because it went
      // through an agent or a workflow.
      const identity = await resolveIdentity(userId);
      const resourceScope = await spaceRoleOrResourceScope(
        spaceId,
        identity,
        requiredRole,
        options,
      );
      return {
        aclUserId: userId,
        aclGroups: identity.groups,
        isPublic: false,
        resourceScope,
        scopeType: scopeType(options),
      };
    }
    // User-less system token — fully trusted within the space.
    return { aclUserId: null, isPublic: false };
  }

  // 2. Session or access token
  const auth = await tryAuthenticateRequest(credentials, spaceId);
  if (auth?.type === "user") {
    const identity = await resolveIdentity(auth.user.id);
    const resourceScope = await spaceRoleOrResourceScope(
      spaceId,
      identity,
      requiredRole,
      options,
    );
    return {
      user: auth.user,
      aclUserId: auth.user.id,
      aclGroups: identity.groups,
      isPublic: false,
      resourceScope,
      scopeType: scopeType(options),
    };
  }
  if (auth?.type === "token") {
    const identity = await resolveIdentity(auth.token.tokenId);
    const resourceScope = await spaceRoleOrResourceScope(
      spaceId,
      identity,
      requiredRole,
      options,
    );
    return {
      aclUserId: auth.token.tokenId,
      aclGroups: identity.groups,
      isPublic: false,
      resourceScope,
      scopeType: scopeType(options),
    };
  }

  // 3. Unauthenticated — admitted by the `public` group.
  const anonymous = await resolveIdentity(null);
  const { decision } = await decideAccess(
    spaceId,
    { type: ResourceType.SPACE, id: spaceId },
    anonymous,
    requiredRole,
  );
  // Missing and private spaces are deliberately indistinguishable to an
  // anonymous caller.
  if (decision === "no-space") {
    throw new ResourceUnavailableError("Space");
  }
  if (decision !== "ok") {
    const resourceScope = options?.allowResourceGrants
      ? await listAccessibleResources(
          spaceId,
          anonymous,
          scopeType(options),
          requiredRole,
        )
      : null;
    // A document shared with the `public` group in an otherwise private space:
    // browsable, but only as far as that grant reaches.
    if (!resourceScope || resourceScope.length === 0) {
      throw new ResourceUnavailableError("Space");
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
 * Verify the caller holds a feature, failing with
 * {@link PermissionDeniedError} if not.
 *
 * @param documentId Resolve against this document's role rather than the space
 *   role, for a feature exercised on one document. See {@link hasFeature}.
 */
export async function verifyFeatureAccess(
  spaceId: string,
  feature: Feature,
  who: AccessIdentity,
  documentId?: string,
): Promise<void> {
  const hasAccess = await hasFeature(spaceId, feature, await toIdentity(who), documentId);
  if (!hasAccess) {
    throw new PermissionDeniedError(
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
 *   `tokenId`, which is its ACL identity.
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
      throw new ResourceUnavailableError("Document");
    }
    publishedRev = document.publishedRev;
  }

  const history = await hasFeature(
    spaceId,
    Feature.VIEW_HISTORY,
    await resolveIdentity(userId),
    documentId,
  );

  // Plain read access already buys the published snapshot's content.
  const snapshotOnly =
    requested.length > 0 && requested.every((rev) => rev === publishedRev);
  if (snapshotOnly) {
    return { metadata: history };
  }

  if (!history) {
    throw new PermissionDeniedError(
      "You don't have access to the view history feature",
    );
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
 * Validate a token grant and return the role it names, throwing a 400 if it
 * names none. Shape only, since authority is bounded at use — this is what keeps
 * a typo'd role out of the ACL, where it would sit as a grant that does nothing.
 */
export function validateTokenGrant(
  resourceType: ResourceType,
  permission: string,
): Permission {
  if (!isPermission(permission)) {
    throw new InvalidAclRequestError(
      `Permission must be one of: ${allPermissions().join(", ")}`,
    );
  }
  if (!TOKEN_GRANTABLE_RESOURCE_TYPES.includes(resourceType)) {
    throw new InvalidAclRequestError(
      `Token access cannot be granted for resource type: ${resourceType}`,
    );
  }
  // Owner is authority over the space; below that scope it names nothing, so a
  // token cannot be handed it there either.
  if (permission === Permission.OWNER && resourceType !== ResourceType.SPACE) {
    throw new InvalidAclRequestError("owner can only be granted on the space itself");
  }

  return permission;
}

/**
 * Extract access token from Authorization header
 * Supports: "Bearer at_xxxxx" or "at_xxxxx"
 */
export function extractAccessToken(credentials: CallerCredentials): string | null {
  const authHeader = credentials.authorization;
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
 * Authenticate a presented access token. Returns null only when there is no
 * Authorization header; malformed and rejected credentials fail explicitly.
 *
 * @example
 * ```ts
 * const tokenAuth = await authenticateWithToken(credentials, spaceId);
 * if (tokenAuth) {
 *   const canEdit = await canAccess(
 *     spaceId,
 *     { type: ResourceType.DOCUMENT, id: documentId },
 *     tokenAuth.tokenId,
 *     Permission.EDITOR
 *   );
 * }
 * ```
 */
export async function authenticateWithToken(
  credentials: CallerCredentials,
  spaceId: string,
): Promise<ValidateTokenResult | null> {
  if (credentials.authorization == null) {
    return null;
  }

  const token = extractAccessToken(credentials);
  if (!token) {
    throw new CredentialRejectedError();
  }

  const result = await validateAccessToken(await openSpaceStore(spaceId), token);
  if (!result) {
    throw new CredentialRejectedError();
  }

  return result;
}

export const SHARE_COOKIE = "vektor.share_links";

const MAX_CARRIED_SHARE_LINKS = 5;

interface CarriedShareLink {
  id: string;
  proof: string | null;
}

function shareLinksFromCookie(
  cookie: string | null | undefined,
): CarriedShareLink[] {
  const value = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SHARE_COOKIE}=`))
    ?.slice(SHARE_COOKIE.length + 1);
  if (!value) return [];

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return [];
  }

  return decoded
    .split(",")
    .map((entry) => {
      const [id, proof] = entry.split("~");
      return { id, proof: proof ?? null };
    })
    .filter(({ id, proof }) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
      return proof === null || /^[a-f0-9]{64}$/.test(proof);
    })
    .slice(0, MAX_CARRIED_SHARE_LINKS);
}

export function withShareLink(cookie: string | null | undefined, link: CarriedShareLink) {
  const carried = shareLinksFromCookie(cookie).filter((held) => held.id !== link.id);
  return [link, ...carried]
    .slice(0, MAX_CARRIED_SHARE_LINKS)
    .map((held) => (held.proof ? `${held.id}~${held.proof}` : held.id))
    .join(",");
}

/** Revalidate every carried link and password proof so revocation applies immediately. */
async function shareLinkPrincipals(
  credentials: CallerCredentials,
  spaceId: string,
): Promise<string[]> {
  const carried = shareLinksFromCookie(credentials.cookie);
  if (carried.length === 0) return [];

  const store = await openSpaceStore(spaceId);
  const principals: string[] = [];
  for (const { id, proof } of carried) {
    const link = await validateShareLink(store, id);
    if (link && verifyShareLinkProof(link, proof)) principals.push(id);
  }
  return principals;
}

interface ShareLinkAccess {
  spaceId: string;
  aclUserId: string;
  resourceType: ResourceType;
  resourceId: string;
  carried: CarriedShareLink;
}

/** Unknown, revoked and expired links fail identically. */
export async function authenticateShareLink(
  spaceSlug: string,
  linkId: string,
  password: string | null,
): Promise<ShareLinkAccess> {
  const found = await findShareLink(spaceSlug, linkId);
  if (!found) throw new ResourceUnavailableError("Share link");

  if (found.link.secret) {
    if (password === null || !(await Bun.password.verify(password, found.link.secret))) {
      throw new ShareLinkPasswordRequiredError(found.link.name);
    }
  }

  await markShareLinkUsed(await openSpaceStore(found.spaceId), found.link.userId);

  return {
    spaceId: found.spaceId,
    aclUserId: found.link.userId,
    resourceType: found.link.resourceType as ResourceType,
    resourceId: found.link.resourceId,
    carried: { id: found.link.userId, proof: shareLinkProof(found.link) },
  };
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
  const hasIt = await hasFeature(
    spaceId,
    feature,
    await resolveIdentity(tokenResult.tokenId),
  );
  if (!hasIt) {
    throw new PermissionDeniedError(
      `Token does not have the ${feature} capability for this space`,
    );
  }
}

/**
 * Authenticate request with either user session or access token
 * Returns { type: "user", user } or { type: "token", token }
 */
export async function authenticateRequest(
  credentials: CallerCredentials,
  spaceId: string,
): Promise<
  | { type: "user"; user: NonNullable<App.Locals["user"]> }
  | { type: "token"; token: ValidateTokenResult }
> {
  // Try user session first
  const user = credentials.user;
  if (user) {
    return { type: "user", user };
  }

  // Try access token
  const tokenResult = await authenticateWithToken(credentials, spaceId);
  if (tokenResult) {
    return { type: "token", token: tokenResult };
  }

  throw new AuthenticationRequiredError();
}

/**
 * Like authenticateRequest, but returns null when no credential was presented.
 * A presented access token that is malformed, invalid, expired, or revoked
 * still fails with {@link CredentialRejectedError}. Callers must separately
 * verify public access before proceeding.
 */
export async function tryAuthenticateRequest(
  credentials: CallerCredentials,
  spaceId: string,
): Promise<
  | { type: "user"; user: NonNullable<App.Locals["user"]> }
  | { type: "token"; token: ValidateTokenResult }
  | null
> {
  const user = credentials.user;
  if (user) {
    return { type: "user", user };
  }

  const tokenResult = await authenticateWithToken(credentials, spaceId);
  if (tokenResult) {
    return { type: "token", token: tokenResult };
  }

  return null;
}
