import {
  decodeHtmlEntities,
  type HtmlNode,
  type HtmlTagNode,
  parseHtml,
  reconstructNode,
  SyntaxKind,
} from "#utils/html.ts";
import { TagElement } from "./element.ts";
import { normalizeDocument } from "./normalize.ts";
import {
  type AttrSpec,
  type Attrs,
  addMark,
  attrDefault,
  CONTENT_CONTAINER_TAGS,
  type DocMark,
  type DocNode,
  IGNORED_TAGS,
  isHtmlBlockTag,
  MATCHERS,
  type Matcher,
  matches,
  type NodeSpec,
  nodeSpec,
  type SpecElement,
  STYLE_MATCHERS,
} from "./specs.ts";

/**
 * HTML → document tree.
 *
 * This is the half of the pipeline ProseMirror's `DOMParser` used to do, minus
 * the DOM. It walks the `html5parser` tree, matches each element against the
 * spec table, and hands the result to `normalizeDocument`, which is what
 * enforces the content model — nothing here worries about whether a child is
 * allowed where it landed.
 */

interface ParseContext {
  /** Marks inherited from enclosing mark elements, ordered by mark rank. */
  marks: DocMark[];
  /**
   * An ancestor is a content container, so an element the schema has no node
   * for is nested content rather than a root-level block to capture verbatim.
   */
  contained: boolean;
  /** The enclosing node takes inline content, so whitespace is significant. */
  inline: boolean;
}

/** Parses document HTML into a normalized document tree. */
export function htmlToDoc(html: string): DocNode {
  const content: DocNode[] = [];
  parseInto(content, parseHtml(html), { marks: [], contained: false, inline: false });
  return normalizeDocument({ type: "doc", content });
}

/**
 * The document a source file is: one code block holding the whole text. Both
 * the code editor and the workflow-source (de)serializer build it, so the shape
 * is defined once.
 */
export function codeToDoc(code: string, language: string): DocNode {
  return {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language },
        ...(code ? { content: [{ type: "text", text: code }] } : {}),
      },
    ],
  };
}

function parseInto(out: DocNode[], nodes: HtmlNode[], ctx: ParseContext): void {
  for (const node of nodes) {
    if (node.type === SyntaxKind.Text) appendText(out, node.value, ctx);
    else if (node.type === SyntaxKind.Tag) parseTag(out, node, ctx);
  }
}

function parseTag(out: DocNode[], tag: HtmlTagNode, ctx: ParseContext): void {
  const name = tag.name.toLowerCase();
  // `!--` / `!doctype`: comments and declarations are not content.
  if (name.startsWith("!")) return;

  const el = new TagElement(tag);
  for (const { spec, matcher } of MATCHERS) {
    if (!matches(matcher, el)) continue;
    if (spec.kind === "mark") {
      const attrs = readAttrs(spec.attrs, matcher, el);
      parseInto(out, tag.body ?? [], {
        ...ctx,
        marks: addMark(ctx.marks, { type: spec.name, ...attrs }),
        contained: ctx.contained || isContainer(el),
      });
    } else {
      out.push(buildNode(spec, matcher, el, tag, ctx));
    }
    return;
  }

  // Nothing in the schema claims this element.
  if (isHtmlBlockTag(name) && !ctx.contained) {
    out.push({ type: "htmlBlock", attrs: { "data-html": reconstructNode(tag) } });
    return;
  }
  if (IGNORED_TAGS.has(name)) return;

  // Descend: the element itself is dropped, its content is not. Inline styles
  // that stand for a mark still apply, which is how pasted markup keeps its
  // bold and italics when it arrives without a `<strong>`.
  let marks = ctx.marks;
  for (const { spec, style } of STYLE_MATCHERS) {
    if (el.style(style.property) === style.value) {
      marks = addMark(marks, { type: spec.name });
    }
  }
  parseInto(out, tag.body ?? [], {
    ...ctx,
    marks,
    contained: ctx.contained || isContainer(el),
  });
}

function isContainer(el: SpecElement): boolean {
  return CONTENT_CONTAINER_TAGS.has(el.tag) || el.attr("data-type") !== null;
}

function buildNode(
  spec: NodeSpec,
  matcher: Matcher,
  el: SpecElement,
  tag: HtmlTagNode,
  ctx: ParseContext,
): DocNode {
  const node: DocNode = { type: spec.name, ...readAttrs(spec.attrs, matcher, el) };

  if (spec.verbatim) {
    const text = verbatimText(tag);
    if (text) node.content = [{ type: "text", text }];
    return node;
  }
  if (!spec.content) return node;

  const content: DocNode[] = [];
  parseInto(content, tag.body ?? [], {
    marks: spec.marks === "" ? [] : ctx.marks,
    contained: ctx.contained || isContainer(el),
    inline: spec.content === "inline*" || spec.content === "text*",
  });
  if (content.length > 0) node.content = content;
  return node;
}

/**
 * Attributes of a matched element: schema defaults, then whatever the matcher
 * derived from the tag itself (a heading's level, a mention's identity), then
 * the per-attribute readers. An absent reading leaves the earlier value
 * standing, which is what keeps a stray `level` attribute off an `<h2>`.
 */
function readAttrs(
  specAttrs: Record<string, AttrSpec> | undefined,
  matcher: Matcher,
  el: SpecElement,
): { attrs?: Attrs } {
  if (!specAttrs) {
    const derived = matcher.attrs?.(el);
    return derived ? { attrs: derived } : {};
  }

  const attrs: Attrs = {};
  for (const [name, attr] of Object.entries(specAttrs)) {
    attrs[name] = attrDefault(attr);
  }
  Object.assign(attrs, matcher.attrs?.(el) ?? {});
  for (const [name, attr] of Object.entries(specAttrs)) {
    const value = attr.parse ? attr.parse(el) : rawAttr(el, name);
    if (value !== null && value !== undefined) attrs[name] = value;
  }
  return { attrs };
}

/**
 * An attribute no reader in the spec claims, typed the way the editor types it.
 *
 * `@tiptap/core` runs its `fromString` over every attribute an extension does
 * not parse itself, so the editor reads `colspan="1"` back as the number 1.
 * Taking the string here instead would make the two parsers disagree about the
 * same markup — and a document is written by one and edited by the other.
 */
function rawAttr(el: SpecElement, name: string): unknown {
  const value = el.attr(name);
  if (value === null) return null;
  if (/^[+-]?(?:\d*\.)?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/**
 * The literal text of a `<pre>`, whitespace and all. Nested markup is ignored
 * rather than parsed — a code block holds text and nothing else.
 *
 * A newline immediately after the `<pre>` is dropped, as an HTML parser does;
 * one after a nested `<code>` is real content and is kept.
 */
function verbatimText(tag: HtmlTagNode): string {
  const body = tag.body ?? [];
  const text = collectText(body);
  const first = body[0];
  const leadingNewline = first?.type === SyntaxKind.Text && first.value.startsWith("\n");
  return leadingNewline ? text.slice(1) : text;
}

function collectText(nodes: HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === SyntaxKind.Text) out += decodeHtmlEntities(node.value);
    else if (node.type === SyntaxKind.Tag) out += collectText(node.body ?? []);
  }
  return out;
}

/**
 * Adds a text node.
 *
 * Only the one rule that needs parse context lives here: a run of pure
 * whitespace between blocks is markup formatting, not content, and is dropped.
 * Collapsing and merging happen in `normalize.ts`, which has to do it anyway
 * for text hoisted out of a code block, and where the two cannot disagree.
 */
function appendText(out: DocNode[], raw: string, ctx: ParseContext): void {
  const text = decodeHtmlEntities(raw);
  if (!text) return;
  if (!text.trim() && !ctx.inline) return;

  // Key order matches ProseMirror's own JSON so the two are directly comparable.
  out.push({
    type: "text",
    ...(ctx.marks.length > 0 ? { marks: ctx.marks } : {}),
    text,
  });
}
