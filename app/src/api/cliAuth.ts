/**
 * What every CLI login ends in: a token that delegates the approving user's own
 * role on one space.
 *
 * Shared by the browser flow (`/auth/cli`) and the SSH flow (`/auth/cli/ssh`),
 * which differ only in how they establish who is asking. Once that is settled
 * the two mint the same thing, on the same terms.
 */

import { isPermission, ResourceType } from "#acl/permissions.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createAccessToken } from "#db/space/accessTokens.ts";
import {
  getSpace,
  getUserSpaceRole,
  listUserSpaces,
  type Space,
} from "#db/space/spaces.ts";

/** Bounded so a role revoked later cannot leave standing access forever. */
export const CLI_TOKEN_TTL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CliTokenResult {
  token: string;
  spaceId: string;
  permission: string;
  expiresAt: string;
}

/** Why a user has no space a CLI token could be minted for. */
export type CliTokenSpacesError = "no_spaces" | "no_space_roles";

/**
 * The spaces a CLI token can be minted for: those carrying a space-wide role,
 * which is what the exchange delegates. `listUserSpaces` is wider on purpose —
 * it also returns spaces reached only through a resource-scoped grant, so the
 * filtering belongs here rather than in the shared listing. The two empty cases
 * ask different things of the user, hence two error codes.
 */
export async function listCliTokenSpaces(
  userId: string,
): Promise<{ spaces: Space[]; error?: CliTokenSpacesError }> {
  const spaces = await listUserSpaces(userId);
  const grantingSpaces = spaces.filter((space) => isPermission(space.userRole));

  if (grantingSpaces.length > 0) {
    return { spaces: grantingSpaces };
  }
  return { spaces: [], error: spaces.length > 0 ? "no_space_roles" : "no_spaces" };
}

export class CliTokenError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
  }
}

/**
 * Mint the token a CLI login returns.
 *
 * The role is resolved here rather than wherever the login was approved, so a
 * role revoked in between is honoured.
 *
 * @throws {CliTokenError} the space is gone, or the user holds no role on it
 */
export async function mintCliToken(options: {
  userId: string;
  spaceId: string;
  /** Names the token in the space's token list, so a stale one can be told apart. */
  label?: string;
}): Promise<CliTokenResult> {
  const { userId, spaceId } = options;

  const space = await getSpace(spaceId);
  if (!space) {
    throw new CliTokenError("Selected space is no longer available", 400);
  }

  // A resource-scoped grantee holds no space-wide role, so they get nothing —
  // the approval step refuses those spaces already, this is the second line.
  const permission = await getUserSpaceRole(space, userId);
  if (!isPermission(permission)) {
    throw new CliTokenError("You do not hold a role on this space", 403);
  }

  const expiresAt = new Date(Date.now() + CLI_TOKEN_TTL_DAYS * DAY_MS);
  const label = options.label ?? "CLI";

  const result = await createAccessToken(await openSpaceStore(spaceId), {
    name: `${label} (${new Date().toISOString().slice(0, 10)})`,
    resourceType: ResourceType.SPACE,
    resourceId: spaceId,
    permission,
    createdBy: userId,
    expiresAt,
  });

  return {
    token: result.token,
    spaceId,
    permission,
    expiresAt: expiresAt.toISOString(),
  };
}
