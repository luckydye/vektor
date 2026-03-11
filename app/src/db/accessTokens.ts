import { eq, and, isNull } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { accessToken } from "./schema/space.ts";
import type { AccessToken, AccessTokenInsert } from "./schema/space.ts";
import {
  grantPermission,
  revokePermission,
  listUserPermissions,
  hasPermission,
  type ResourceType,
} from "./acl.ts";
import { createHash, randomBytes } from "node:crypto";

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
 * Check if a userId represents a token
 */
export function isTokenUserId(userId: string): boolean {
  return userId.startsWith("token:");
}

/**
 * Extract token ID from token user ID
 */
export function extractTokenId(tokenUserId: string): string {
  return tokenUserId.replace("token:", "");
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
  options: CreateAccessTokenOptions,
): Promise<{ id: string; token: string }> {
  const db = await getSpaceDb(options.spaceId);
  if (!db) {
    throw new Error("Space not found");
  }

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

  await db.insert(accessToken).values(tokenData);

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

  await grantPermission(
    options.spaceId,
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
  tokenId: string,
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<void> {
  const tokenUserId = getTokenUserId(tokenId);

  await revokePermission(spaceId, resourceType, resourceId, tokenUserId);
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
  tokenId: string,
  spaceId: string,
  resourceType?: ResourceType,
) {
  const tokenUserId = getTokenUserId(tokenId);
  return listUserPermissions(spaceId, tokenUserId, resourceType);
}

/**
 * Check if token has permission for a resource
 *
 * @example
 * ```ts
 * const canEdit = await hasTokenPermission(
 *   "token_abc123",
 *   "space123",
 *   "document",
 *   "doc456",
 *   "editor"
 * );
 * ```
 */
export async function hasTokenPermission(
  tokenId: string,
  spaceId: string,
  resourceType: ResourceType,
  resourceId: string,
  requiredPermission: string,
): Promise<boolean> {
  const tokenUserId = getTokenUserId(tokenId);
  return hasPermission(
    spaceId,
    resourceType,
    resourceId,
    tokenUserId,
    requiredPermission,
  );
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
 *   // Check permissions via ACL
 *   const canEdit = await hasTokenPermission(
 *     result.tokenId,
 *     "space123",
 *     "document",
 *     "doc456",
 *     "editor"
 *   );
 * }
 * ```
 */
export async function validateAccessToken(
  token: string,
  spaceId: string,
): Promise<ValidateTokenResult | null> {
  const db = await getSpaceDb(spaceId);
  if (!db) {
    return null;
  }

  const hashedToken = hashToken(token);

  const [result] = await db
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

  // Update last used timestamp
  await db
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
  spaceId: string,
  tokenId: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  if (!db) {
    return false;
  }

  const result = await db
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
  spaceId: string,
): Promise<Omit<AccessToken, "token">[]> {
  const db = await getSpaceDb(spaceId);
  if (!db) {
    return [];
  }

  const tokens = await db
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
  spaceId: string,
  tokenId: string,
): Promise<Omit<AccessToken, "token"> | null> {
  const db = await getSpaceDb(spaceId);
  if (!db) {
    return null;
  }

  const result = await db
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
 * Delete an access token permanently
 * This also removes all ACL entries for the token in the space
 *
 * @example
 * ```ts
 * await deleteAccessToken("space123", "token_abc123");
 * ```
 */
export async function deleteAccessToken(
  spaceId: string,
  tokenId: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  if (!db) {
    return false;
  }

  const result = await db
    .delete(accessToken)
    .where(eq(accessToken.id, tokenId))
    .returning();

  return result.length > 0;
}

/**
 * Clean up expired tokens for a space
 * Permanently deletes tokens that have passed their expiration date
 *
 * @example
 * ```ts
 * const count = await cleanupExpiredTokens("space123");
 * console.log(`Cleaned up ${count} expired tokens`);
 * ```
 */
export async function cleanupExpiredTokens(spaceId: string): Promise<number> {
  const db = await getSpaceDb(spaceId);
  if (!db) {
    return 0;
  }

  const now = new Date();

  // Get all tokens with expiration dates
  const tokens = await db.select().from(accessToken);

  // Filter expired tokens
  const expiredTokens = tokens.filter((t) => t.expiresAt && t.expiresAt < now);

  // Delete expired tokens one by one
  let deletedCount = 0;
  for (const token of expiredTokens) {
    await db.delete(accessToken).where(eq(accessToken.id, token.id));
    deletedCount++;
  }

  return deletedCount;
}
