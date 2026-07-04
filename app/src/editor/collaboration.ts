import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import * as Y from "yjs";
import type { CanvasTool } from "../canvas/elements/types.ts";

type ProsemirrorMapping = Map<Y.AbstractType<unknown>, unknown>;

export type DocumentPresenceState = {
  kind: "editor";
  focused?: boolean;
  selection?: {
    anchor?: unknown;
    head?: unknown;
    absoluteAnchor?: number;
    absoluteHead?: number;
  } | null;
};

export type CanvasPresenceState = {
  kind: "canvas";
  pointer: { x: number; y: number } | null;
  cursorColor?: string;
  view: { x: number; y: number; scale: number };
  selectionIds: string[];
  focusedNodeId: string | null;
  activeTool: CanvasTool | null;
};

export type DocumentPresenceProfile = {
  clientId: string;
  user: {
    id: string;
    name: string;
    color?: string | null;
  };
  state: DocumentPresenceState | null;
};

export type YSyncState = {
  doc: Y.Doc;
  type: Y.XmlFragment;
  binding: { mapping: ProsemirrorMapping };
};

const PRESENCE_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
  "#f43f5e",
];

function isYSyncState(value: unknown): value is YSyncState {
  const state = value as Partial<YSyncState> | null | undefined;
  return (
    state?.doc instanceof Y.Doc &&
    state?.type instanceof Y.XmlFragment &&
    state?.binding?.mapping instanceof Map
  );
}

export function findYSyncState(
  target: Editor | EditorState | null | undefined,
): YSyncState | null {
  const state = target && "state" in target ? target.state : target;
  if (!state) return null;

  for (const plugin of state.plugins) {
    const pluginState = plugin.getState(state);
    if (isYSyncState(pluginState)) {
      return pluginState;
    }
  }

  return null;
}

export function getPresenceColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

export function colorForPresenceProfile(profile: DocumentPresenceProfile) {
  if (profile.user.color && /^#[0-9a-f]{6}$/i.test(profile.user.color)) {
    return profile.user.color;
  }

  return getPresenceColor(profile.user.id || profile.clientId);
}
