import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { jwt, signJWT } from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { and, eq, notInArray } from "drizzle-orm";
import type { config } from "./config.ts";
import type { Database } from "./db/client/connection.ts";
import { oauthClient } from "./db/schema/auth.ts";

/**
 * Peer federation: every instance is an OIDC provider for the peers it lists,
 * and signs in the users of those peers through them. Each side derives the
 * other's client from config alone — the client id is the peer's origin — so
 * there is no registration handshake and no shared secret.
 */

type AppConfig = ReturnType<typeof config>;

export interface Peer {
  origin: string;
  issuer: string;
  /** The genericOAuth provider id this instance signs the peer's users in with. */
  providerId: string;
}

export interface Federation {
  self: Peer;
  peers: Peer[];
}

export type LoginTarget =
  | { kind: "local" }
  | { kind: "peers"; peers: { providerId: string; host: string }[] };

const PEER_PROVIDER_PREFIX = "peer-";
const PEER_SOFTWARE_ID = "vektor-peer";
const ISSUER_REL = "http://openid.net/specs/connect/1.0/issuer";
const SCOPES = ["openid", "profile", "email"];

function peerAt(raw: string, setting: string): Peer {
  const url = new URL(raw);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username
  ) {
    throw new Error(`${setting} must hold bare http(s) origins, got "${raw}"`);
  }
  return {
    origin: url.origin,
    issuer: `${url.origin}/api/auth`,
    providerId: PEER_PROVIDER_PREFIX + url.host.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
  };
}

/** Undefined when VEKTOR_PEERS is unset, which leaves the instance unfederated. */
export function federationOf(appConfig: AppConfig): Federation | undefined {
  const listed = (appConfig.PEERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (listed.length === 0) return undefined;
  if (!appConfig.SITE_URL) throw new Error("VEKTOR_PEERS requires VEKTOR_SITE_URL");

  const self = peerAt(appConfig.SITE_URL, "VEKTOR_SITE_URL");
  const peers = listed.map((entry) => peerAt(entry, "VEKTOR_PEERS"));
  if (peers.some((peer) => peer.origin === self.origin)) {
    throw new Error("VEKTOR_PEERS must not list this instance itself");
  }
  return { self, peers };
}

/**
 * Registers each peer as a public PKCE client that skips consent, and removes
 * the clients of peers no longer listed.
 */
export async function syncPeerClients(
  authDb: Database,
  federation: Federation | undefined,
) {
  const listed = federation?.peers.map((peer) => peer.origin) ?? [];
  await authDb
    .delete(oauthClient)
    .where(
      and(
        eq(oauthClient.softwareId, PEER_SOFTWARE_ID),
        listed.length ? notInArray(oauthClient.clientId, listed) : undefined,
      ),
    );
  if (!federation) return;

  const now = new Date();
  for (const peer of federation.peers) {
    const values = {
      name: new URL(peer.origin).host,
      softwareId: PEER_SOFTWARE_ID,
      redirectUris: JSON.stringify([
        `${peer.issuer}/oauth2/callback/${federation.self.providerId}`,
      ]),
      scopes: JSON.stringify(SCOPES),
      grantTypes: JSON.stringify(["authorization_code"]),
      responseTypes: JSON.stringify(["code"]),
      tokenEndpointAuthMethod: "none",
      public: true,
      skipConsent: true,
      requirePKCE: true,
      disabled: false,
      updatedAt: now,
    };
    await authDb
      .insert(oauthClient)
      .values({
        id: crypto.randomUUID(),
        clientId: peer.origin,
        createdAt: now,
        ...values,
      })
      .onConflictDoUpdate({ target: oauthClient.clientId, set: values });
  }
}

export function peerOAuthConfigs(federation: Federation): GenericOAuthConfig[] {
  return federation.peers.map((peer) => ({
    providerId: peer.providerId,
    discoveryUrl: `${peer.issuer}/.well-known/openid-configuration`,
    issuer: peer.issuer,
    clientId: federation.self.origin,
    pkce: true,
    scopes: SCOPES,
    overrideUserInfo: true,
    authorizationUrlParams: (ctx): Record<string, string> => {
      const hint = ctx.body?.additionalData?.loginHint;
      return typeof hint === "string" ? { login_hint: hint } : {};
    },
    // A peer vouches for its own users only. A verified email would let
    // better-auth link the login onto a local account with the same address.
    mapProfileToUser: () => ({ emailVerified: false }),
  }));
}

/** Where an account lives, judged by its sign-in methods: any non-peer one makes it local. */
async function homeOf(ctx: GenericEndpointContext, email: string) {
  const found = await ctx.context.internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });
  if (!found) return undefined;
  const providerIds = found.accounts.map((account) => account.providerId);
  return providerIds.some((id) => !id.startsWith(PEER_PROVIDER_PREFIX))
    ? "local"
    : providerIds;
}

/** The listed peer that signed the request's bearer assertion. */
async function authenticatePeer(
  headers: Headers | undefined,
  federation: Federation,
): Promise<Peer> {
  const authorization = headers?.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new APIError("UNAUTHORIZED");
  const token = authorization.slice("Bearer ".length);
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    ) as { iss?: unknown };
    const peer = federation.peers.find((candidate) => candidate.issuer === claims.iss);
    if (!peer) throw new Error("not a listed peer");
    await verifyJwsAccessToken(token, {
      jwksFetch: `${peer.issuer}/jwks`,
      verifyOptions: {
        issuer: peer.issuer,
        audience: federation.self.issuer,
        maxTokenAge: "2m",
      },
    });
    return peer;
  } catch {
    throw new APIError("UNAUTHORIZED", { message: "Invalid peer assertion" });
  }
}

/** Asks a peer whether the email's account lives there, authenticated by an assertion signed with our key. */
async function peerClaims(
  ctx: GenericEndpointContext,
  federation: Federation,
  peer: Peer,
  email: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJWT(ctx, {
    payload: {
      iss: federation.self.issuer,
      sub: federation.self.issuer,
      aud: peer.issuer,
      iat: now,
      exp: now + 60,
    },
  });
  const url = new URL(`${peer.issuer}/federation/webfinger`);
  url.searchParams.set("resource", `acct:${email}`);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${assertion}` },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new APIError("BAD_GATEWAY", {
      message: `Peer ${peer.origin} answered the account lookup with ${response.status}`,
    });
  }
  const jrd = (await response.json()) as { links?: { rel?: string; href?: string }[] };
  if (!jrd.links?.some((link) => link.rel === ISSUER_REL && link.href === peer.issuer)) {
    throw new APIError("BAD_GATEWAY", {
      message: `Peer ${peer.origin} claimed the account for another issuer`,
    });
  }
  return true;
}

function normalizedEmail(raw: unknown): string {
  if (typeof raw !== "string" || !raw.includes("@")) {
    throw new APIError("BAD_REQUEST", { message: "Invalid email" });
  }
  return raw.trim().toLowerCase();
}

const peerFederation = (federation: Federation) =>
  ({
    id: "peer-federation",
    endpoints: {
      /** WebFinger issuer discovery, answered only to listed peers and only for local accounts. */
      peerWebfinger: createAuthEndpoint(
        "/federation/webfinger",
        { method: "GET" },
        async (ctx) => {
          await authenticatePeer(ctx.headers, federation);
          const resource = (ctx.query as { resource?: unknown } | undefined)?.resource;
          if (typeof resource !== "string" || !resource.startsWith("acct:")) {
            throw new APIError("BAD_REQUEST", {
              message: "resource must be an acct: URI",
            });
          }
          const email = normalizedEmail(resource.slice("acct:".length));
          if ((await homeOf(ctx, email)) !== "local") throw new APIError("NOT_FOUND");
          return ctx.json({
            subject: `acct:${email}`,
            links: [{ rel: ISSUER_REL, href: federation.self.issuer }],
          });
        },
      ),
      /** Where the login page should send an email: a password prompt here, or a peer. */
      resolveLogin: createAuthEndpoint(
        "/federation/resolve",
        { method: "POST" },
        async (ctx): Promise<Response | LoginTarget> => {
          const email = normalizedEmail(
            (ctx.body as { email?: unknown } | undefined)?.email,
          );
          const home = await homeOf(ctx, email);
          const local: LoginTarget = { kind: "local" };
          if (home === "local") return ctx.json(local);

          const peers = home
            ? federation.peers.filter((peer) => home.includes(peer.providerId))
            : (
                await Promise.all(
                  federation.peers.map(async (peer) =>
                    (await peerClaims(ctx, federation, peer, email)) ? peer : undefined,
                  ),
                )
              ).filter((peer): peer is Peer => peer !== undefined);
          if (peers.length === 0) return ctx.json(local);
          return ctx.json({
            kind: "peers",
            peers: peers.map((peer) => ({
              providerId: peer.providerId,
              host: new URL(peer.origin).host,
            })),
          } satisfies LoginTarget);
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

export function federationPlugins(federation: Federation) {
  return [
    jwt({ disableSettingJwtHeader: true }),
    oauthProvider({
      loginPage: "/login",
      // Peer clients skip consent and no other clients exist, so a consent
      // prompt only ever means a misconfigured client.
      consentPage: "/error",
      scopes: SCOPES,
      grantTypes: ["authorization_code"],
      silenceWarnings: { oauthAuthServerConfig: true },
    }),
    peerFederation(federation),
  ] as const;
}
