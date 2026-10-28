/**
 * Frames between the server and a node (`vektor agent serve`): one JSON object
 * per WebSocket message. The node dials in, so it needs no inbound port.
 *
 * A node is a runner (docs/runners.md): `run` carries the same requests
 * an HTTP runner gets, and a run's calls, its result included, go to the
 * server over HTTP as any runner's do. `cancel` is a node's shortcut for a run
 * the server gave up on. Screens, a session's live display, are a node's own.
 */

import type { RunnerRequest } from "#runners/contract.ts";

/** How often each side pings, and how long silence may last before the node is offline. */
export const NODE_PING_INTERVAL_MS = 15_000;
export const NODE_OFFLINE_AFTER_MS = 45_000;

export type NodeHelloFrame = {
  type: "hello";
  name: string;
  os: string;
  workdir: string;
  /** Its agents, in order of preference; the first runs a session that names none. */
  adapters: string[];
  maxSessions: number;
  /** Runs still going here, so a reconnect keeps them rather than failing them. */
  runs: string[];
  /** Runs jobs for anyone in the space, not only for its own user. */
  shared: boolean;
};

export type ServerToNodeFrame =
  | { type: "run"; request: RunnerRequest }
  | { type: "cancel"; runId: string }
  /** A viewer opened the session's screen; its media comes back as binary messages tagged with `screenId`. */
  | { type: "screen.open"; sessionId: string; screenId: string }
  | { type: "screen.input"; screenId: string; events: ScreenInputEvent[] }
  | { type: "screen.close"; screenId: string }
  | { type: "ping" };

export type NodeToServerFrame =
  | NodeHelloFrame
  /** The session's environment has a screen that viewers can open. */
  | { type: "screen"; sessionId: string }
  | { type: "screen.end"; screenId: string; error?: string }
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

/** A node as the settings show it. */
export type NodeSummary = {
  name: string;
  os: string;
  workdir: string;
  adapters: string[];
  maxSessions: number;
  running: number;
  online: boolean;
  shared: boolean;
};
