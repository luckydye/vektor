import type { IncomingHttpHeaders, Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { CredentialRejectedError } from "#acl/errors.ts";
import { authenticateWithToken, isAccessDenied, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { resolveRequestIdentity } from "#acl/session.ts";
import {
  NODE_OFFLINE_AFTER_MS,
  NODE_PING_INTERVAL_MS,
  type NodeHelloFrame,
  type NodeToServerFrame,
  parseFrame,
} from "#agent/nodes/protocol.ts";
import { nodeRegistry } from "#agent/nodes/registry.ts";
import { isNoAuthMode } from "#config";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";

/** The URL path nodes dial: `/nodes/<spaceId>`. */
const NODE_PATH = /^\/nodes\/([^/]+)$/;

const MAX_FRAME_BYTES = 1024 * 1024;
const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_FORBIDDEN = 4403;

export function isNodeUpgradePath(pathname: string): boolean {
  return NODE_PATH.test(pathname);
}

/**
 * Who a node dials in as: the user behind its access token (its creator, since a
 * token is a delegation), or the session user in no-auth mode. Null once refused.
 */
async function authenticateNode(
  platform: Platform,
  headers: Headers,
  spaceId: string,
): Promise<{ userId: string; recheck: () => Promise<boolean> } | null> {
  if (isNoAuthMode()) {
    const { user } = await resolveRequestIdentity(platform, headers);
    return user ? { userId: user.id, recheck: async () => true } : null;
  }

  const authorization = headers.get("authorization");
  const check = async () => {
    const result = await authenticateWithToken(platform, { authorization }, spaceId);
    if (!result) return null;
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      result.tokenId,
      Permission.VIEWER,
    );
    return result.token.createdBy;
  };

  let userId: string | null;
  try {
    userId = await check();
  } catch {
    return null;
  }
  if (!userId) return null;
  return {
    userId,
    // Only a definite refusal drops the node; a lookup that failed keeps it.
    recheck: async () => {
      try {
        return (await check()) !== null;
      } catch (error) {
        return !isAccessDenied(error) && !(error instanceof CredentialRejectedError);
      }
    },
  };
}

/** Attaches the node endpoint, `/nodes/<spaceId>`, to the HTTP server. */
export function attachNodeWebSocketServer(platform: Platform, server: Server) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  const lastSeenAt = new WeakMap<object, number>();
  const rechecks = new WeakMap<object, () => Promise<boolean>>();

  const sweep = setInterval(() => {
    const deadline = Date.now() - NODE_OFFLINE_AFTER_MS;
    for (const client of websocketServer.clients) {
      if ((lastSeenAt.get(client) ?? 0) <= deadline) {
        client.terminate();
        continue;
      }
      client.send(JSON.stringify({ type: "ping" }));
      void rechecks
        .get(client)?.()
        .then((ok) => {
          if (!ok) client.close(WS_CLOSE_UNAUTHORIZED, "Credential revoked");
        });
    }
  }, NODE_PING_INTERVAL_MS);
  sweep.unref?.();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(NODE_PATH);
    if (!match) return;
    const spaceId = decodeURIComponent(match[1]);

    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      lastSeenAt.set(websocket, Date.now());
      void acceptNode(platform, websocket, request.headers, spaceId, {
        touch: () => lastSeenAt.set(websocket, Date.now()),
        setRecheck: (recheck) => rechecks.set(websocket, recheck),
      }).catch((error: unknown) => {
        appLogger.warn("Could not accept a node connection", { error, spaceId });
        websocket.close();
      });
    });
  });

  return {
    close() {
      clearInterval(sweep);
      websocketServer.close();
      for (const client of websocketServer.clients) client.close();
    },
  };
}

async function acceptNode(
  platform: Platform,
  websocket: WebSocket,
  rawHeaders: IncomingHttpHeaders,
  spaceId: string,
  hooks: { touch: () => void; setRecheck: (recheck: () => Promise<boolean>) => void },
) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") headers.set(name, value);
  }
  // Frames that arrive while authenticating are held, not dropped: the hello
  // is usually already on its way.
  const early: string[] = [];
  let handler: ((raw: string) => void) | null = null;
  websocket.on("message", (data: Buffer) => {
    hooks.touch();
    const raw = data.toString();
    if (handler) handler(raw);
    else early.push(raw);
  });
  let disconnect: (() => void) | null = null;
  let closed = false;
  websocket.on("close", () => {
    closed = true;
    disconnect?.();
  });

  const identity = await authenticateNode(platform, headers, spaceId);
  if (!identity) {
    websocket.close(
      isNoAuthMode() ? WS_CLOSE_UNAUTHORIZED : WS_CLOSE_FORBIDDEN,
      "Unauthorized",
    );
    return;
  }
  hooks.setRecheck(identity.recheck);

  let connection: ReturnType<typeof nodeRegistry.connect> | null = null;
  handler = (raw) => {
    const frame = parseFrame<NodeToServerFrame>(raw);
    if (!frame) return;
    if (!connection) {
      if (frame.type !== "hello" || !frame.name || typeof frame.name !== "string") return;
      const hello: NodeHelloFrame = {
        type: "hello",
        name: frame.name.slice(0, 64),
        os: String(frame.os ?? "").slice(0, 64),
        workdir: String(frame.workdir ?? "").slice(0, 512),
        adapters: Array.isArray(frame.adapters)
          ? frame.adapters.filter((a) => typeof a === "string").slice(0, 32)
          : [],
        maxSessions: Math.max(1, Math.min(Number(frame.maxSessions) || 1, 64)),
        sessions: Array.isArray(frame.sessions)
          ? frame.sessions.filter((s) => typeof s === "string")
          : [],
      };
      connection = nodeRegistry.connect({ spaceId, userId: identity.userId }, hello, {
        send: (out) => websocket.readyState === 1 && websocket.send(JSON.stringify(out)),
        close: () => websocket.close(),
      });
      disconnect = connection.disconnect;
      if (closed) disconnect();
      return;
    }
    connection.handle(frame);
  };
  for (const raw of early.splice(0)) handler(raw);
}
