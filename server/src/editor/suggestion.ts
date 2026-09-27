import type { Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * Trigger-character suggestions ("@…", "/…") for ProseMirror.
 *
 * The plugin owns the boring half: spotting the trigger in the text before the
 * caret, tracking the query while it is typed, and telling a renderer when to
 * open, update and close. The renderer owns the popup — see
 * #editor/extensions/MentionSuggestions.ts.
 *
 * Callers get one plugin per trigger; each keeps its own state and decoration,
 * so several can be active in the same editor without seeing each other.
 */

export type SuggestionRange = { from: number; to: number };

export interface SuggestionProps<Item = unknown> {
  editor: Editor;
  /** Covers the trigger character and everything typed after it. */
  range: SuggestionRange;
  /** What was typed after the trigger character. */
  query: string;
  /** The matched text, trigger character included. */
  text: string;
  items: Item[];
  /** Picks an item, running `command` against the range the query occupies. */
  command(item: Item): void;
  /** The decoration wrapping the matched text, while it is in the document. */
  decorationNode: Element | null;
  /** Viewport rect of the matched text, to position a popup against. */
  clientRect(): DOMRect | null;
}

export interface SuggestionKeyDownProps {
  view: EditorView;
  event: KeyboardEvent;
  range: SuggestionRange;
}

/**
 * Written as methods rather than function properties on purpose: that makes
 * their parameters bivariant, so a renderer for a concrete item type still
 * satisfies the default `unknown` one.
 */
export interface SuggestionRenderer<Item = unknown> {
  onStart?(props: SuggestionProps<Item>): void;
  onUpdate?(props: SuggestionProps<Item>): void;
  /** Return true to consume the key; anything else falls through to the editor. */
  onKeyDown?(props: SuggestionKeyDownProps): boolean;
  onExit?(props: SuggestionProps<Item>): void;
}

export interface SuggestionConfig<Item = unknown> {
  /** @default "@" */
  char?: string;
  /**
   * Whether the query may contain spaces. People's names need it; a command
   * menu does not, and is better off closing as soon as a space is typed.
   * @default false
   */
  allowSpaces?: boolean;
  items?(props: { editor: Editor; query: string }): Item[] | Promise<Item[]>;
  render?(): SuggestionRenderer<Item>;
  /** Runs when the renderer picks an item. Replaces `range` with whatever it inserts. */
  command?(props: { editor: Editor; range: SuggestionRange; item: Item }): void;
  /** Veto a match — used to skip positions where the schema rejects the node. */
  allow?(props: { editor: Editor; state: EditorState; range: SuggestionRange }): boolean;
}

export type SuggestionOptions<Item = unknown> = SuggestionConfig<Item> & {
  editor: Editor;
};

type SuggestionState = {
  active: boolean;
  range: SuggestionRange;
  query: string;
  text: string;
  decorationId: string;
};

const INACTIVE: SuggestionState = {
  active: false,
  range: { from: 0, to: 0 },
  query: "",
  text: "",
  decorationId: "",
};

let decorationCount = 0;

/**
 * The trigger character and the query typed after it, if the caret sits in one.
 *
 * Only the text node immediately before the caret is considered: a block
 * boundary or an inline atom (an already-inserted mention) ends a query. The
 * trigger also has to start a word, or every email address in the document
 * would open a popup — and the *last* eligible trigger wins, so "@ann @bo"
 * queries "bo" rather than reopening the first one.
 */
function findSuggestionMatch(
  $position: ResolvedPos,
  char: string,
  allowSpaces: boolean,
): { range: SuggestionRange; query: string; text: string } | null {
  const textBefore = $position.nodeBefore?.isText ? $position.nodeBefore.text : null;
  if (!textBefore) return null;

  let start = -1;
  for (let index = textBefore.length - 1; index >= 0; index--) {
    if (textBefore[index] !== char) continue;
    if (index === 0 || /\s/.test(textBefore[index - 1])) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;

  const query = textBefore.slice(start + char.length);
  // A second trigger inside the query is not a query character either — it is
  // the start of the next one, which the scan above already picked when it was
  // eligible. Here it only means this match is stale.
  if (!allowSpaces && (/\s/.test(query) || query.includes(char))) return null;

  const from = $position.pos - textBefore.length + start;
  return { range: { from, to: $position.pos }, query, text: char + query };
}

export function suggestionPlugin<Item>({
  editor,
  char = "@",
  allowSpaces = false,
  items = () => [],
  render = () => ({}),
  command = () => {},
  allow = () => true,
}: SuggestionOptions<Item>): Plugin {
  // Fresh per plugin, so two triggers in one editor never collide.
  const key = new PluginKey<SuggestionState>("suggestion");
  const renderer = render();

  // Whether the renderer currently has a popup open. Tracked here rather than
  // derived from the state transition, because `items` is awaited in between:
  // two quick keystrokes can otherwise resolve out of order and update a popup
  // that was never started.
  let open = false;
  let lastProps: SuggestionProps<Item> | null = null;
  let latestRequest = 0;

  function buildProps(
    view: EditorView,
    state: SuggestionState,
    matched: Item[],
  ): SuggestionProps<Item> {
    // Looked up per call: the decoration is re-created on every document change.
    const decorationNode = () =>
      view.dom.querySelector(`[data-suggestion-id="${state.decorationId}"]`);

    return {
      editor,
      range: state.range,
      query: state.query,
      text: state.text,
      items: matched,
      command: (item) => command({ editor, range: state.range, item }),
      decorationNode: decorationNode(),
      clientRect: () => {
        const rect = decorationNode()?.getBoundingClientRect();
        if (rect) return rect;

        // The decoration is gone by the time a popup handles its own exit, so
        // fall back to the caret.
        try {
          const coords = view.coordsAtPos(view.state.selection.$anchor.pos);
          return new DOMRect(
            coords.left,
            coords.top,
            coords.right - coords.left,
            coords.bottom - coords.top,
          );
        } catch {
          return null;
        }
      },
    };
  }

  return new Plugin({
    key,

    state: {
      init: () => INACTIVE,

      apply(transaction, previous, _oldState, state) {
        // The only meta this plugin sets is the one Escape dispatches to close
        // an open suggestion.
        if (transaction.getMeta(key)) return INACTIVE;

        const { selection } = transaction;
        // A composing IME keeps a non-empty selection over the text it is
        // still resolving; closing there would drop the popup mid-word.
        if (!editor.isEditable || (!selection.empty && !editor.view.composing)) {
          return INACTIVE;
        }

        const match = findSuggestionMatch(selection.$from, char, allowSpaces);
        if (!match || !allow({ editor, state, range: match.range })) return INACTIVE;

        return {
          active: true,
          range: match.range,
          query: match.query,
          text: match.text,
          // Kept across updates so the popup keeps measuring the same element.
          decorationId: previous.decorationId || `suggestion-${++decorationCount}`,
        };
      },
    },

    props: {
      handleKeyDown(view, event) {
        const state = key.getState(view.state);
        if (!state?.active) return false;

        if (renderer.onKeyDown?.({ view, event, range: state.range })) return true;
        if (event.key !== "Escape") return false;

        view.dispatch(view.state.tr.setMeta(key, { exit: true }));
        return true;
      },

      decorations(state) {
        const suggestion = key.getState(state);
        if (!suggestion?.active) return null;

        // Purely an anchor to measure: the popup positions itself against this
        // element rather than the caret, so it stays put while the query grows.
        return DecorationSet.create(state.doc, [
          Decoration.inline(suggestion.range.from, suggestion.range.to, {
            nodeName: "span",
            class: "suggestion",
            "data-suggestion-id": suggestion.decorationId,
          }),
        ]);
      },
    },

    view: () => ({
      update: async (view, previousState) => {
        const previous = key.getState(previousState);
        const next = key.getState(view.state);
        if (!previous || !next) return;

        const moved =
          previous.range.from !== next.range.from || previous.range.to !== next.range.to;
        if (previous.active === next.active && !moved && previous.query === next.query) {
          return;
        }

        // Bumped for every transition, so an in-flight `items` call whose
        // result is no longer wanted resolves into nothing.
        const request = ++latestRequest;

        if (!next.active) {
          if (!open) return;
          open = false;
          renderer.onExit?.(buildProps(view, previous, []));
          return;
        }

        const matched = await items({ editor, query: next.query });
        if (request !== latestRequest) return;

        lastProps = buildProps(view, next, matched);
        if (open) {
          renderer.onUpdate?.(lastProps);
        } else {
          open = true;
          renderer.onStart?.(lastProps);
        }
      },

      destroy: () => {
        if (!open || !lastProps) return;
        open = false;
        renderer.onExit?.(lastProps);
      },
    }),
  });
}
