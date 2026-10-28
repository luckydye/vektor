import type { IncomingHttpHeaders, Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { CredentialRejectedError } from "#acl/errors.ts";
import { authenticateWithToken, isAccessDenied, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { resolveRequestIdentity } from "#acl/session.ts";
import {
  isScreenInputEvent,
  NODE_OFFLINE_AFTER_MS,
  NODE_PING_INTERVAL_MS,
  type NodeHelloFrame,
  type NodeToServerFrame,
  parseFrame,
} from "#agent/nodes/protocol.ts";
import { nodeRegistry } from "#agent/nodes/registry.ts";
import { isNoAuthMode } from "#config";
import { MAX_PAYLOAD_BYTES } from "#jobs/runtime/portable.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";

/** The URL path nodes dial: `/nodes/<spaceId>`. */
const NODE_PATH = /^\/nodes\/([^/]+)$/;
/** The URL path a browser watches a remote task's screen at: `/screens/<spaceId>/<taskId>`. */
const SCREEN_PATH = /^\/screens\/([^/]+)\/([^/]+)$/;
/** Media a slow viewer may have queued before its screen is closed rather than lag further. */
const MAX_VIEWER_BUFFER_BYTES = 8 * 1024 * 1024;

/** Fits a job's capability call or reply: a payload at its limit, base64-encoded, with room for the frame. */
const MAX_FRAME_BYTES = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) + 1024 * 1024;
const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_FORBIDDEN = 4403;

export function isNodeUpgradePath(pathname: string): boolean {
  return NODE_PATH.test(pathname) || SCREEN_PATH.test(pathname);
}

/**
 * Who a node dials in as: the space owner behind its access token (its creator,
 * since a token is a delegation), or the session user in no-auth mode. Null once refused.
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
    // Tasks hand the node a job token with its creator's full access, so only a
    // space-owner token (capped at its creator's grants) may dial in.
    await verifyAccess(
      platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      result.tokenId,
      Permission.OWNER,
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
    const screen = url.pathname.match(SCREEN_PATH);
    if (screen) {
      websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
        lastSeenAt.set(websocket, Date.now());
        void acceptScreenViewer(
          platform,
          websocket,
          request.headers,
          {
            spaceId: decodeURIComponent(screen[1]),
            taskId: decodeURIComponent(screen[2]),
          },
          () => lastSeenAt.set(websocket, Date.now()),
        ).catch((error: unknown) => {
          appLogger.warn("Could not accept a screen viewer", { error });
          websocket.close();
        });
      });
      return;
    }
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
  const headers = headersOf(rawHeaders);
  // Frames that arrive while authenticating are held, not dropped: the hello
  // is usually already on its way.
  const early: string[] = [];
  let handler: ((raw: string) => void) | null = null;
  let media: ((message: Uint8Array) => void) | null = null;
  websocket.on("message", (data: Buffer, isBinary: boolean) => {
    hooks.touch();
    if (isBinary) {
      media?.(data);
      return;
    }
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
        shared: frame.shared === true,
      };
      connection = nodeRegistry.connect({ spaceId, userId: identity.userId }, hello, {
        send: (out) => websocket.readyState === 1 && websocket.send(JSON.stringify(out)),
        close: () => websocket.close(),
      });
      disconnect = connection.disconnect;
      media = connection.media;
      if (closed) disconnect();
      return;
    }
    connection.handle(frame);
  };
  for (const raw of early.splice(0)) handler(raw);
}

function headersOf(rawHeaders: IncomingHttpHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

/**
 * A browser watching and driving a remote task's screen: media goes out as
 * binary messages, input comes in as JSON arrays of `ScreenInputEvent`s. Only
 * the task's own user may open it.
 */
async function acceptScreenViewer(
  platform: Platform,
  websocket: WebSocket,
  rawHeaders: IncomingHttpHeaders,
  scope: { spaceId: string; taskId: string },
  touch: () => void,
) {
  let closed = false;
  let screen: ReturnType<typeof nodeRegistry.openScreen> | null = null;
  websocket.on("close", () => {
    closed = true;
    screen?.close();
  });
  websocket.on("message", (data: Buffer, isBinary: boolean) => {
    touch();
    if (isBinary || !screen) return;
    const events = parseFrame<{ type: "input"; events: unknown }>(
      data.toString(),
    )?.events;
    if (Array.isArray(events) && events.every(isScreenInputEvent)) screen.input(events);
  });

  const { user } = await resolveRequestIdentity(platform, headersOf(rawHeaders));
  if (!user) {
    websocket.close(WS_CLOSE_UNAUTHORIZED, "Unauthorized");
    return;
  }
  if (!isNoAuthMode()) {
    try {
      await verifyAccess(
        platform,
        scope.spaceId,
        { type: ResourceType.SPACE, id: scope.spaceId },
        user.id,
        Permission.VIEWER,
      );
    } catch {
      websocket.close(WS_CLOSE_FORBIDDEN, "Forbidden");
      return;
    }
  }
  if (closed) return;
  try {
    screen = nodeRegistry.openScreen(
      { ...scope, userId: user.id },
      {
        send(bytes) {
          if (websocket.bufferedAmount > MAX_VIEWER_BUFFER_BYTES) {
            screen?.close("The connection is too slow for the screen.");
            return;
          }
          websocket.send(bytes);
        },
        // Close reasons are limited to 123 bytes.
        close: (error) => websocket.close(error ? 4000 : 1000, error?.slice(0, 120)),
      },
    );
  } catch (error) {
    websocket.close(4404, error instanceof Error ? error.message.slice(0, 120) : "");
  }
}
