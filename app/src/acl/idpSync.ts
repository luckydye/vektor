/**
 * Bounds how stale the IdP's group claim may be. Sign-in re-reads the whole
 * profile, but a session renews itself for days, so without this a group revoked
 * upstream would go on granting access until the user next logged in.
 *
 * A failed re-read changes nothing: the stored groups stay in force and the next
 * check tries again, because an unreachable IdP must not read as "this user lost
 * every group". The re-read needs a usable access token, so the IdP has to issue
 * refresh tokens (`offline_access` in `OAUTH_SCOPES`) to keep working past the
 * lifetime of the token minted at sign-in.
 */

import { and, eq } from "drizzle-orm";
import { publishAuthorizationChange } from "#acl/authorizationChanges.ts";
import { sanitizeOAuthGroups } from "#acl/oauthGroups.ts";
import type { auth } from "#auth";
import { config } from "#config";
import type { Database } from "#db/client/connection.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { account, user } from "#db/schema/auth.ts";
import { isNoAuthMode } from "#noAuth";
import { appLogger } from "#observability/logger.ts";

const GROUPS_CLAIM = "wiki_groups";

/** Cap on how long an ACL check waits for the IdP before using what it has. */
const USERINFO_TIMEOUT_MS = 5_000;

export interface IdpSyncDeps {
  auth: Pick<typeof auth, "api">;
  authDb: Database;
  appConfig: ReturnType<typeof config>;
}

type UserSyncState = {
  /** Last attempt, successful or not, as epoch ms. */
  checkedAt: number;
  inFlight?: Promise<void>;
  /** No account with this provider — an email/password user. Never retried. */
  notFederated?: boolean;
};

export function createIdpGroupSync({ auth, authDb, appConfig }: IdpSyncDeps) {
  const configured = Number.parseInt(appConfig.OAUTH_GROUP_SYNC_INTERVAL ?? "", 10);
  const intervalMs =
    (Number.isFinite(configured) && configured >= 0 ? configured : 60) * 1000;
  const providerId = appConfig.OAUTH_PROVIDER_ID as string;
  const userInfoUrl = appConfig.OAUTH_USERINFO_URL as string;

  const enabled = !isNoAuthMode() && !!providerId && !!userInfoUrl && intervalMs > 0;

  // One small entry per user seen since boot, so bounded by the user table.
  const states = new Map<string, UserSyncState>();

  function readUserInfo(accessToken: string): Promise<Response> {
    return fetch(userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
  }

  /**
   * Retrying on the IdP's rejection rather than on the recorded expiry also
   * covers a token revoked before its nominal lifetime was up.
   */
  async function fetchClaims(userId: string): Promise<Record<string, unknown>> {
    const stored = await auth.api.getAccessToken({ body: { providerId, userId } });
    if (!stored.accessToken) throw new Error("no access token stored for account");

    let response = await readUserInfo(stored.accessToken);
    if (response.status === 401 || response.status === 403) {
      const fresh = await auth.api.refreshToken({ body: { providerId, userId } });
      if (!fresh.accessToken) throw new Error("refresh returned no access token");
      response = await readUserInfo(fresh.accessToken);
    }
    if (!response.ok) throw new Error(`userinfo responded ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  /** False when the user has no account with the provider, so nothing to sync. */
  async function reread(userId: string): Promise<boolean> {
    try {
      const federated = await one(
        authDb
          .select({ id: account.id })
          .from(account)
          .where(and(eq(account.userId, userId), eq(account.providerId, providerId))),
      );
      if (!federated) return false;

      const claims = await fetchClaims(userId);
      const groups = sanitizeOAuthGroups(claims[GROUPS_CLAIM]);
      const image = typeof claims.picture === "string" ? claims.picture : undefined;
      if (groups === undefined) {
        appLogger.warn("IdP userinfo carried no group claim; keeping stored groups", {
          userId,
          claim: GROUPS_CLAIM,
        });
      }

      const stored = await one(
        authDb
          .select({ groups: user.groups, image: user.image })
          .from(user)
          .where(eq(user.id, userId)),
      );
      if (!stored) return true;

      const changes = {
        ...(groups !== undefined && groups !== stored.groups ? { groups } : {}),
        ...(image !== undefined && image !== stored.image ? { image } : {}),
      };
      if (Object.keys(changes).length === 0) return true;

      await authDb
        .update(user)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(user.id, userId));
      if (changes.groups) {
        publishAuthorizationChange({ userId });
        appLogger.info("Refreshed OAuth groups from IdP", {
          userId,
          groups: changes.groups,
          previous: stored.groups,
        });
      }
    } catch (error) {
      appLogger.warn("Could not re-read OAuth groups from IdP", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return {
    enabled,

    ensureFresh(userId: string): Promise<void> | void {
      if (!enabled) return;

      const known = states.get(userId);
      if (known?.notFederated) return;
      if (known?.inFlight) return known.inFlight;
      // Stamped on the attempt, not on success, so an IdP that is down costs one
      // call per interval instead of one per ACL check.
      if (known && Date.now() - known.checkedAt < intervalMs) return;

      const state: UserSyncState = { checkedAt: Date.now() };
      states.set(userId, state);
      state.inFlight = reread(userId)
        .then((federated) => {
          state.notFederated = !federated;
        })
        .finally(() => {
          state.inFlight = undefined;
        });
      return state.inFlight;
    },
  };
}

let defaultSync: Promise<ReturnType<typeof createIdpGroupSync> | null> | undefined;

/**
 * `#auth` is imported dynamically because it is the far side of a cycle — it
 * builds itself from the same database module the ACL store reaches through, and
 * a static edge leaves `auth.ts` running its body against a half-initialized
 * `#db/client/db.ts`.
 */
function sync(): Promise<ReturnType<typeof createIdpGroupSync> | null> {
  defaultSync ??= (async () => {
    const authDb = getAuthDb();
    if (!authDb) return null;
    const { auth } = await import("#auth");
    return createIdpGroupSync({ auth, authDb, appConfig: config() });
  })();
  return defaultSync;
}

export async function ensureFreshGroups(userId: string): Promise<void> {
  await (await sync())?.ensureFresh(userId);
}
