import {
  Extension,
  getMarkAttributes,
  Mark,
  markPasteRule,
  mergeAttributes,
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

// ---- Nodes ----

export const Document = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
});

export const Text = Node.create({
  name: "text",
  group: "inline",
});

export const Paragraph = Node.create({
  name: "paragraph",
  priority: 1000,
  addOptions() {
    return { HTMLAttributes: {} };
  },
  group: "block",
  content: "inline*",
  parseHTML() {
    return [{ tag: "p" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["p", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  inline: true,
  group: "inline",
  selectable: false,
  addOptions() {
    return { HTMLAttributes: {} };
  },
  parseHTML() {
    return [{ tag: "br" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["br", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  parseHTML() {
    return [
      { tag: "strong" },
      {
        tag: "b",
        getAttrs: (node) => (node as HTMLElement).style.fontWeight !== "normal" && null,
      },
      { style: "font-weight=bold" },
      { style: "font-weight=bolder" },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["strong", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
});

export const Italic = Mark.create({
  name: "italic",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  parseHTML() {
    return [
      { tag: "em" },
      {
        tag: "i",
        getAttrs: (node) => (node as HTMLElement).style.fontStyle !== "normal" && null,
      },
      { style: "font-style=italic" },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["em", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
});

export const Strike = Mark.create({
  name: "strike",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  parseHTML() {
    return [
      { tag: "s" },
      { tag: "del" },
      { tag: "strike" },
      { style: "text-decoration=line-through" },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["s", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  parseHTML() {
    return [{ tag: "u" }, { style: "text-decoration=underline" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["u", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
});

export const Code = Mark.create({
  name: "code",
  addOptions() {
    return { HTMLAttributes: {} };
  },
  excludes: "_",
  code: true,
  exitable: true,
  parseHTML() {
    return [{ tag: "code" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["code", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  excludes: "superscript",
  parseHTML() {
    return [{ tag: "sub" }, { style: "vertical-align=sub" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  excludes: "subscript",
  parseHTML() {
    return [{ tag: "sup" }, { style: "vertical-align=super" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  parseHTML() {
    return [
      {
        tag: "span",
        getAttrs: (node) => {
          const hasStyle = (node as HTMLElement).hasAttribute("style");
          return hasStyle ? {} : false;
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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

export const Color = Extension.create({
  name: "color",
  addOptions() {
    return { types: ["textStyle"] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (element) => element.style.color?.replace(/['"]+/g, "") || null,
            renderHTML: (attributes) => {
              if (!attributes.color) return {};
              return { style: `color: ${attributes.color}` };
            },
          },
        },
      },
    ];
  },
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
  addOptions() {
    return { types: ["textStyle"] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          backgroundColor: {
            default: null,
            parseHTML: (element) =>
              element.style.backgroundColor?.replace(/['"]+/g, "") || null,
            renderHTML: (attributes) => {
              if (!attributes.backgroundColor) return {};
              return { style: `background-color: ${attributes.backgroundColor}` };
            },
          },
        },
      },
    ];
  },
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
    return {
      levels: [1, 2, 3, 4, 5, 6] as number[],
      HTMLAttributes: {},
    };
  },
  content: "inline*",
  group: "block",
  defining: true,
  addAttributes() {
    return {
      level: { default: 1, rendered: false },
    };
  },
  parseHTML() {
    return this.options.levels.map((level: number) => ({
      tag: `h${level}`,
      attrs: { level },
    }));
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = this.options.levels.includes(node.attrs.level)
      ? node.attrs.level
      : this.options.levels[0];
    return [`h${level}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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

export const TextAlign = Extension.create({
  name: "textAlign",
  addOptions() {
    return {
      types: [] as string[],
      alignments: ["left", "center", "right", "justify"],
      defaultAlignment: "",
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          textAlign: {
            default: this.options.defaultAlignment,
            parseHTML: (element) =>
              element.style.textAlign || this.options.defaultAlignment,
            renderHTML: (attributes) => {
              if (attributes.textAlign === this.options.defaultAlignment) return {};
              return { style: `text-align: ${attributes.textAlign}` };
            },
          },
        },
      },
    ];
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
  addOptions() {
    return {
      languageClassPrefix: "language-",
      HTMLAttributes: {},
    };
  },
  content: "text*",
  marks: "",
  group: "block",
  code: true,
  defining: true,
  addAttributes() {
    return {
      language: {
        default: null,
        parseHTML: (element) => {
          const { languageClassPrefix } = this.options;
          const classes = [
            ...((element.firstElementChild as HTMLElement)?.classList ?? []),
          ];
          const lang = classes
            .filter((c) => c.startsWith(languageClassPrefix))
            .map((c) => c.slice(languageClassPrefix.length))[0];
          return lang ?? null;
        },
        rendered: false,
      },
    };
  },
  parseHTML() {
    return [{ tag: "pre", preserveWhitespace: "full" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "pre",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      [
        "code",
        node.attrs.language
          ? { class: `${this.options.languageClassPrefix}${node.attrs.language}` }
          : {},
        0,
      ],
    ];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  content: "block+",
  group: "block",
  defining: true,
  parseHTML() {
    return [{ tag: "blockquote" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "blockquote",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      0,
    ];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  group: "block",
  parseHTML() {
    return [{ tag: "hr" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["hr", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },
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
  keepOnSplit: false,
  addOptions() {
    return {
      HTMLAttributes: {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      },
    };
  },
  addAttributes() {
    return {
      href: { default: null },
      target: { default: this.options.HTMLAttributes.target },
      rel: { default: this.options.HTMLAttributes.rel },
    };
  },
  parseHTML() {
    return [{ tag: 'a[href]:not([href*="javascript:"])' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["a", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  group: "block list",
  content: "listItem+",
  parseHTML() {
    return [{ tag: "ul" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["ul", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  group: "block list",
  content: "listItem+",
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element) => {
          const start = element.getAttribute("start");
          return start ? parseInt(start, 10) : 1;
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "ol" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const { start } = node.attrs;
    return [
      "ol",
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        start !== 1 ? { start } : {},
      ),
      0,
    ];
  },
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
  content: "paragraph block*",
  defining: true,
  parseHTML() {
    return [{ tag: "li" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["li", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
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
  addOptions() {
    return { HTMLAttributes: {} };
  },
  group: "block list",
  content: "taskItem+",
  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]', priority: 51 }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "ul",
      mergeAttributes(
        { "data-type": "taskList" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      0,
    ];
  },
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
  addOptions() {
    return {
      nested: false,
      HTMLAttributes: {},
    };
  },
  content() {
    return this.options.nested ? "paragraph (taskList | block)*" : "paragraph block*";
  },
  defining: true,
  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => element.getAttribute("data-checked") === "true",
        renderHTML: (attributes) => ({ "data-checked": String(attributes.checked) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]', priority: 51 }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "li",
      mergeAttributes(
        { "data-type": "taskItem" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      [
        "label",
        { contenteditable: "false" },
        ["input", { type: "checkbox", ...(node.attrs.checked ? { checked: "" } : {}) }],
      ],
      ["div", 0],
    ];
  },
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
