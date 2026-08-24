import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  getRelativeSelection,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";
import type { CanvasToolId } from "#canvas/index.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import type { SheetSelection } from "#spreadsheet/presence.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";

type ProsemirrorMapping = Map<Y.AbstractType<unknown>, unknown>;

export type EditorPresenceState = {
  kind: "editor";
  focused?: boolean;
  selection?: {
    anchor?: unknown;
    head?: unknown;
    absoluteAnchor?: number;
    absoluteHead?: number;
  } | null;
};

/** A cell range in one spreadsheet table embedded in the rich-text document. */
export type SpreadsheetPresenceState = {
  kind: "spreadsheet";
  table: {
    relativePosition?: unknown;
    absolutePosition: number;
  };
  selection: SheetSelection;
};

export type DocumentPresenceState = EditorPresenceState | SpreadsheetPresenceState;

export type CanvasPresenceState = {
  kind: "canvas";
  pointer: { x: number; y: number } | null;
  cursorColor?: string;
  view: { x: number; y: number; scale: number };
  selectionIds: string[];
  focusedNodeId: string | null;
  activeTool: CanvasToolId | null;
};

export type DocumentPresenceProfile = {
  clientId: string;
  user: {
    id: string;
    name: string;
    color?: string | null;
    appearance?: PublicUserAppearance;
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

  // The plugin key is typed `any`, and an editor without the Collaboration
  // extension has no sync state at all.
  const syncState: unknown = ySyncPluginKey.getState(state);
  return isYSyncState(syncState) ? syncState : null;
}

/**
 * Snapshot of the local user's editor presence (focus + selection as Yjs
 * relative positions) for broadcasting to the document's presence room.
 */
export function currentEditorPresenceState(
  editor: Editor | null | undefined,
): EditorPresenceState {
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

/**
 * Anchors an embedded spreadsheet selection to its table in the shared Yjs
 * document. The absolute position is a fallback for the instant before the
 * collaboration binding has produced its mapping.
 */
export function currentSpreadsheetPresenceState(
  editor: Editor,
  tablePosition: number,
  selection: SheetSelection,
): SpreadsheetPresenceState {
  const syncState = findYSyncState(editor);
  if (!syncState) {
    return {
      kind: "spreadsheet",
      table: { absolutePosition: tablePosition },
      selection,
    };
  }

  try {
    const relativePosition = absolutePositionToRelativePosition(
      tablePosition,
      syncState.type,
      syncState.binding.mapping as Parameters<
        typeof absolutePositionToRelativePosition
      >[2],
    );
    return {
      kind: "spreadsheet",
      table: {
        relativePosition: Y.relativePositionToJSON(relativePosition),
        absolutePosition: tablePosition,
      },
      selection,
    };
  } catch {
    return {
      kind: "spreadsheet",
      table: { absolutePosition: tablePosition },
      selection,
    };
  }
}

/** Resolves a peer's table anchor against this editor's current document. */
export function spreadsheetPresenceTablePosition(
  editor: Editor,
  state: SpreadsheetPresenceState,
): number | null {
  const syncState = findYSyncState(editor);
  const relativePosition = state.table.relativePosition;
  if (syncState && relativePosition) {
    try {
      const resolved = relativePositionToAbsolutePosition(
        syncState.doc,
        syncState.type,
        Y.createRelativePositionFromJSON(relativePosition as never),
        syncState.binding.mapping as Parameters<
          typeof relativePositionToAbsolutePosition
        >[3],
      );
      if (resolved !== null) return resolved;
    } catch {
      // Fall through to the absolute position carried for unsynced clients.
    }
  }

  const absolutePosition = state.table.absolutePosition;
  return Number.isFinite(absolutePosition) ? absolutePosition : null;
}

/**
 * Rejection for a join whose room was left before the server answered. The
 * caller moved on by definition, so it is not a failure worth reporting.
 */
export class CollaborationJoinAbandoned extends Error {
  constructor() {
    super("Left the document before it finished syncing");
    this.name = "CollaborationJoinAbandoned";
  }
}

export class CollaborationResetRequired extends Error {
  constructor() {
    super("The document was reopened from storage and has to be resynced");
    this.name = "CollaborationResetRequired";
  }
}

export function colorForPresenceProfile(profile: DocumentPresenceProfile) {
  if (profile.user.color && /^#[0-9a-f]{6}$/i.test(profile.user.color)) {
    return profile.user.color;
  }

  return getAvatarColor(profile.user.id || profile.clientId);
}
