import type { Editor } from "@tiptap/core";
import type { RemoteSelection, SheetSelection } from "@vektorapp/spreadsheet/presence";
import {
  type DocumentPresenceProfile,
  spreadsheetPresenceTablePosition,
} from "#editor/collaboration.ts";

export const SPREADSHEET_SELECTION_EVENT = "spreadsheet-selection-change";

/** Internal bridge from a spreadsheet NodeView to the document room owner. */
export interface SpreadsheetSelectionEventDetail {
  source: HTMLElement;
  getTablePosition: () => number | undefined;
  selection: SheetSelection | null;
}

type Subscription = {
  getTablePosition: () => number | undefined;
  update: (selections: RemoteSelection[]) => void;
};

type EditorPresence = {
  profiles: DocumentPresenceProfile[];
  subscriptions: Set<Subscription>;
};

const editorPresence = new WeakMap<Editor, EditorPresence>();

function presenceFor(editor: Editor): EditorPresence {
  const current = editorPresence.get(editor);
  if (current) return current;

  const created: EditorPresence = { profiles: [], subscriptions: new Set() };
  editorPresence.set(editor, created);
  return created;
}

function selectionsFor(
  editor: Editor,
  tablePosition: number | undefined,
  profiles: DocumentPresenceProfile[],
): RemoteSelection[] {
  if (tablePosition === undefined) return [];

  return profiles.flatMap((profile) => {
    const state = profile.state;
    if (
      state?.kind !== "spreadsheet" ||
      spreadsheetPresenceTablePosition(editor, state) !== tablePosition
    ) {
      return [];
    }
    return [
      {
        clientId: profile.clientId,
        user: profile.user,
        selection: state.selection,
      },
    ];
  });
}

function refresh(editor: Editor, presence: EditorPresence): void {
  for (const subscription of presence.subscriptions) {
    subscription.update(
      selectionsFor(editor, subscription.getTablePosition(), presence.profiles),
    );
  }
}

/** Routes room presence to the NodeView for the corresponding embedded table. */
export function setSpreadsheetPresenceProfiles(
  editor: Editor,
  profiles: DocumentPresenceProfile[],
): void {
  const presence = presenceFor(editor);
  presence.profiles = profiles;
  refresh(editor, presence);
}

/** Receives just the peer ranges belonging to one embedded spreadsheet. */
export function subscribeToSpreadsheetPresence(
  editor: Editor,
  getTablePosition: () => number | undefined,
  update: (selections: RemoteSelection[]) => void,
): () => void {
  const presence = presenceFor(editor);
  const subscription = { getTablePosition, update };
  presence.subscriptions.add(subscription);
  update(selectionsFor(editor, getTablePosition(), presence.profiles));

  return () => {
    presence.subscriptions.delete(subscription);
  };
}
