/**
 * The document schema, declared once.
 *
 * Every node and mark the document format knows about is described here: how it
 * is recognised in HTML, which attributes it carries, what content it may hold,
 * and how it is written back out. Nothing in this module imports TipTap,
 * ProseMirror or a DOM — it is plain data plus small pure functions, so the
 * server can parse and serialize documents without loading the editor.
 *
 * Two consumers build on it:
 *
 *  - the server pipeline (`parse.ts`, `normalize.ts`, `render.ts`, `yEncode.ts`,
 *    `yDecode.ts`), which turns HTML into a `Y.XmlFragment` and back;
 *  - the editor extensions (`#editor/extensions/specSchema.ts`), whose
 *    `parseHTML` / `renderHTML` / `addAttributes` are generated from these
 *    entries so the two halves cannot drift.
 *
 * Extensions keep their behavioural halves — commands, input rules, plugins,
 * node views. Only the schema and serialization half lives here.
 */

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

export type Attrs = Record<string, unknown>;

export interface DocMark {
  type: string;
  attrs?: Attrs;
}

/**
 * A node of the document tree, in the same shape ProseMirror uses for JSON.
 * Keeping the shape identical is what lets TipTap act as a test oracle.
 */
export interface DocNode {
  type: string;
  attrs?: Attrs;
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
}

// ---------------------------------------------------------------------------
// Reading an element without committing to a DOM
// ---------------------------------------------------------------------------

/**
 * The slice of an element the schema needs to read while parsing. The server
 * implements it over `html5parser` tags, the editor over real `HTMLElement`s,
 * so a single `parse` function in this table serves both.
 */
export interface SpecElement {
  /** Lowercased tag name. */
  readonly tag: string;
  /** Attribute value, or null when absent. */
  attr(name: string): string | null;
  /** Inline style declaration, e.g. `style("margin-left")`. `""` when unset. */
  style(property: string): string;
  /** Text of the whole subtree, character references decoded. */
  text(): string;
  /** Element children, text nodes skipped. */
  children(): SpecElement[];
}

// ---------------------------------------------------------------------------
// Spec entries
// ---------------------------------------------------------------------------

/** HTML attributes an element renders with. `null` values are not written. */
export type HtmlAttrs = Record<string, string | number | null | undefined>;

export interface AttrSpec {
  /** Value when the attribute is absent. A thunk is resolved per document. */
  default: unknown | (() => unknown);
  /** Reads the value off a matched element. Defaults to `el.attr(name)`. */
  parse?: (el: SpecElement) => unknown;
  /** HTML attributes this value contributes. Defaults to `{ [name]: value }`. */
  render?: (value: unknown, attrs: Attrs) => HtmlAttrs;
  /** `false` keeps the attribute out of HTML entirely (carried in the model). */
  rendered?: boolean;
}

export interface Matcher {
  /** Lowercased tag name this rule applies to. */
  tag: string;
  /** Attributes that must be present, or must equal the given value. */
  has?: Record<string, string | true>;
  /** A selector-expressible negative constraint on one attribute. */
  without?: { attr: string; startsWith?: string; contains?: string };
  /** Everything the selector cannot express. */
  guard?: (el: SpecElement) => boolean;
  /** Attributes derived from the element itself (e.g. a heading's level). */
  attrs?: (el: SpecElement) => Attrs;
  /** Higher runs first. ProseMirror's parse-rule default is 50. */
  priority?: number;
}

/** An inline-style rule: any element styled this way carries the mark. */
export interface StyleMatcher {
  property: string;
  value: string;
}

/** The content placeholder inside a render tree — ProseMirror's `0`. */
export const CONTENT_HOLE = Symbol("content");

export type RenderChild = RenderTree | string | typeof CONTENT_HOLE;

export interface RenderTree {
  tag: string;
  attrs?: HtmlAttrs;
  children?: RenderChild[];
}

export interface RenderContext {
  /** The node's or mark's own attributes. */
  attrs: Attrs;
  /** Those attributes already rendered to HTML attributes, in order. */
  html: HtmlAttrs;
  /** The node itself, when the renderer needs its content (tables, cells). */
  node?: DocNode;
}

interface CommonSpec {
  name: string;
  attrs?: Record<string, AttrSpec>;
  match?: Matcher[];
  /** Inline styles that imply this mark, for pasted markup. Marks only. */
  styles?: StyleMatcher[];
  /** Defaults to wrapping the content in the first matcher's tag. */
  render?: (ctx: RenderContext) => RenderTree;
  /** `render` reads `ctx.node`, so the caller has to materialize the subtree. */
  needsNode?: boolean;
}

export interface NodeSpec extends CommonSpec {
  kind: "node";
  group?: string;
  /** ProseMirror content expression. Absent means "no content" (a leaf). */
  content?: string;
  /** `""` forbids all marks (code blocks). Absent allows every mark. */
  marks?: string;
  inline?: boolean;
  atom?: boolean;
  defining?: boolean;
  isolating?: boolean;
  draggable?: boolean;
  selectable?: boolean;
  code?: boolean;
  topNode?: boolean;
  /** Whitespace inside is verbatim and nested markup is ignored (`<pre>`). */
  verbatim?: boolean;
}

export interface MarkSpec extends CommonSpec {
  kind: "mark";
  /**
   * Which marks this one cannot coexist with, as a ProseMirror `excludes`
   * expression. Every mark here must exclude itself — see `assertSelfExcluding`.
   */
  excludes?: string;
  code?: boolean;
  keepOnSplit?: boolean;
}

export type Spec = NodeSpec | MarkSpec;

// ---------------------------------------------------------------------------
// Shared attribute builders
// ---------------------------------------------------------------------------

/** Left margin applied per indent level, in em. */
export const INDENT_STEP_EM = 2;
/** Maximum indent level a block can reach. */
export const MAX_INDENT = 10;
/** Heading levels the document format supports. */
export const HEADING_LEVELS = [1, 2, 3, 4];
/** Fallback column width for table cells, in px. */
export const DEFAULT_COL_WIDTH = 200;
/** Minimum column width used when a cell has none, in px. */
export const CELL_MIN_WIDTH = 25;

const indentAttr: AttrSpec = {
  default: 0,
  parse: (el) => {
    const marginLeft = Number.parseFloat(el.style("margin-left"));
    if (!marginLeft) return 0;
    return Math.min(Math.round(marginLeft / INDENT_STEP_EM), MAX_INDENT);
  },
  render: (value) =>
    value ? { style: `margin-left: ${Number(value) * INDENT_STEP_EM}em` } : {},
};

const textAlignAttr: AttrSpec = {
  default: "",
  parse: (el) => el.style("text-align") || "",
  render: (value) => (value ? { style: `text-align: ${value}` } : {}),
};

/** `width` / `height` / `display`, shared by the resizable media nodes. */
function resizableAttrs(): Record<string, AttrSpec> {
  return {
    width: {
      default: null,
      parse: (el) => el.attr("width") || el.style("width") || null,
      render: (value) =>
        value
          ? {
              width: value as string,
              style: `width: ${value}${typeof value === "number" ? "px" : ""}`,
            }
          : {},
    },
    height: {
      default: null,
      parse: (el) => el.attr("height") || el.style("height") || null,
      render: (value) => (value ? { height: value as string } : {}),
    },
    display: {
      default: null,
      parse: (el) => el.attr("data-display") || null,
      render: (value) =>
        value
          ? {
              "data-display": value as string,
              style: value === "full" ? "width: 100%" : "",
            }
          : {},
    },
  };
}

const colwidthAttr: AttrSpec = {
  default: [DEFAULT_COL_WIDTH],
  parse: (el) => {
    const colwidth = el.attr("colwidth");
    return colwidth
      ? colwidth.split(",").map((width) => Number.parseInt(width, 10))
      : [DEFAULT_COL_WIDTH];
  },
  render: (value) => {
    const widths = value as number[] | null;
    if (!widths) return { style: `width: ${DEFAULT_COL_WIDTH}px` };
    return { colwidth: widths.join(","), style: `width: ${widths[0]}px` };
  },
};

/** An attribute read from and written to a `data-` attribute under a new name. */
function dataAttr(attribute: string, fallback: unknown = null): AttrSpec {
  return {
    default: fallback,
    parse: (el) => el.attr(attribute) ?? fallback,
    render: (value) => ({ [attribute]: value as string }),
  };
}

/** An attribute carried in the model only, never written to HTML. */
function hiddenAttr(fallback: unknown): AttrSpec {
  return { default: fallback, parse: () => null, render: () => ({}), rendered: false };
}

function styleAttr(property: string): AttrSpec {
  return {
    default: null,
    parse: (el) => el.style(property) || null,
    render: (value) => (value ? { style: `${property}: ${value}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/** `<tag …>content</tag>` — the default for anything with a content hole. */
function wrap(tag: string): (ctx: RenderContext) => RenderTree {
  return (ctx) => ({ tag, attrs: ctx.html, children: [CONTENT_HOLE] });
}

/** `<tag …>` — the default for leaves and atoms. */
function leaf(tag: string): (ctx: RenderContext) => RenderTree {
  return (ctx) => ({ tag, attrs: ctx.html });
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0] as string;
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return value;
  }
}

/** Decodes an `html-block`'s payload, which is URI-encoded when written by us. */
function htmlBlockContent(el: SpecElement): string | null {
  const value = el.attr("data-html");
  if (value === null) return null;
  if (el.attr("data-html-encoding") !== "uri") return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The `<colgroup>` a table renders with, and the width it takes from its
 * cells. Ported from `@tiptap/extension-table`'s `createColGroup` so the markup
 * a document is stored as does not change when the table extension is no longer
 * on the serialization path.
 */
function tableColumns(node: DocNode | undefined): {
  colgroup: RenderTree;
  style: string;
} {
  const row = node?.content?.[0];
  let totalWidth = 0;
  let fixedWidth = true;
  const cols: RenderChild[] = [];

  for (const cell of row?.content ?? []) {
    const colspan = Number(cell.attrs?.colspan ?? 1) || 1;
    const colwidth = cell.attrs?.colwidth as number[] | null | undefined;
    for (let span = 0; span < colspan; span++) {
      const width = colwidth?.[span];
      totalWidth += width || CELL_MIN_WIDTH;
      if (!width) fixedWidth = false;
      cols.push({
        tag: "col",
        attrs: {
          style: width
            ? `width: ${Math.max(width, CELL_MIN_WIDTH)}px`
            : `min-width: ${CELL_MIN_WIDTH}px`,
        },
      });
    }
  }

  return {
    colgroup: { tag: "colgroup", children: cols },
    style: fixedWidth ? `width: ${totalWidth}px` : `min-width: ${totalWidth}px`,
  };
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/**
 * Marks come first, and in this order, because that is the order ProseMirror's
 * `DOMParser` tries rules in and the order `Mark.addToSet` keeps a mark set in
 * — which decides both which rule wins for an ambiguous element (a `<span>`
 * that is both styled and a comment anchor) and how nested mark elements are
 * written back out.
 */
const MARKS: MarkSpec[] = [
  {
    kind: "mark",
    name: "link",
    keepOnSplit: false,
    attrs: {
      href: { default: null },
      target: { default: "_blank" },
      rel: { default: "noopener noreferrer nofollow" },
    },
    match: [
      {
        tag: "a",
        has: { href: true },
        without: { attr: "href", contains: "javascript:" },
      },
    ],
    render: (ctx) => ({
      tag: "a",
      // The configured target/rel lead, so a link that carries its own keeps
      // the attribute order documents are already stored with.
      attrs: { target: "_blank", rel: "noopener noreferrer nofollow", ...ctx.html },
      children: [CONTENT_HOLE],
    }),
  },
  {
    kind: "mark",
    name: "ticketLink",
    attrs: {
      ticketId: dataAttr("data-ticket-id"),
      connectionLabel: {
        default: null,
        parse: (el) => el.attr("data-connection-id"),
        render: (value) => ({ "data-connection-label": value as string }),
      },
      connectionUrl: {
        default: null,
        parse: (el) => el.attr("data-connection-id"),
        render: (value) => ({ "data-connection-url": value as string }),
      },
      connectionId: dataAttr("data-connection-id"),
    },
    match: [{ tag: "ticket-link" }],
  },
  {
    kind: "mark",
    name: "bold",
    match: [
      { tag: "strong" },
      { tag: "b", guard: (el) => el.style("font-weight") !== "normal" },
    ],
    styles: [
      { property: "font-weight", value: "bold" },
      { property: "font-weight", value: "bolder" },
    ],
    render: wrap("strong"),
  },
  {
    kind: "mark",
    name: "italic",
    match: [
      { tag: "em" },
      { tag: "i", guard: (el) => el.style("font-style") !== "normal" },
    ],
    styles: [{ property: "font-style", value: "italic" }],
    render: wrap("em"),
  },
  {
    kind: "mark",
    name: "strike",
    match: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    styles: [{ property: "text-decoration", value: "line-through" }],
    render: wrap("s"),
  },
  {
    kind: "mark",
    name: "underline",
    match: [{ tag: "u" }],
    styles: [{ property: "text-decoration", value: "underline" }],
  },
  {
    kind: "mark",
    name: "superscript",
    // Both halves of the pair name themselves as well as their opposite. A mark
    // that does not exclude itself is an "overlapping" mark to y-prosemirror,
    // which then keys it as `name--<hash>` in the Y.XmlText attributes instead
    // of by its bare name — see `assertSelfExcluding`.
    excludes: "superscript subscript",
    match: [{ tag: "sup" }],
    styles: [{ property: "vertical-align", value: "super" }],
  },
  {
    kind: "mark",
    name: "subscript",
    excludes: "subscript superscript",
    match: [{ tag: "sub" }],
    styles: [{ property: "vertical-align", value: "sub" }],
  },
  {
    kind: "mark",
    name: "textStyle",
    attrs: {
      backgroundColor: styleAttr("background-color"),
      color: styleAttr("color"),
    },
    match: [{ tag: "span", has: { style: true } }],
  },
  {
    kind: "mark",
    name: "code",
    excludes: "_",
    code: true,
    match: [{ tag: "code" }],
  },
  {
    kind: "mark",
    name: "commentAnchor",
    attrs: { commentId: dataAttr("data-comment-id") },
    match: [{ tag: "span", has: { "data-comment-id": true } }],
    render: (ctx) => ({
      tag: "span",
      attrs: { ...ctx.html, class: "comment-anchor" },
      children: [CONTENT_HOLE],
    }),
  },
];

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const NODES: NodeSpec[] = [
  { kind: "node", name: "doc", topNode: true, content: "block+" },
  { kind: "node", name: "text", group: "inline" },
  {
    kind: "node",
    name: "paragraph",
    group: "block",
    content: "inline*",
    attrs: { indent: indentAttr, textAlign: textAlignAttr },
    match: [{ tag: "p" }],
  },
  {
    kind: "node",
    name: "heading",
    group: "block",
    content: "inline*",
    defining: true,
    attrs: { indent: indentAttr, textAlign: textAlignAttr, level: hiddenAttr(1) },
    match: HEADING_LEVELS.map((level) => ({
      tag: `h${level}`,
      attrs: () => ({ level }),
    })),
    render: (ctx) => {
      const level = Number(ctx.attrs.level);
      const resolved = HEADING_LEVELS.includes(level) ? level : HEADING_LEVELS[0];
      return { tag: `h${resolved}`, attrs: ctx.html, children: [CONTENT_HOLE] };
    },
  },
  {
    kind: "node",
    name: "hardBreak",
    group: "inline",
    inline: true,
    selectable: false,
    match: [{ tag: "br" }],
  },
  {
    kind: "node",
    name: "codeBlock",
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    verbatim: true,
    attrs: {
      language: {
        default: null,
        rendered: false,
        parse: (el) => {
          const classes = el.children()[0]?.attr("class")?.split(/\s+/) ?? [];
          const language = classes.find((name) => name.startsWith("language-"));
          return language ? language.slice("language-".length) : null;
        },
      },
    },
    match: [{ tag: "pre" }],
    render: (ctx) => ({
      tag: "pre",
      attrs: ctx.html,
      children: [
        {
          tag: "code",
          attrs: ctx.attrs.language ? { class: `language-${ctx.attrs.language}` } : {},
          children: [CONTENT_HOLE],
        },
      ],
    }),
  },
  {
    kind: "node",
    name: "blockquote",
    group: "block",
    content: "block+",
    defining: true,
    match: [{ tag: "blockquote" }],
  },
  {
    kind: "node",
    name: "horizontalRule",
    group: "block",
    match: [{ tag: "hr" }],
  },
  {
    kind: "node",
    name: "bulletList",
    group: "block list",
    content: "listItem+",
    match: [{ tag: "ul" }],
  },
  {
    kind: "node",
    name: "orderedList",
    group: "block list",
    content: "listItem+",
    attrs: {
      start: {
        default: 1,
        parse: (el) => {
          const start = el.attr("start");
          return start ? Number.parseInt(start, 10) : 1;
        },
      },
    },
    match: [{ tag: "ol" }],
  },
  {
    kind: "node",
    name: "listItem",
    content: "paragraph block*",
    defining: true,
    match: [{ tag: "li" }],
  },
  {
    kind: "node",
    name: "taskList",
    group: "block list",
    content: "taskItem+",
    match: [{ tag: "ul", has: { "data-type": "taskList" }, priority: 51 }],
    render: (ctx) => ({
      tag: "ul",
      attrs: { "data-type": "taskList", ...ctx.html },
      children: [CONTENT_HOLE],
    }),
  },
  {
    kind: "node",
    name: "taskItem",
    content: "paragraph (taskList | block)*",
    defining: true,
    attrs: {
      checked: {
        default: false,
        parse: (el) => el.attr("data-checked") === "true",
        render: (value) => ({ "data-checked": String(value) }),
      },
    },
    match: [{ tag: "li", has: { "data-type": "taskItem" }, priority: 51 }],
    render: (ctx) => ({
      tag: "li",
      attrs: { "data-type": "taskItem", ...ctx.html },
      children: [
        {
          tag: "label",
          attrs: { contenteditable: "false" },
          children: [
            {
              tag: "input",
              attrs: { type: "checkbox", ...(ctx.attrs.checked ? { checked: "" } : {}) },
            },
          ],
        },
        { tag: "div", children: [CONTENT_HOLE] },
      ],
    }),
  },
  {
    kind: "node",
    name: "table",
    group: "block",
    content: "tableRow+",
    isolating: true,
    match: [{ tag: "table" }],
    needsNode: true,
    render: (ctx) => {
      const { colgroup, style } = tableColumns(ctx.node);
      return {
        tag: "table",
        attrs: { ...ctx.html, style },
        children: [colgroup, { tag: "tbody", children: [CONTENT_HOLE] }],
      };
    },
  },
  {
    kind: "node",
    name: "tableRow",
    content: "(tableCell | tableHeader)*",
    match: [{ tag: "tr" }],
  },
  {
    kind: "node",
    name: "tableHeader",
    content: "block+",
    isolating: true,
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: colwidthAttr,
    },
    match: [{ tag: "th" }],
  },
  {
    kind: "node",
    name: "tableCell",
    content: "block+",
    isolating: true,
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: colwidthAttr,
      backgroundColor: styleAttr("background-color"),
    },
    match: [{ tag: "td" }],
  },
  {
    kind: "node",
    name: "expressionCell",
    group: "inline",
    inline: true,
    content: "text*",
    attrs: {
      "data-formula": {
        default: "=",
        parse: (el) => el.attr("data-formula") || el.text().trim() || "=",
      },
    },
    match: [{ tag: "expression-cell" }],
    needsNode: true,
    render: (ctx) => {
      const formula = ctx.attrs["data-formula"] || textOf(ctx.node);
      return {
        tag: "expression-cell",
        attrs: { ...ctx.html, ...(formula ? { "data-formula": formula as string } : {}) },
        children: [CONTENT_HOLE],
      };
    },
  },
  {
    kind: "node",
    name: "image",
    group: "block",
    draggable: true,
    attrs: {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      ...resizableAttrs(),
    },
    // `data:` sources are deliberately not parsed: an inlined image would be
    // copied into every collaborator's document and every stored revision.
    match: [
      { tag: "img", has: { src: true }, without: { attr: "src", startsWith: "data:" } },
    ],
  },
  {
    kind: "node",
    name: "video",
    group: "block",
    atom: true,
    attrs: { src: { default: null }, ...resizableAttrs() },
    match: [{ tag: "video", has: { src: true } }],
    render: (ctx) => ({ tag: "video", attrs: { controls: "", ...ctx.html } }),
  },
  {
    kind: "node",
    name: "fileAttachment",
    group: "block",
    atom: true,
    attrs: { src: { default: null }, filename: { default: "file" } },
    match: [{ tag: "file-attachment" }],
  },
  {
    kind: "node",
    name: "figmaEmbed",
    group: "block",
    atom: true,
    draggable: true,
    attrs: { url: dataAttr("data-figma-url"), ...resizableAttrs() },
    match: [{ tag: "figma-embed", has: { "data-figma-url": true } }],
    render: (ctx) => ({
      tag: "figma-embed",
      attrs: ctx.html,
      children: [String(ctx.attrs.url ?? "")],
    }),
  },
  {
    kind: "node",
    name: "extensionView",
    group: "block",
    atom: true,
    draggable: true,
    attrs: {
      extensionId: dataAttr("data-extension-id"),
      routePath: dataAttr("data-route-path"),
    },
    match: [{ tag: "extension-view-block", has: { "data-extension-id": true } }],
  },
  {
    kind: "node",
    name: "columnLayout",
    group: "block",
    content: "columnItem+",
    isolating: true,
    draggable: true,
    attrs: {
      columns: {
        default: 2,
        parse: (el) => Number.parseInt(el.attr("data-columns") || "2", 10),
        render: (value) => ({ "data-columns": value as number }),
      },
    },
    match: [{ tag: "div", has: { "data-type": "column-layout" } }],
    render: (ctx) => ({
      tag: "div",
      attrs: { ...ctx.html, "data-type": "column-layout" },
      children: [CONTENT_HOLE],
    }),
  },
  {
    kind: "node",
    name: "columnItem",
    content: "block+",
    isolating: true,
    match: [{ tag: "div", has: { "data-type": "column-item" } }],
    render: (ctx) => ({
      tag: "div",
      attrs: { ...ctx.html, "data-type": "column-item" },
      children: [CONTENT_HOLE],
    }),
  },
  {
    kind: "node",
    name: "htmlBlock",
    group: "block",
    atom: true,
    selectable: false,
    draggable: true,
    attrs: {
      "data-html": {
        default: "<p>Enter HTML content here</p>",
        parse: htmlBlockContent,
      },
    },
    // The catch-all that captures markup the schema has no node for is not a
    // matcher — it needs the element's ancestors. See `HTML_BLOCK_TAGS`.
    match: [{ tag: "html-block" }],
    render: (ctx) => ({
      tag: "html-block",
      attrs: {
        ...ctx.html,
        "data-html": encodeURIComponent(String(ctx.attrs["data-html"] ?? "")),
        "data-html-encoding": "uri",
      },
    }),
  },
  {
    kind: "node",
    name: "datePicker",
    group: "inline",
    inline: true,
    atom: true,
    attrs: {
      "data-date": {
        default: todayIso,
        parse: (el) => el.attr("data-date") || todayIso(),
      },
    },
    match: [{ tag: "date-picker" }],
    render: (ctx) => {
      const date = String(ctx.attrs["data-date"] ?? todayIso());
      return {
        tag: "date-picker",
        attrs: ctx.html,
        children: [formatDate(date)],
      };
    },
  },
  {
    kind: "node",
    name: "documentMention",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    attrs: {
      documentId: dataAttr("data-document-id", ""),
      label: {
        default: "",
        parse: (el) => el.text().replace(/^@/, ""),
        render: () => ({}),
      },
      href: dataAttr("data-href", ""),
    },
    match: [{ tag: "document-mention" }],
    render: (ctx) => ({
      tag: "document-mention",
      attrs: { ...ctx.html, contenteditable: "false" },
      children: [`@${ctx.attrs.label || ctx.attrs.documentId}`],
    }),
  },
  {
    kind: "node",
    name: "mention",
    group: "inline",
    inline: true,
    atom: true,
    selectable: false,
    // Both values come from the matcher below; opting the per-attribute lookup
    // out keeps a stray `id`/`label` attribute from overriding what it resolved.
    attrs: { id: hiddenAttr(null), label: hiddenAttr(null) },
    match: [
      {
        tag: "user-mention",
        attrs: (el) => {
          const email = el.attr("email");
          return { id: email, label: el.text().replace("@", "") || email };
        },
      },
    ],
    render: (ctx) => ({
      tag: "user-mention",
      attrs: { email: ctx.attrs.id as string },
      children: [`@${ctx.attrs.label || ctx.attrs.id}`],
    }),
  },
];

/** The concatenated text of a node's subtree. */
export function textOf(node: DocNode | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(textOf).join("");
}

// ---------------------------------------------------------------------------
// The catch-all for markup the schema has no node for
// ---------------------------------------------------------------------------

/**
 * Elements with no node of their own. Without an explicit fallback their tag
 * and attributes are dropped and only their text survives, so the complete
 * source is kept verbatim in an `htmlBlock` atom instead. Any custom element
 * (a tag containing `-`) that no spec claims is treated the same way.
 */
export const HTML_BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "audio",
  "canvas",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "hgroup",
  "iframe",
  "main",
  "menu",
  "nav",
  "noscript",
  "object",
  "output",
  "picture",
  "section",
  "svg",
  "template",
  "video",
]);

/**
 * Content-holding elements the schema understands. An unsupported element below
 * one of these is nested content, not a root-level block — hoisting it into its
 * own HTML block would swallow the node it belongs to (a task item's
 * `<div><p>…</p></div>` content wrapper, say, since `div` is unsupported).
 */
export const CONTENT_CONTAINER_TAGS = new Set([
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

/** Elements whose contents are never document content. */
export const IGNORED_TAGS = new Set([
  "head",
  "noscript",
  "object",
  "script",
  "style",
  "title",
]);

export function isHtmlBlockTag(tag: string): boolean {
  return HTML_BLOCK_TAGS.has(tag) || tag.includes("-");
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

export const SPECS: Spec[] = [...MARKS, ...NODES];

const byName = new Map<string, Spec>(SPECS.map((spec) => [spec.name, spec]));

export function specFor(name: string): Spec | undefined {
  return byName.get(name);
}

export function nodeSpec(name: string): NodeSpec | undefined {
  const spec = byName.get(name);
  return spec?.kind === "node" ? spec : undefined;
}

export function markSpec(name: string): MarkSpec | undefined {
  const spec = byName.get(name);
  return spec?.kind === "mark" ? spec : undefined;
}

/** Every spec that names `group` in its `group` field, e.g. `block`, `inline`. */
const groups = new Map<string, string[]>();
for (const spec of SPECS) {
  if (spec.kind !== "node" || !spec.group) continue;
  for (const group of spec.group.split(/\s+/)) {
    const members = groups.get(group) ?? [];
    members.push(spec.name);
    groups.set(group, members);
  }
}

export function groupMembers(name: string): string[] {
  return groups.get(name) ?? [];
}

/**
 * Node types carrying a given attribute — how the extensions that command an
 * attribute shared by several nodes (`textAlign`, `indent`) learn which nodes
 * those are, without restating the list.
 */
export function nodesWithAttr(attr: string): string[] {
  return SPECS.filter((spec) => spec.kind === "node" && spec.attrs?.[attr]).map(
    (spec) => spec.name,
  );
}

/** Rank of a mark in `MARKS`, which is the order a mark set is kept in. */
const markRanks = new Map(MARKS.map((mark, index) => [mark.name, index]));

export function markRank(name: string): number {
  return markRanks.get(name) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Every matcher across the table, most specific first: rule priority descending,
 * marks before nodes at equal priority, declaration order within that. This is
 * the order ProseMirror's `DOMParser` resolves rules in, and reproducing it is
 * what makes `ul[data-type="taskList"]` win over plain `ul`, and a styled
 * `<span>` read as a text style rather than a comment anchor.
 */
export interface ResolvedMatcher {
  spec: Spec;
  matcher: Matcher;
}

export const MATCHERS: ResolvedMatcher[] = SPECS.flatMap((spec) =>
  (spec.match ?? []).map((matcher) => ({ spec, matcher })),
).sort((a, b) => (b.matcher.priority ?? 50) - (a.matcher.priority ?? 50));

/** Marks implied by an element's inline style rather than by its tag. */
export const STYLE_MATCHERS: { spec: MarkSpec; style: StyleMatcher }[] = MARKS.flatMap(
  (spec) => (spec.styles ?? []).map((style) => ({ spec, style })),
);

// ---------------------------------------------------------------------------
// Helpers over the table
// ---------------------------------------------------------------------------

export function attrDefault(attr: AttrSpec): unknown {
  return typeof attr.default === "function"
    ? (attr.default as () => unknown)()
    : attr.default;
}

/** The full attribute set of a node or mark, defaults filled in. */
export function defaultAttrs(spec: Spec): Attrs {
  const attrs: Attrs = {};
  for (const [name, attr] of Object.entries(spec.attrs ?? {})) {
    attrs[name] = attrDefault(attr);
  }
  return attrs;
}

/** Does `matcher` accept this element? */
export function matches(matcher: Matcher, el: SpecElement): boolean {
  if (matcher.tag !== el.tag) return false;
  for (const [name, value] of Object.entries(matcher.has ?? {})) {
    const actual = el.attr(name);
    if (actual === null) return false;
    if (value !== true && actual !== value) return false;
  }
  const without = matcher.without;
  if (without) {
    const actual = el.attr(without.attr) ?? "";
    if (without.startsWith && actual.startsWith(without.startsWith)) return false;
    if (without.contains && actual.includes(without.contains)) return false;
  }
  return matcher.guard ? matcher.guard(el) : true;
}

/** The CSS selector a matcher stands for, for ProseMirror parse rules. */
export function selectorFor(matcher: Matcher): string {
  let selector = matcher.tag;
  for (const [name, value] of Object.entries(matcher.has ?? {})) {
    selector += value === true ? `[${name}]` : `[${name}="${value}"]`;
  }
  const without = matcher.without;
  if (without?.startsWith) selector += `:not([${without.attr}^="${without.startsWith}"])`;
  if (without?.contains) selector += `:not([${without.attr}*="${without.contains}"])`;
  return selector;
}

/**
 * Every mark must exclude itself.
 *
 * y-prosemirror keys a mark in a `Y.XmlText`'s attributes by its bare name only
 * when the mark excludes itself; an overlapping mark is keyed
 * `name--<hash8>` instead. The encoder here writes bare names, so a mark that
 * stopped self-excluding would silently produce Y state the editor's sync
 * plugin reads back as a different mark. Fail loudly at import time instead.
 */
function assertSelfExcluding(): void {
  for (const mark of MARKS) {
    const excludes = mark.excludes;
    const selfExcluding =
      excludes === undefined ||
      excludes === "_" ||
      excludes.split(/\s+/).includes(mark.name);
    if (!selfExcluding) {
      throw new Error(
        `mark "${mark.name}" does not exclude itself: excludes="${excludes}". ` +
          "Overlapping marks need hashed Y attribute keys, which yEncode.ts does not write.",
      );
    }
  }
}

assertSelfExcluding();

/** Marks `mark` cannot coexist with, resolved through groups and `_`. */
export function excludedMarks(name: string): Set<string> {
  const spec = markSpec(name);
  if (!spec) return new Set();
  if (spec.excludes === undefined) return new Set([name]);
  if (spec.excludes === "_") return new Set(MARKS.map((mark) => mark.name));
  return new Set(spec.excludes.split(/\s+/).filter(Boolean));
}

/**
 * Adds a mark to a set the way ProseMirror does: a mark excluded by one already
 * present is dropped, and marks it excludes are removed. The result stays
 * sorted by `markRank`, which is the order marks are written back out in.
 */
export function addMark(marks: DocMark[], mark: DocMark): DocMark[] {
  for (const existing of marks) {
    if (existing.type === mark.type) return marks;
    if (excludedMarks(existing.type).has(mark.type)) return marks;
  }
  const excluded = excludedMarks(mark.type);
  const next = marks.filter((existing) => !excluded.has(existing.type));
  next.push(mark);
  return next.sort((a, b) => markRank(a.type) - markRank(b.type));
}
