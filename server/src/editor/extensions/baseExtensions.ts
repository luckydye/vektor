import {
  Extension,
  escapeForRegEx,
  getMarkAttributes,
  getMarksBetween,
  InputRule,
  Mark,
  markInputRule,
  markPasteRule,
  Node,
  textblockTypeInputRule,
  wrappingInputRule,
} from "@tiptap/core";
import {
  Fragment,
  type MarkType,
  type NodeType,
  type Node as PMNode,
  type Schema,
} from "@tiptap/pm/model";
import {
  liftListItem as pmLiftListItem,
  sinkListItem as pmSinkListItem,
  splitListItem as pmSplitListItem,
  wrapInList as pmWrapInList,
} from "@tiptap/pm/schema-list";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";
import { HEADING_LEVELS, nodesWithAttr } from "#documents/schema/specs.ts";
import { isSafeUrlValue } from "#utils/html.ts";
import { markFromSpec, nodeFromSpec } from "./specSchema.ts";

/**
 * The editor's base nodes and marks.
 *
 * Each one is its behaviour — commands, keymaps, input rules — plus the schema
 * half spread in from `#documents/schema/specs.ts`. Nothing here declares a tag
 * name, an attribute or a parse rule of its own: the server serializes the same
 * documents from that table without loading any of this.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraph: {
      setParagraph: () => ReturnType;
    };
    hardBreak: {
      setHardBreak: () => ReturnType;
    };
    bold: {
      setBold: () => ReturnType;
      toggleBold: () => ReturnType;
      unsetBold: () => ReturnType;
    };
    italic: {
      setItalic: () => ReturnType;
      toggleItalic: () => ReturnType;
      unsetItalic: () => ReturnType;
    };
    strike: {
      setStrike: () => ReturnType;
      toggleStrike: () => ReturnType;
      unsetStrike: () => ReturnType;
    };
    underline: {
      setUnderline: () => ReturnType;
      toggleUnderline: () => ReturnType;
      unsetUnderline: () => ReturnType;
    };
    code: {
      setCode: () => ReturnType;
      toggleCode: () => ReturnType;
      unsetCode: () => ReturnType;
    };
    subscript: {
      setSubscript: () => ReturnType;
      toggleSubscript: () => ReturnType;
      unsetSubscript: () => ReturnType;
    };
    superscript: {
      setSuperscript: () => ReturnType;
      toggleSuperscript: () => ReturnType;
      unsetSuperscript: () => ReturnType;
    };
    textStyle: {
      removeEmptyTextStyle: () => ReturnType;
    };
    color: {
      setColor: (color: string) => ReturnType;
      unsetColor: () => ReturnType;
    };
    backgroundColor: {
      setBackgroundColor: (color: string) => ReturnType;
      unsetBackgroundColor: () => ReturnType;
    };
    heading: {
      setHeading: (attrs: { level: number }) => ReturnType;
      toggleHeading: (attrs: { level: number }) => ReturnType;
      unsetHeading: () => ReturnType;
    };
    textAlign: {
      setTextAlign: (alignment: string) => ReturnType;
      unsetTextAlign: () => ReturnType;
    };
    codeBlock: {
      setCodeBlock: (attrs?: { language?: string }) => ReturnType;
      toggleCodeBlock: (attrs?: { language?: string }) => ReturnType;
    };
    link: {
      setLink: (attrs: { href: string; target?: string; rel?: string }) => ReturnType;
      toggleLink: (attrs: { href: string; target?: string; rel?: string }) => ReturnType;
      unsetLink: () => ReturnType;
    };
    bulletList: {
      toggleBulletList: () => ReturnType;
    };
    orderedList: {
      toggleOrderedList: () => ReturnType;
    };
    taskList: {
      toggleTaskList: () => ReturnType;
    };
    blockquote: {
      setBlockquote: () => ReturnType;
      toggleBlockquote: () => ReturnType;
      unsetBlockquote: () => ReturnType;
    };
    horizontalRule: {
      setHorizontalRule: () => ReturnType;
    };
  }
}

const htmlAttributeOptions = () => ({ HTMLAttributes: {} });

// ---- Nodes ----

export const Document = Node.create({ name: "doc", ...nodeFromSpec("doc") });

export const Text = Node.create({ name: "text", ...nodeFromSpec("text") });

export const Paragraph = Node.create({
  name: "paragraph",
  priority: 1000,
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("paragraph"),
  addCommands() {
    return {
      setParagraph:
        () =>
        ({ commands }) =>
          commands.setNode(this.name),
    };
  },
});

export const HardBreak = Node.create({
  name: "hardBreak",
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("hardBreak"),
  renderText() {
    return "\n";
  },
  addCommands() {
    return {
      setHardBreak:
        () =>
        ({ chain }) =>
          chain()
            .command(({ tr, dispatch }) => {
              if (dispatch) {
                const { selection, storedMarks } = tr;
                const { $from } = selection;
                const currentMarks =
                  storedMarks ?? ($from.parentOffset ? $from.marks() : []);
                tr.replaceSelectionWith(this.type.create(null, null, currentMarks));
                tr.scrollIntoView();
                dispatch(tr);
              }
              return true;
            })
            .run(),
    };
  },
  addKeyboardShortcuts() {
    // ProseMirror preventDefaults every Enter keydown, so the global shortcut
    // handler never sees these — they only work from the editor's own keymap.
    return {
      "Shift-Enter": () => this.editor.commands.setHardBreak(),
      "Mod-Enter": () => this.editor.commands.setHardBreak(),
      "Ctrl-Enter": () => this.editor.commands.setHardBreak(),
    };
  },
});

// ---- Marks ----

/**
 * A markdown emphasis rule: on the closing delimiter, drop both delimiters and
 * mark the text between them. Every type in `types` is applied, so one rule can
 * set more than one mark — `***text***` is bold and italic at once.
 */
function emphasisInputRule(find: RegExp, types: MarkType[]) {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const text = match[match.length - 1];
      if (!text) return null;
      const fullMatch = match[0];
      const leading = fullMatch.search(/\S/);
      const textStart = range.from + fullMatch.indexOf(text);
      const textEnd = textStart + text.length;

      // Inline code excludes every other mark, so leave its text alone.
      const excluded = getMarksBetween(range.from, range.to, state.doc).some(
        (item) =>
          item.to > textStart &&
          types.some((type) => item.mark.type !== type && item.mark.type.excludes(type)),
      );
      if (excluded) return null;

      const { tr } = state;
      if (textEnd < range.to) tr.delete(textEnd, range.to);
      if (textStart > range.from) tr.delete(range.from + leading, textStart);
      const from = range.from + leading;
      for (const type of types) {
        tr.addMark(from, from + text.length, type.create());
        tr.removeStoredMark(type);
      }
    },
  });
}

/**
 * One emphasis rule per spelling of the same emphasis — `**` and `__` both mean
 * bold. The delimiter has to be preceded by the start of the block or a space,
 * or `snake_case_names` would turn italic halfway through being typed.
 */
function emphasisRules(schema: Schema, delimiters: string[], markNames: string[]) {
  const types = markNames.map((name) => schema.marks[name]);
  return delimiters.map((delimiter) => {
    const pattern = escapeForRegEx(delimiter);
    const inner = `[^${escapeForRegEx(delimiter[0])}]+`;
    return emphasisInputRule(
      new RegExp(
        `(?:^|\\s)(${pattern}(?!\\s+${pattern})(${inner})${pattern}(?!\\s+${pattern}))$`,
      ),
      types,
    );
  });
}

export const Bold = Mark.create({
  name: "bold",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("bold"),
  addCommands() {
    return {
      setBold:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleBold:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetBold:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return {
      // Browsers apply their own native bold formatting to contenteditable on
      // Mod-b, ahead of the window-level shortcuts.json handler. Binding it
      // here lets ProseMirror's keymap preventDefault it and run our command.
      "Mod-b": () => this.editor.commands.toggleBold(),
    };
  },
  addInputRules() {
    return [
      // The triple form lives here so it is tried before the `**` and `*`
      // rules, neither of which matches a delimiter longer than its own.
      ...emphasisRules(this.type.schema, ["***", "___"], ["bold", "italic"]),
      ...emphasisRules(this.type.schema, ["**", "__"], ["bold"]),
    ];
  },
});

export const Italic = Mark.create({
  name: "italic",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("italic"),
  addCommands() {
    return {
      setItalic:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleItalic:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetItalic:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-i": () => this.editor.commands.toggleItalic(),
    };
  },
  addInputRules() {
    return emphasisRules(this.type.schema, ["*", "_"], ["italic"]);
  },
});

export const Strike = Mark.create({
  name: "strike",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("strike"),
  addCommands() {
    return {
      setStrike:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleStrike:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetStrike:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addInputRules() {
    return emphasisRules(this.type.schema, ["~~", "~"], ["strike"]);
  },
});

export const Underline = Mark.create({
  name: "underline",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("underline"),
  addCommands() {
    return {
      setUnderline:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleUnderline:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetUnderline:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-u": () => this.editor.commands.toggleUnderline(),
    };
  },
});

export const Code = Mark.create({
  name: "code",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("code"),
  addCommands() {
    return {
      setCode:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleCode:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetCode:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addInputRules() {
    return [
      markInputRule({
        find: /(?:^|\s)(`(?!\s+`)([^`]+)`(?!\s+`))$/,
        type: this.type,
      }),
    ];
  },
});

export const Subscript = Mark.create({
  name: "subscript",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("subscript"),
  addCommands() {
    return {
      setSubscript:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetSubscript:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

export const Superscript = Mark.create({
  name: "superscript",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("superscript"),
  addCommands() {
    return {
      setSuperscript:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetSuperscript:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

export const TextStyle = Mark.create({
  name: "textStyle",
  addOptions: htmlAttributeOptions,
  ...markFromSpec("textStyle"),
  addCommands() {
    return {
      removeEmptyTextStyle:
        () =>
        ({ state, commands }) => {
          const attributes = getMarkAttributes(state, this.type);
          const hasStyles = Object.entries(attributes).some(([, value]) => !!value);
          if (hasStyles) return false;
          return commands.unsetMark(this.name);
        },
    };
  },
});

// `color` and `backgroundColor` are attributes of the `textStyle` mark in the
// spec table; these extensions only carry the commands that set them.
export const Color = Extension.create({
  name: "color",
  addCommands() {
    return {
      setColor:
        (color: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { color }).run(),
      unsetColor:
        () =>
        ({ chain }) =>
          chain().setMark("textStyle", { color: null }).removeEmptyTextStyle().run(),
    };
  },
});

export const BackgroundColor = Extension.create({
  name: "backgroundColor",
  addCommands() {
    return {
      setBackgroundColor:
        (color: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { backgroundColor: color }).run(),
      unsetBackgroundColor:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { backgroundColor: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});

// ---- Heading ----

export const Heading = Node.create({
  name: "heading",
  addOptions() {
    return { levels: HEADING_LEVELS, HTMLAttributes: {} };
  },
  ...nodeFromSpec("heading"),
  addCommands() {
    return {
      setHeading:
        (attrs: { level: number }) =>
        ({ commands }) => {
          if (!this.options.levels.includes(attrs.level)) return false;
          return commands.setNode(this.name, attrs);
        },
      toggleHeading:
        (attrs: { level: number }) =>
        ({ commands }) => {
          if (!this.options.levels.includes(attrs.level)) return false;
          return commands.toggleNode(this.name, "paragraph", attrs);
        },
      unsetHeading:
        () =>
        ({ commands }) =>
          commands.setNode("paragraph"),
    };
  },
  addInputRules() {
    return this.options.levels.map((level: number) =>
      textblockTypeInputRule({
        find: new RegExp(`^(#{${level}})\\s$`),
        type: this.type,
        getAttributes: () => ({ level }),
      }),
    );
  },
});

// ---- TextAlign ----

// The `textAlign` attribute lives on the nodes that carry it in the spec table;
// this extension is the commands that set it.
export const TextAlign = Extension.create({
  name: "textAlign",
  addOptions() {
    return {
      types: nodesWithAttr("textAlign"),
      alignments: ["left", "center", "right", "justify"],
    };
  },
  addCommands() {
    return {
      setTextAlign:
        (alignment: string) =>
        ({ commands }) => {
          if (!this.options.alignments.includes(alignment)) return false;
          return this.options.types.every((type: string) =>
            commands.updateAttributes(type, { textAlign: alignment }),
          );
        },
      unsetTextAlign:
        () =>
        ({ commands }) =>
          this.options.types.every((type: string) =>
            commands.resetAttributes(type, "textAlign"),
          ),
    };
  },
});

// ---- CodeBlock ----

export const CodeBlock = Node.create({
  name: "codeBlock",
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("codeBlock"),
  addCommands() {
    return {
      setCodeBlock:
        (attrs?: { language?: string }) =>
        ({ commands }) =>
          commands.setNode(this.name, attrs),
      toggleCodeBlock:
        (attrs?: { language?: string }) =>
        ({ commands }) =>
          commands.toggleNode(this.name, "paragraph", attrs),
    };
  },
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^```([a-z]*)[\s\n]$/,
        type: this.type,
        getAttributes: (match) => ({ language: match[1] || null }),
      }),
    ];
  },
});

// ---- Blockquote ----

export const Blockquote = Node.create({
  name: "blockquote",
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("blockquote"),
  addCommands() {
    return {
      setBlockquote:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      toggleBlockquote:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
      unsetBlockquote:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*>\s$/,
        type: this.type,
      }),
    ];
  },
});

// ---- HorizontalRule ----

export const HorizontalRule = Node.create({
  name: "horizontalRule",
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("horizontalRule"),
  addCommands() {
    return {
      setHorizontalRule:
        () =>
        ({ chain }) =>
          chain()
            .insertContent({ type: this.name })
            .command(({ tr, dispatch }) => {
              if (dispatch) {
                const { $to } = tr.selection;
                const posAfter = $to.end();
                if ($to.nodeAfter) {
                  tr.setSelection(TextSelection.create(tr.doc, $to.pos));
                } else {
                  const node = $to.parent.type.contentMatch.defaultType?.create();
                  if (node) {
                    tr.insert(posAfter, node);
                    tr.setSelection(TextSelection.create(tr.doc, posAfter + 1));
                  }
                }
                tr.scrollIntoView();
              }
              return true;
            })
            .run(),
    };
  },
});

// ---- Link ----

const URL_RE =
  /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

export const Link = Mark.create({
  name: "link",
  priority: 1000,
  ...markFromSpec("link"),
  addCommands() {
    return {
      setLink:
        (attrs: { href: string; target?: string; rel?: string }) =>
        ({ chain }) =>
          chain().setMark(this.name, attrs).setMeta("preventAutolink", true).run(),
      toggleLink:
        (attrs: { href: string; target?: string; rel?: string }) =>
        ({ chain }) =>
          chain()
            .toggleMark(this.name, attrs, { extendEmptyMarkRange: true })
            .setMeta("preventAutolink", true)
            .run(),
      unsetLink:
        () =>
        ({ chain }) =>
          chain()
            .unsetMark(this.name, { extendEmptyMarkRange: true })
            .setMeta("preventAutolink", true)
            .run(),
    };
  },
  addPasteRules() {
    return [
      markPasteRule({
        find: URL_RE,
        type: this.type,
        getAttributes: (match) => ({ href: match[0] }),
      }),
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("linkClick"),
        props: {
          handleDOMEvents: {
            // contenteditable follows no link, so an editable document opens
            // one itself. A plain click still places the caret, which is what
            // the toolbar's link button needs to edit or unset the mark.
            click(view, event) {
              if (!view.editable || event.button !== 0) return false;
              if (!event.metaKey && !event.ctrlKey) return false;

              const anchor = (event.target as HTMLElement | null)?.closest?.("a");
              const href = anchor?.getAttribute("href");
              if (!href || !isSafeUrlValue(href)) return false;

              let target: URL;
              try {
                target = new URL(href, window.location.href);
              } catch {
                return false;
              }

              event.preventDefault();
              // Links render with `target="_blank"`, and a new tab keeps the
              // document being edited open either way.
              window.open(target.href, anchor?.target || "_blank", "noopener");
              return true;
            },
          },
        },
      }),
    ];
  },
});

// ---- Lists ----

const LIST_ITEM_TYPES: Record<string, string> = {
  bulletList: "listItem",
  orderedList: "listItem",
  taskList: "taskItem",
};

/** A list, and the span of its items a toggle applies to. */
type ItemSpan = { pos: number; node: PMNode; first: number; last: number };

/**
 * The innermost list around the selection, and which of its items the
 * selection covers. A caret is one item; a selection dragged over the whole
 * list is all of them.
 */
function selectedItems(state: EditorState): ItemSpan | null {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (!(node.type.name in LIST_ITEM_TYPES)) continue;
    const inSameList = $to.depth >= d && $to.node(d) === node;
    return {
      pos: $from.before(d),
      node,
      first: $from.index(d),
      // A selection running past the end of this list takes the rest of it.
      last: inSameList ? $to.index(d) : node.childCount - 1,
    };
  }
  return null;
}

/**
 * Whole lists the selection encloses, for a selection that starts outside any
 * of them — select-all above all, which resolves at the top of the document
 * and so has no list to walk up to.
 */
function enclosedLists(state: EditorState): ItemSpan[] {
  const { $from, $to } = state.selection;
  const depth = $from.sharedDepth($to.pos);
  const start = $from.start(depth);
  const spans: ItemSpan[] = [];
  $from.node(depth).forEach((child, offset) => {
    const pos = start + offset;
    const enclosed = pos >= $from.pos && pos + child.nodeSize <= $to.pos;
    if (enclosed && child.type.name in LIST_ITEM_TYPES) {
      spans.push({ pos, node: child, first: 0, last: child.childCount - 1 });
    }
  });
  return spans;
}

function totalSize(items: PMNode[]) {
  return items.reduce((size, item) => size + item.nodeSize, 0);
}

/**
 * Whether `pos` sits between two lists of `listType`, the only join worth
 * making. `canJoin` alone is not enough: it answers yes for any *empty*
 * neighbour, including the trailing paragraph the document editor keeps after
 * the last block, and the join then throws.
 */
function joinsTwoLists(tr: Transaction, pos: number, listType: NodeType) {
  const $pos = tr.doc.resolve(pos);
  return (
    $pos.nodeBefore?.type === listType &&
    $pos.nodeAfter?.type === listType &&
    canJoin(tr.doc, pos)
  );
}

/**
 * Rewrite `span`'s items as `itemType` under a `listType` list, splitting the
 * list around them, and join the result onto an adjacent list of the same type.
 *
 * It goes in one step because the intermediate states are invalid content (task
 * items under a bullet list and vice versa), which `setNodeMarkup` refuses.
 * Returns how far the items moved, or null when they cannot hold the item type.
 */
function convertItems(
  tr: Transaction,
  span: ItemSpan,
  listType: NodeType,
  itemType: NodeType,
) {
  const before: PMNode[] = [];
  const converted: PMNode[] = [];
  const after: PMNode[] = [];
  for (let i = 0; i < span.node.childCount; i++) {
    const item = span.node.child(i);
    if (i < span.first) before.push(item);
    else if (i > span.last) after.push(item);
    else if (!itemType.validContent(item.content)) return null;
    else converted.push(itemType.create(null, item.content, item.marks));
  }

  const lists = [listType.create(null, converted, span.node.marks)];
  if (before.length) lists.unshift(span.node.copy(Fragment.from(before)));
  if (after.length) {
    // The items that stay behind keep counting where the split left off.
    const attrs =
      typeof span.node.attrs.start === "number"
        ? { ...span.node.attrs, start: span.node.attrs.start + before.length }
        : span.node.attrs;
    lists.push(span.node.type.create(attrs, after, span.node.marks));
  }

  const start = span.pos + (before.length ? totalSize(before) + 2 : 0);
  const end = start + totalSize(converted) + 2;
  tr.replaceWith(span.pos, span.pos + span.node.nodeSize, lists);

  // Meeting a list of the same type — a sibling, or one made by an earlier
  // toggle — makes one list rather than two. The joins map the selection.
  if (joinsTwoLists(tr, end, listType)) tr.join(end);
  if (joinsTwoLists(tr, start, listType)) tr.join(start);

  // Item nodes keep their content, so the only shift is the wrapper opened for
  // the items left in front.
  return before.length ? 2 : 0;
}

/**
 * Toggle the selected list items to `listTypeName`: unwrap them when they are
 * already that type, otherwise convert them.
 */
function toggleListType(
  listTypeName: string,
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
) {
  const listType = state.schema.nodes[listTypeName];
  const itemType = state.schema.nodes[LIST_ITEM_TYPES[listTypeName]];
  const selected = selectedItems(state);

  if (selected) {
    if (selected.node.type === listType) return pmLiftListItem(itemType)(state, dispatch);
    const { tr } = state;
    const offset = convertItems(tr, selected, listType, itemType);
    if (offset === null) return false;
    if (dispatch) {
      const { anchor, head } = state.selection;
      dispatch(
        tr.setSelection(TextSelection.create(tr.doc, anchor + offset, head + offset)),
      );
    }
    return true;
  }

  // Back to front, so each span's positions still hold when it is its turn.
  const spans = enclosedLists(state).reverse();
  if (!spans.length) return pmWrapInList(listType)(state, dispatch);

  const { tr } = state;
  let changed = false;
  if (spans.every((span) => span.node.type === listType)) {
    for (const span of spans) {
      const blocks: PMNode[] = [];
      span.node.forEach((item) => {
        item.forEach((block) => {
          blocks.push(block);
        });
      });
      tr.replaceWith(span.pos, span.pos + span.node.nodeSize, blocks);
      changed = true;
    }
  } else {
    for (const span of spans) {
      if (span.node.type === listType) continue;
      if (convertItems(tr, span, listType, itemType) !== null) changed = true;
    }
  }
  if (!changed) return false;
  if (dispatch) dispatch(tr);
  return true;
}

export const BulletList = Node.create({
  name: "bulletList",
  addOptions() {
    return { HTMLAttributes: {}, itemTypeName: "listItem" };
  },
  ...nodeFromSpec("bulletList"),
  addCommands() {
    return {
      toggleBulletList:
        () =>
        ({ state, dispatch }) =>
          toggleListType("bulletList", state, dispatch),
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*([-+*])\s$/,
        type: this.type,
      }),
    ];
  },
});

export const OrderedList = Node.create({
  name: "orderedList",
  addOptions() {
    return { HTMLAttributes: {}, itemTypeName: "listItem" };
  },
  ...nodeFromSpec("orderedList"),
  addCommands() {
    return {
      toggleOrderedList:
        () =>
        ({ state, dispatch }) =>
          toggleListType("orderedList", state, dispatch),
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^(\d+)\.\s$/,
        type: this.type,
        getAttributes: (match) => ({ start: +match[1] }),
        joinPredicate: (match, node) => node.childCount + node.attrs.start === +match[1],
      }),
    ];
  },
});

export const ListItem = Node.create({
  name: "listItem",
  addOptions() {
    return {
      HTMLAttributes: {},
      bulletListTypeName: "bulletList",
      orderedListTypeName: "orderedList",
    };
  },
  ...nodeFromSpec("listItem"),
  addCommands() {
    return {
      liftListItem:
        (typeOrName: string | NodeType) =>
        ({ state, dispatch }) => {
          const type =
            typeof typeOrName === "string" ? state.schema.nodes[typeOrName] : typeOrName;
          if (!type) return false;
          return pmLiftListItem(type)(state, dispatch);
        },
      sinkListItem:
        (typeOrName: string | NodeType) =>
        ({ state, dispatch }) => {
          const type =
            typeof typeOrName === "string" ? state.schema.nodes[typeOrName] : typeOrName;
          if (!type) return false;
          return pmSinkListItem(type)(state, dispatch);
        },
      splitListItem:
        (typeOrName: string | NodeType) =>
        ({ state, dispatch }) => {
          const type =
            typeof typeOrName === "string" ? state.schema.nodes[typeOrName] : typeOrName;
          if (!type) return false;
          return pmSplitListItem(type)(state, dispatch);
        },
    };
  },
});

export const TaskList = Node.create({
  name: "taskList",
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("taskList"),
  addCommands() {
    return {
      toggleTaskList:
        () =>
        ({ state, dispatch }) =>
          toggleListType("taskList", state, dispatch),
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*\[ \]$/,
        type: this.type,
      }),
    ];
  },
});

export const TaskItem = Node.create({
  name: "taskItem",
  addOptions: htmlAttributeOptions,
  ...nodeFromSpec("taskItem"),
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const li = document.createElement("li");
      li.dataset.type = "taskItem";

      const label = document.createElement("label");
      label.contentEditable = "false";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!node.attrs.checked;

      label.appendChild(checkbox);

      const content = document.createElement("div");

      checkbox.addEventListener("change", (event) => {
        const { checked } = event.target as HTMLInputElement;
        if (editor.isEditable && typeof getPos === "function") {
          editor
            .chain()
            .command(({ tr }) => {
              tr.setNodeMarkup(getPos() as number, undefined, { checked });
              return true;
            })
            .run();
        }
      });

      li.dataset.checked = String(node.attrs.checked);
      li.append(label, content);

      return {
        dom: li,
        contentDOM: content,
        update(updatedNode) {
          if (updatedNode.type.name !== "taskItem") return false;
          li.dataset.checked = String(updatedNode.attrs.checked);
          checkbox.checked = !!updatedNode.attrs.checked;
          return true;
        },
      };
    };
  },
});
