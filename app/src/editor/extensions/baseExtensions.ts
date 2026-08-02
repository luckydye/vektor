import {
  Extension,
  getMarkAttributes,
  Mark,
  markPasteRule,
  Node,
  textblockTypeInputRule,
  wrappingInputRule,
} from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import {
  liftListItem as pmLiftListItem,
  sinkListItem as pmSinkListItem,
  splitListItem as pmSplitListItem,
  wrapInList as pmWrapInList,
} from "@tiptap/pm/schema-list";
import type { EditorState } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { HEADING_LEVELS, nodesWithAttr } from "#documents/schema/specs.ts";
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
    return {
      "Shift-Enter": () => this.editor.commands.setHardBreak(),
    };
  },
});

// ---- Marks ----

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
});

// ---- Lists ----

function findParentOfType(type: NodeType, state: EditorState) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === type) return { pos: $from.before(d), node: $from.node(d) };
  }
  return null;
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
        ({ state, dispatch, chain }) => {
          const { schema } = state;
          const inThis = findParentOfType(schema.nodes.bulletList, state);
          if (inThis) return pmLiftListItem(schema.nodes.listItem)(state, dispatch);
          const inOther = findParentOfType(schema.nodes.orderedList, state);
          if (inOther) {
            return chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(inOther.pos, schema.nodes.bulletList);
                return true;
              })
              .run();
          }
          return pmWrapInList(schema.nodes.bulletList)(state, dispatch);
        },
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
        ({ state, dispatch, chain }) => {
          const { schema } = state;
          const inThis = findParentOfType(schema.nodes.orderedList, state);
          if (inThis) return pmLiftListItem(schema.nodes.listItem)(state, dispatch);
          const inOther = findParentOfType(schema.nodes.bulletList, state);
          if (inOther) {
            return chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(inOther.pos, schema.nodes.orderedList);
                return true;
              })
              .run();
          }
          return pmWrapInList(schema.nodes.orderedList)(state, dispatch);
        },
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
        ({ state, dispatch }) => {
          const { schema } = state;
          const inThis = findParentOfType(schema.nodes.taskList, state);
          if (inThis) return pmLiftListItem(schema.nodes.taskItem)(state, dispatch);
          return pmWrapInList(schema.nodes.taskList)(state, dispatch);
        },
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
