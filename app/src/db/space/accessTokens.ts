import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  getUserGroups,
  grantPermission,
  hasPermission,
  listUserPermissions,
  revokeAllUserPermissions,
  revokePermission,
} from "#acl/store.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import type { AccessToken, AccessTokenInsert } from "#db/schema/space.ts";
import { accessToken } from "#db/schema/space.ts";
import { listAllSpaces } from "./spaces.ts";

export interface CreateAccessTokenOptions {
  spaceId: string;
  name: string;
  expiresAt?: Date;
  createdBy: string;
}

export interface GrantTokenAccessOptions {
  tokenId: string;
  spaceId: string;
  resourceType: ResourceType;
  resourceId: string;
  permission: string;
}

export interface ValidateTokenResult {
  token: AccessToken;
  tokenId: string;
}

/**
 * Generate a cryptographically secure token
 * Format: at_<32 random hex characters>
 */
function generateToken(): string {
  const randomHex = randomBytes(32).toString("hex");
  return `at_${randomHex}`;
}

/**
 * Hash a token for secure storage
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Get token user ID for ACL system
 * Tokens are represented in ACL as "token:<token-id>"
 */
export function getTokenUserId(tokenId: string): string {
  return `token:${tokenId}`;
}

/**
 * Create a new access token scoped to a space
 * After creation, use grantTokenAccess() to assign it to resources
 *
 * @example
 * ```ts
 * const { token, id } = await createAccessToken({
 *   spaceId: "space123",
 *   name: "CI/CD Pipeline",
 *   expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
 *   createdBy: "user789"
 * });
 *
 * // Grant access to a document
 * await grantTokenAccess({
 *   tokenId: id,
 *   spaceId: "space123",
 *   resourceType: "document",
 *   resourceId: "doc456",
 *   permission: "editor"
 * });
 * ```
 */
export async function createAccessToken(
  s: SpaceStore,
  options: CreateAccessTokenOptions,
): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const hashedToken = hashToken(token);
  const id = createId("accessToken");

  const tokenData: AccessTokenInsert = {
    id,
    name: options.name,
    token: hashedToken,
    expiresAt: options.expiresAt,
    lastUsedAt: null,
    createdAt: new Date(),
    createdBy: options.createdBy,
    revokedAt: null,
  };

  await s.db.insert(accessToken).values(tokenData);

  return { id, token };
}

/**
 * Grant a token access to a resource via ACL
 *
 * @example
 * ```ts
 * await grantTokenAccess({
 *   tokenId: "token_abc123",
 *   spaceId: "space123",
 *   resourceType: "document",
 *   resourceId: "doc456",
 *   permission: "editor"
 * });
 * ```
 */
export async function grantTokenAccess(options: GrantTokenAccessOptions): Promise<void> {
  const tokenUserId = getTokenUserId(options.tokenId);
  const store = await openSpaceStore(options.spaceId);

  await grantPermission(
    store,
    options.resourceType,
    options.resourceId,
    tokenUserId,
    options.permission,
  );
}

/**
 * Revoke token access to a resource
 *
 * @example
 * ```ts
 * await revokeTokenAccess({
 *   tokenId: "token_abc123",
 *   spaceId: "space123",
 *   resourceType: "document",
 *   resourceId: "doc456"
 * });
 * ```
 */
export async function revokeTokenAccess(
  s: SpaceStore,
  tokenId: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<void> {
  const tokenUserId = getTokenUserId(tokenId);

  await revokePermission(s, resourceType, resourceId, tokenUserId);
}

/**
 * List all resources a token has access to in a space
 *
 * @example
 * ```ts
 * const resources = await listTokenResources("token_abc123", "space123");
 * // Returns ACL entries showing what the token can access
 * ```
 */
export async function listTokenResources(
  s: SpaceStore,
  tokenId: string,
  resourceType?: ResourceType,
) {
  const tokenUserId = getTokenUserId(tokenId);
  return listUserPermissions(s.spaceId, tokenUserId, undefined, resourceType);
}

/**
 * Validate an access token and return its details
 * Returns null if token is invalid, revoked, or expired
 *
 * @example
 * ```ts
 * const result = await validateAccessToken("at_abc123...", "space123");
 * if (result) {
 *   console.log("Token valid:", result.tokenId);
 * }
 * ```
 */
export async function validateAccessToken(
  s: SpaceStore,
  token: string,
): Promise<ValidateTokenResult | null> {
  const hashedToken = hashToken(token);

  const [result] = await s.db
    .select()
    .from(accessToken)
    .where(and(eq(accessToken.token, hashedToken), isNull(accessToken.revokedAt)))
    .limit(1);

  if (!result) {
    return null;
  }

  // Check expiration
  if (result.expiresAt && result.expiresAt < new Date()) {
    return null;
  }

  // Access tokens are delegations made by a space member, not independent
  // service accounts. If the creator no longer belongs to the space, revoke
  // the credential permanently so re-adding the user cannot revive a secret
  // that remained on an offboarded user's machine.
  const creatorStillBelongsToSpace = await hasPermission(
    s.spaceId,
    ResourceType.SPACE,
    s.spaceId,
    result.createdBy,
    Permission.VIEWER,
    await getUserGroups(result.createdBy),
  );
  if (!creatorStillBelongsToSpace) {
    await revokeAccessToken(s, result.id);
    return null;
  }

  // Update last used timestamp
  await s.db
    .update(accessToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(accessToken.id, result.id));

  return {
    token: result,
    tokenId: result.id,
  };
}

/**
 * Revoke an access token (soft delete)
 * This marks the token as revoked but keeps it in the database
 * ACL entries remain but the token can't be used
 *
 * @example
 * ```ts
 * await revokeAccessToken("space123", "token_abc123");
 * ```
 */
export async function revokeAccessToken(
  s: SpaceStore,
  tokenId: string,
): Promise<boolean> {
  const result = await s.db
    .update(accessToken)
    .set({ revokedAt: new Date() })
    .where(eq(accessToken.id, tokenId))
    .returning();

  return result.length > 0;
}

/**
 * List all access tokens for a space
 * Returns tokens without the actual token value (only metadata)
 *
 * @example
 * ```ts
 * const tokens = await listAccessTokens("space123");
 * ```
 */
export async function listAccessTokens(
  s: SpaceStore,
): Promise<Omit<AccessToken, "token">[]> {
  const tokens = await s.db
    .select({
      id: accessToken.id,
      name: accessToken.name,
      expiresAt: accessToken.expiresAt,
      lastUsedAt: accessToken.lastUsedAt,
      createdAt: accessToken.createdAt,
      createdBy: accessToken.createdBy,
      revokedAt: accessToken.revokedAt,
    })
    .from(accessToken);

  return tokens as Omit<AccessToken, "token">[];
}

/**
 * Get a single access token by ID
 * Returns token metadata without the actual token value
 *
 * @example
 * ```ts
 * const token = await getAccessToken("space123", "token_abc123");
 * ```
 */
export async function getAccessToken(
  s: SpaceStore,
  tokenId: string,
): Promise<Omit<AccessToken, "token"> | null> {
  const result = await s.db
    .select({
      id: accessToken.id,
      name: accessToken.name,
      expiresAt: accessToken.expiresAt,
      lastUsedAt: accessToken.lastUsedAt,
      createdAt: accessToken.createdAt,
      createdBy: accessToken.createdBy,
      revokedAt: accessToken.revokedAt,
    })
    .from(accessToken)
    .where(eq(accessToken.id, tokenId))
    .limit(1);

  return result[0] || null;
}

/**
 * Find which space a raw token belongs to by scanning all spaces.
 * Returns the s.spaceId if found and valid, null otherwise.
 */
export async function findSpaceForToken(token: string): Promise<string | null> {
  const spaces = await listAllSpaces();
  for (const space of spaces) {
    const spaceStore = await openSpaceStore(space.id);
    if (await validateAccessToken(spaceStore, token)) return space.id;
  }
  return null;
}

/**
 * Delete an access token permanently
 * This also removes all ACL entries for the token in the space
 *
 * @example
 * ```ts
 * await deleteAccessToken(store, "token_abc123");
 * ```
 */
export async function deleteAccessToken(
  s: SpaceStore,
  tokenId: string,
  actorUserId?: string,
): Promise<boolean> {
  return s.tx(async (tx) => {
    const result = await tx.db
      .delete(accessToken)
      .where(eq(accessToken.id, tokenId))
      .returning();

    if (result.length === 0) return false;

    // The token principal no longer exists, so its grants would otherwise stay
    // behind and make access listings report a grantee that can never be used.
    await revokeAllUserPermissions(tx, getTokenUserId(tokenId), actorUserId);

    return true;
  });
}
