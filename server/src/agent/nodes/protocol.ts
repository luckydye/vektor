/**
 * Frames between the server and a node (`vektor agent serve`): one JSON object
 * per WebSocket message. The node dials in, so it needs no inbound port.
 * Inbound messages for a running agent are not a frame: they wait in the
 * task's mailbox and the agent reads them through the `read_messages` MCP tool.
 */

/** How often each side pings, and how long silence may last before the node is offline. */
export const NODE_PING_INTERVAL_MS = 15_000;
export const NODE_OFFLINE_AFTER_MS = 45_000;

export type NodeHelloFrame = {
  type: "hello";
  name: string;
  os: string;
  workdir: string;
  /** In order of preference; the first runs a task that names none. */
  adapters: string[];
  maxSessions: number;
  /** Tasks still running here, so a reconnect resumes them rather than failing them. */
  sessions: string[];
};

/** What a session needs to reach the Vektor server as the task's user. */
export type NodeSessionAccess = {
  spaceId: string;
  /** Short-lived; scopes the session's MCP server to the task's user. */
  jobToken: string;
};

export type ServerToNodeFrame =
  | {
      type: "session.new";
      taskId: string;
      adapter: string;
      access: NodeSessionAccess;
    }
  | { type: "session.prompt"; taskId: string; text: string }
  | { type: "session.cancel"; taskId: string }
  /** A viewer opened the task's screen; its media comes back as binary messages tagged with `screenId`. */
  | { type: "screen.open"; taskId: string; screenId: string }
  | { type: "screen.input"; screenId: string; events: ScreenInputEvent[] }
  | { type: "screen.close"; screenId: string }
  | { type: "ping" };

export type SessionStopReason = "end_turn" | "cancelled" | "error";

export type NodeToServerFrame =
  | NodeHelloFrame
  /** An ACP `session/update` notification's update. */
  | { type: "session.update"; taskId: string; update: Record<string, unknown> }
  | {
      type: "session.result";
      taskId: string;
      stopReason: SessionStopReason;
      error?: string;
    }
  /** The task's environment has a screen that viewers can open. */
  | { type: "session.screen"; taskId: string }
  | { type: "screen.end"; screenId: string; error?: string }
  /** From the agent to the parent (`to: "parent"`) or a sibling sub-agent. */
  | { type: "message"; taskId: string; to: string; text: string }
  | { type: "ping" };

/**
 * Input for a screen, one JSON line each on the manager's `input`: pixel
 * coordinates, Linux evdev key and button codes.
 */
export type ScreenInputEvent =
  | { move: { x: number; y: number } }
  | { button: { button: number; down: boolean } }
  | { key: { code: number; down: boolean } }
  | { scroll: { value: number; horizontal: boolean } };

export function isScreenInputEvent(value: unknown): value is ScreenInputEvent {
  if (typeof value !== "object" || value === null) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1) return false;
  const [kind, body] = entries[0] as [string, Record<string, unknown>];
  if (typeof body !== "object" || body === null) return false;
  const int = (v: unknown) => Number.isInteger(v);
  const bool = (v: unknown) => typeof v === "boolean";
  if (kind === "move") return int(body.x) && int(body.y);
  if (kind === "button") return int(body.button) && bool(body.down);
  if (kind === "key") return int(body.code) && bool(body.down);
  if (kind === "scroll") return int(body.value) && bool(body.horizontal);
  return false;
}

/** A binary message carries one screen's media: `[id length:u8][screenId][bytes]`. */
export function encodeScreenMedia(
  screenId: string,
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const id = new TextEncoder().encode(screenId);
  const message = new Uint8Array(1 + id.length + bytes.length);
  message[0] = id.length;
  message.set(id, 1);
  message.set(bytes, 1 + id.length);
  return message;
}

export function decodeScreenMedia(message: Uint8Array) {
  const end = 1 + message[0];
  return {
    screenId: new TextDecoder().decode(message.subarray(1, end)),
    bytes: message.subarray(end),
  };
}

export function parseFrame<T extends { type: string }>(raw: string): T | null {
  try {
    const frame = JSON.parse(raw) as unknown;
    if (
      typeof frame === "object" &&
      frame !== null &&
      typeof (frame as { type?: unknown }).type === "string"
    ) {
      return frame as T;
    }
  } catch {
    // A malformed frame is dropped like any other noise on the socket.
  }
  return null;
}

/** A node as agents and clients see it. */
export type NodeSummary = {
  name: string;
  os: string;
  workdir: string;
  adapters: string[];
  maxSessions: number;
  running: number;
  online: boolean;
};

export type RemoteTaskStatus = "running" | "done" | "failed" | "cancelled";

/** What a poll of a remote task reports. */
export type RemoteTaskPoll = {
  status: RemoteTaskStatus;
  /** The agent's final answer once finished, or its error. */
  output?: string;
  /** Whether viewers can open the task's screen. */
  screen: boolean;
  /** Messages the remote agent sent since the last poll. */
  messages: Array<{ to: string; text: string }>;
};

/** The server-side operations a sub-agent hub needs to run work on nodes. */
export interface AgentNodeHost {
  listNodes(request: { spaceId: string; userId: string }): Promise<NodeSummary[]>;
  startRemoteTask(request: {
    spaceId: string;
    userId: string;
    jobToken: string;
    task: string;
    node?: string;
    adapter?: string;
  }): Promise<{ taskId: string; node: string }>;
  /** Resolves at once with anything pending, else when something happens or `waitMs` passes. */
  pollRemoteTask(taskId: string, waitMs: number): Promise<RemoteTaskPoll>;
  sendRemoteTask(taskId: string, from: string, text: string): Promise<void>;
  cancelRemoteTask(taskId: string): Promise<void>;
}
