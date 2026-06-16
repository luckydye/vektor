import { Extension, Mark, Node, getMarkAttributes, mergeAttributes } from "@tiptap/core";

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
                const currentMarks = storedMarks ?? ($from.parentOffset ? $from.marks() : []);
                tr.replaceSelectionWith(this.type.create(null, null, currentMarks));
                tr.scrollIntoView();
                dispatch(tr);
              }
              return true;
            })
            .run(),
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
            parseHTML: (element) => element.style.backgroundColor?.replace(/['"]+/g, "") || null,
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
          chain().setMark("textStyle", { backgroundColor: null }).removeEmptyTextStyle().run(),
    };
  },
});
