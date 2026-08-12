/**
 * Bounds how stale the IdP's group claim may be. Sign-in re-reads the whole
 * profile, but a session renews itself for days, so without this a group revoked
 * upstream would go on granting access until the user next logged in.
 *
 * A failed re-read changes nothing: the stored groups stay in force and the next
 * check tries again. An unreachable IdP must not read as "this user lost every
 * group" — that would turn an outage into an instance-wide lockout.
 *
 * The re-read needs a usable access token, so the IdP must issue refresh tokens
 * (`offline_access` in `OAUTH_SCOPES`) to keep working past the lifetime of the
 * token minted at sign-in.
 */

import { and, eq } from "drizzle-orm";
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

const DEFAULT_SYNC_INTERVAL_SECONDS = 60;

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

function seconds(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createIdpGroupSync(deps: IdpSyncDeps) {
  const { appConfig } = deps;
  const intervalMs =
    seconds(appConfig.OAUTH_GROUP_SYNC_INTERVAL, DEFAULT_SYNC_INTERVAL_SECONDS) * 1000;
  const providerId = appConfig.OAUTH_PROVIDER_ID;
  const userInfoUrl = appConfig.OAUTH_USERINFO_URL;

  const enabled = !isNoAuthMode() && !!providerId && !!userInfoUrl && intervalMs > 0;

  const states = new Map<string, UserSyncState>();

  function sweep(): void {
    if (states.size < 1000) return;
    const cutoff = Date.now() - intervalMs;
    for (const [userId, state] of states) {
      if (!state.inFlight && !state.notFederated && state.checkedAt < cutoff) {
        states.delete(userId);
      }
    }
  }

  async function federatedAccountId(userId: string): Promise<string | null> {
    const row = await one(
      deps.authDb
        .select({ accountId: account.accountId })
        .from(account)
        .where(
          and(eq(account.userId, userId), eq(account.providerId, providerId as string)),
        ),
    );
    return row?.accountId ?? null;
  }

  function readUserInfo(accessToken: string): Promise<Response> {
    return fetch(userInfoUrl as string, {
      headers: { Authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
  }

  /**
   * Retrying on the IdP's rejection rather than on the recorded expiry also
   * covers a token revoked before its nominal lifetime was up.
   */
  async function fetchClaims(userId: string): Promise<Record<string, unknown>> {
    const stored = await deps.auth.api.getAccessToken({
      body: { providerId: providerId as string, userId },
    });
    if (!stored.accessToken) throw new Error("no access token stored for account");

    let response = await readUserInfo(stored.accessToken);
    if (response.status === 401 || response.status === 403) {
      const refreshed = await deps.auth.api.refreshToken({
        body: { providerId: providerId as string, userId },
      });
      if (!refreshed.accessToken) throw new Error("refresh returned no access token");
      response = await readUserInfo(refreshed.accessToken);
    }
    if (!response.ok) {
      throw new Error(`userinfo responded ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async function reread(userId: string): Promise<void> {
    try {
      if (!(await federatedAccountId(userId))) {
        states.set(userId, { checkedAt: Date.now(), notFederated: true });
        return;
      }

      const claims = await fetchClaims(userId);
      const groups = sanitizeOAuthGroups(claims[GROUPS_CLAIM]);
      const image = typeof claims.picture === "string" ? claims.picture : undefined;

      const stored = await one(
        deps.authDb
          .select({ groups: user.groups, image: user.image })
          .from(user)
          .where(eq(user.id, userId)),
      );
      if (stored && (groups !== undefined || image !== undefined)) {
        const changed = groups !== undefined && groups !== stored.groups;
        if (changed || (image !== undefined && image !== stored.image)) {
          await deps.authDb
            .update(user)
            .set({
              ...(groups !== undefined ? { groups } : {}),
              ...(image !== undefined ? { image } : {}),
              updatedAt: new Date(),
            })
            .where(eq(user.id, userId));
        }
        if (changed) {
          appLogger.info("Refreshed OAuth groups from IdP", {
            userId,
            groups,
            previous: stored.groups,
          });
        }
      }
      if (groups === undefined) {
        appLogger.warn("IdP userinfo carried no group claim; keeping stored groups", {
          userId,
          claim: GROUPS_CLAIM,
        });
      }
    } catch (error) {
      appLogger.warn("Could not re-read OAuth groups from IdP", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    enabled,

    async ensureFresh(userId: string): Promise<void> {
      if (!enabled) return;

      const state = states.get(userId);
      if (state?.notFederated) return;
      if (state?.inFlight) return state.inFlight;
      // Stamped on the attempt, not on success, so an IdP that is down costs one
      // call per interval instead of one per ACL check.
      if (state && Date.now() - state.checkedAt < intervalMs) return;

      sweep();
      const inFlight = reread(userId);
      states.set(userId, { checkedAt: Date.now(), inFlight });
      try {
        await inFlight;
      } finally {
        const settled = states.get(userId);
        if (settled?.inFlight === inFlight) delete settled.inFlight;
      }
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
