import { Node } from "@tiptap/core";
import { type SuggestionConfig, suggestionPlugin } from "#editor/suggestion.ts";
import { nodeFromSpec } from "./specSchema.ts";

/** What the popup hands back when a person is picked — the node's attributes. */
export type MentionAttributes = { id: string; label: string };

export interface MentionOptions {
  /**
   * Suggestion config. The schema-only node leaves it empty (no popup on the
   * server); `MentionSuggestions` supplies the item lookup and the lit-rendered
   * popup.
   */
  suggestion: SuggestionConfig<MentionAttributes>;
}

/**
 * People `@mention` node, rendered as the `<user-mention>` custom element so the
 * same markup works inside and outside the editor (see #editor/css/mentions.css
 * and #editor/elements/user-mention.ts). `id` holds the user's email — the
 * identity the notification pipeline reads back out of published HTML
 * (#documents/mentions.ts).
 *
 * Document mentions are a separate node (DocumentMention.ts); the shared
 * suggestion popup decides which of the two it inserts.
 */
export const Mentions = Node.create<MentionOptions>({
  name: "mention",
  // Above the default 100 so the suggestion plugin sits ahead of the base
  // extensions' plugins: while the popup is open its handleKeyDown must claim
  // Enter/Tab/Arrow keys before the list and paragraph keymaps see them.
  priority: 101,
  ...nodeFromSpec("mention"),

  addOptions() {
    return { suggestion: {} };
  },

  addKeyboardShortcuts() {
    return {
      // Backspacing a mention leaves the plain "@" behind, so the trigger
      // survives and typing continues the query instead of starting over.
      Backspace: () =>
        this.editor.commands.command(({ tr, state }) => {
          const { empty, $from } = state.selection;
          const mention = $from.nodeBefore;
          if (!empty || mention?.type !== this.type) return false;

          tr.insertText("@", $from.pos - mention.nodeSize, $from.pos);
          return true;
        }),
    };
  },

  addProseMirrorPlugins() {
    return [
      suggestionPlugin<MentionAttributes>({
        editor: this.editor,
        char: "@",
        command: ({ editor, range, item }) => {
          // Swallow a space that already follows the query so the inserted
          // mention ends up with exactly one trailing space.
          const nodeAfter = editor.view.state.selection.$to.nodeAfter;
          const to = nodeAfter?.text?.startsWith(" ") ? range.to + 1 : range.to;

          editor
            .chain()
            .focus()
            .insertContentAt({ from: range.from, to }, [
              { type: this.name, attrs: item },
              { type: "text", text: " " },
            ])
            .run();

          // insertContentAt can leave the DOM selection spanning the new node;
          // collapsing keeps the caret after the trailing space. `rangeCount`
          // guards the case of nothing being selected at all — collapsing then
          // throws instead of being a no-op.
          const domSelection = editor.view.dom.ownerDocument.defaultView?.getSelection();
          if (domSelection?.rangeCount) domSelection.collapseToEnd();
        },
        allow: ({ state, range }) =>
          !!state.doc.resolve(range.from).parent.type.contentMatch.matchType(this.type),
        ...this.options.suggestion,
      }),
    ];
  },
});
