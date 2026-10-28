import { randomUUID } from "node:crypto";
import type { RunnerRequest } from "#runners/contract.ts";
import type { Runner } from "#runners/runners.ts";
import {
  decodeScreenMedia,
  type NodeHelloFrame,
  type NodeSummary,
  type NodeToServerFrame,
  type ScreenInputEvent,
  type ServerToNodeFrame,
} from "./protocol.ts";

/**
 * The nodes connected to this server. A node is a runner (#runners/runners.ts)
 * that dials in: it gets runner requests over its socket, and makes its runs'
 * calls over HTTP like any runner. It belongs to the user whose access token
 * it dialled in with, within one space; jobs may also use a node shared with
 * the space. Screens, a session's live display, are a node's own extension.
 */

export interface NodeTransport {
  send(frame: ServerToNodeFrame): void;
  close(): void;
}

/** Where a screen's media goes: the browser watching it. */
export interface ScreenViewer {
  send(bytes: Uint8Array): void;
  close(error?: string): void;
}

export type ScreenHandle = {
  input(events: ScreenInputEvent[]): void;
  close(error?: string): void;
};

/** A node runner's screens, by agent session. */
export type NodeScreens = {
  open(sessionId: string, viewer: ScreenViewer): ScreenHandle;
  closeAll(sessionId: string): void;
};

type OpenScreen = { sessionId: string; nodeKey: string; viewer: ScreenViewer };

type ConnectedNode = {
  key: string;
  spaceId: string;
  userId: string;
  hello: NodeHelloFrame;
  transport: NodeTransport;
};

const nodeKey = (spaceId: string, userId: string, name: string) =>
  `${spaceId}\0${userId}\0${name}`;

export class NodeRegistry {
  private nodes = new Map<string, ConnectedNode>();
  private screens = new Map<string, OpenScreen>();
  private screenWatchers = new Set<(sessionId: string, runnerKey: string) => void>();

  /** Registers a node's connection; the returned handle takes its frames and its disconnect. */
  connect(
    scope: { spaceId: string; userId: string },
    hello: NodeHelloFrame,
    transport: NodeTransport,
  ) {
    const key = nodeKey(scope.spaceId, scope.userId, hello.name);
    // A node that dials in again replaces its stale connection.
    this.nodes.get(key)?.transport.close();
    const node: ConnectedNode = { key, ...scope, hello, transport };
    this.nodes.set(key, node);

    return {
      handle: (frame: NodeToServerFrame) => this.handleFrame(node, frame),
      media: (message: Uint8Array) => this.media(node, message),
      disconnect: () => this.disconnect(node),
    };
  }

  /**
   * Runs carry on while the node is away, since their calls are HTTP; one
   * whose node does not come back fails on its inactivity deadline.
   */
  private disconnect(node: ConnectedNode) {
    if (this.nodes.get(node.key) !== node) return;
    this.nodes.delete(node.key);
    for (const [screenId, screen] of this.screens) {
      if (screen.nodeKey === node.key) this.endScreen(screenId, "The node went away.");
    }
  }

  private handleFrame(node: ConnectedNode, frame: NodeToServerFrame) {
    if (frame.type === "hello") {
      node.hello = { ...frame, name: node.hello.name };
    } else if (frame.type === "ping") {
      node.transport.send({ type: "ping" });
    } else if (frame.type === "screen") {
      for (const watch of this.screenWatchers) watch(frame.sessionId, `node:${node.key}`);
    } else if (frame.type === "screen.end") {
      if (this.screens.get(frame.screenId)?.nodeKey === node.key) {
        this.endScreen(frame.screenId, frame.error);
      }
    }
  }

  /** Called when a node says a session's screen can be opened. */
  watchScreens(watch: (sessionId: string, runnerKey: string) => void) {
    this.screenWatchers.add(watch);
  }

  /** The user's nodes in the space, for the settings. */
  listNodes({ spaceId, userId }: { spaceId: string; userId: string }): NodeSummary[] {
    return [...this.nodes.values()]
      .filter((n) => n.spaceId === spaceId && n.userId === userId)
      .map((node) => ({
        name: node.hello.name,
        os: node.hello.os,
        workdir: node.hello.workdir,
        adapters: node.hello.adapters,
        maxSessions: node.hello.maxSessions,
        shared: node.hello.shared,
      }));
  }

  /** Online nodes as runners: the user's own, and with `shared` those shared with the space. */
  runners(scope: { spaceId: string; userId: string | null; shared: boolean }): Runner[] {
    return [...this.nodes.values()]
      .filter(
        (n) =>
          n.spaceId === scope.spaceId &&
          (n.userId === scope.userId || (scope.shared && n.hello.shared)),
      )
      .map((node) => ({
        key: `node:${node.key}`,
        name: node.hello.name,
        description: { agents: node.hello.adapters },
        maxSessions: node.hello.maxSessions,
        send: async (request, signal) => this.send(node.key, request, signal),
        screens: {
          open: (sessionId, viewer) => this.openScreen(node.key, sessionId, viewer),
          closeAll: (sessionId) => {
            for (const [screenId, screen] of this.screens) {
              if (screen.sessionId === sessionId) this.closeScreen(screenId);
            }
          },
        },
      }));
  }

  /** By key rather than connection, so a node that dialled in again still gets it. */
  private send(key: string, request: RunnerRequest, signal?: AbortSignal) {
    const transport = this.nodes.get(key)?.transport;
    if (!transport) throw new Error("The node is offline.");
    if (signal && "runId" in request) {
      const { runId } = request;
      signal.addEventListener(
        "abort",
        () => this.nodes.get(key)?.transport.send({ type: "cancel", runId }),
        { once: true },
      );
    }
    transport.send({ type: "run", request });
  }

  private media(node: ConnectedNode, message: Uint8Array) {
    const { screenId, bytes } = decodeScreenMedia(message);
    const screen = this.screens.get(screenId);
    if (screen?.nodeKey === node.key) screen.viewer.send(bytes);
  }

  /** Ends a screen from the node's side. */
  private endScreen(screenId: string, error?: string) {
    const screen = this.screens.get(screenId);
    if (!screen) return;
    this.screens.delete(screenId);
    screen.viewer.close(error);
  }

  /** Ends a screen from the server's side, telling the node to stop streaming. */
  private closeScreen(screenId: string, error?: string) {
    const screen = this.screens.get(screenId);
    if (!screen) return;
    this.nodes.get(screen.nodeKey)?.transport.send({ type: "screen.close", screenId });
    this.endScreen(screenId, error);
  }

  private openScreen(key: string, sessionId: string, viewer: ScreenViewer): ScreenHandle {
    const transport = this.nodes.get(key)?.transport;
    if (!transport) throw new Error("The node is offline.");
    const screenId = randomUUID();
    this.screens.set(screenId, { sessionId, nodeKey: key, viewer });
    transport.send({ type: "screen.open", sessionId, screenId });
    return {
      input: (events) => {
        if (!this.screens.has(screenId)) return;
        this.nodes.get(key)?.transport.send({ type: "screen.input", screenId, events });
      },
      close: (error) => this.closeScreen(screenId, error),
    };
  }
}

/** The one registry of this server process. */
export const nodeRegistry = new NodeRegistry();
