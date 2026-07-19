import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { getRelativeSelection } from "y-prosemirror";
import * as Y from "yjs";
import type { CanvasTool } from "#canvas/extensions/types.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";

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

/**
 * Snapshot of the local user's editor presence (focus + selection as Yjs
 * relative positions) for broadcasting to the document's presence room.
 */
export function currentEditorPresenceState(
  editor: Editor | null | undefined,
): DocumentPresenceState {
  if (!editor) {
    return { kind: "editor", focused: false, selection: null };
  }

  const syncState = findYSyncState(editor);
  if (!syncState?.binding) {
    return { kind: "editor", focused: false, selection: null };
  }

  try {
    const focused = editor.isFocused || editor.view.hasFocus();
    const selection = editor.state.selection;
    // findYSyncState only surfaces the binding's mapping, but at runtime the
    // plugin state holds the full y-prosemirror binding.
    const { anchor, head } = getRelativeSelection(
      syncState.binding as Parameters<typeof getRelativeSelection>[0],
      editor.state,
    );
    return {
      kind: "editor",
      focused,
      selection: {
        anchor: Y.relativePositionToJSON(anchor),
        head: Y.relativePositionToJSON(head),
        absoluteAnchor: selection.anchor,
        absoluteHead: selection.head,
      },
    };
  } catch {
    return { kind: "editor", focused: false, selection: null };
  }
}

export function colorForPresenceProfile(profile: DocumentPresenceProfile) {
  if (profile.user.color && /^#[0-9a-f]{6}$/i.test(profile.user.color)) {
    return profile.user.color;
  }

  return getAvatarColor(profile.user.id || profile.clientId);
}
