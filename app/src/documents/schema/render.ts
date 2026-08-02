import { escapeHtml, escapeHtmlText, VOID_TAGS } from "#utils/html.ts";
import { AttrsElement, parseStyle } from "./element.ts";
import {
  type AttrSpec,
  type Attrs,
  attrDefault,
  CONTENT_HOLE,
  type DocMark,
  type DocNode,
  type HtmlAttrs,
  markSpec,
  matches,
  type NodeSpec,
  nodeSpec,
  type RenderChild,
  type RenderTree,
  type Spec,
} from "./specs.ts";

/**
 * Document tree → HTML.
 *
 * The inverse of `parse.ts`, driven by the same table. Output is deliberately
 * one top-level block per line: document content is stored as HTML, diffed line
 * by line by the edit operations, and shown in revision views, so the line
 * structure is part of the format rather than a formatting choice.
 */

/** Serializes a whole document, one top-level block per line. */
export function docToHtml(doc: DocNode): string {
  const blocks = doc.content ?? [];
  if (blocks.length === 0) return "";
  return blocks.map((node) => nodeToHtml(node)).join("\n");
}

/** Serializes a single node, marks included. */
export function nodeToHtml(node: DocNode): string {
  return renderChildren([node]);
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderNode(node: DocNode): string {
  const spec = nodeSpec(node.type);
  if (!spec) return "";

  const attrs = { ...defaultsOf(spec), ...(node.attrs ?? {}) };
  const html = renderAttrs(spec, attrs);
  const tree = (spec.render ?? defaultRender(spec))({ attrs, html, node });
  return renderTree(tree, node.content ?? []);
}

function defaultRender(
  spec: NodeSpec,
): (ctx: { attrs: Attrs; html: HtmlAttrs; node?: DocNode }) => RenderTree {
  const tag = spec.match?.[0]?.tag ?? spec.name;
  const hasContent = Boolean(spec.content);
  return (ctx) => ({
    tag,
    attrs: ctx.html,
    ...(hasContent ? { children: [CONTENT_HOLE] } : {}),
  });
}

function renderTree(tree: RenderTree, content: DocNode[]): string {
  const attributes = renderAttributeString(tree.attrs);
  if (VOID_TAGS.has(tree.tag)) return `<${tree.tag}${attributes}>`;

  const inner = (tree.children ?? [])
    .map((child) => renderChild(child, content))
    .join("");
  return `<${tree.tag}${attributes}>${inner}</${tree.tag}>`;
}

function renderChild(child: RenderChild, content: DocNode[]): string {
  if (child === CONTENT_HOLE) return renderChildren(content);
  if (typeof child === "string") return escapeHtmlText(child);
  return renderTree(child, content);
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/**
 * Renders a run of children, opening and closing mark elements around it the
 * way ProseMirror's `DOMSerializer` does: a mark shared by neighbouring nodes
 * stays open across them, so `<strong>a<em>b</em></strong>` comes back out as
 * one `<strong>` rather than two.
 */
function renderChildren(children: DocNode[]): string {
  let out = "";
  let open: DocMark[] = [];

  for (const child of children) {
    const marks = child.marks ?? [];
    let shared = 0;
    while (
      shared < open.length &&
      shared < marks.length &&
      sameMark(open[shared], marks[shared])
    ) {
      shared++;
    }
    for (let i = open.length - 1; i >= shared; i--) {
      out += `</${markTag(open[i] as DocMark)}>`;
    }
    for (let i = shared; i < marks.length; i++) {
      out += markOpenTag(marks[i] as DocMark);
    }
    open = marks;

    out += child.type === "text" ? escapeHtmlText(child.text ?? "") : renderNode(child);
  }

  for (let i = open.length - 1; i >= 0; i--) {
    out += `</${markTag(open[i] as DocMark)}>`;
  }
  return out;
}

function markTree(mark: DocMark): RenderTree | null {
  const spec = markSpec(mark.type);
  if (!spec) return null;
  const attrs = { ...defaultsOf(spec), ...(mark.attrs ?? {}) };
  const html = renderAttrs(spec, attrs);
  const render =
    spec.render ??
    (() => ({
      tag: spec.match?.[0]?.tag ?? spec.name,
      attrs: html,
      children: [CONTENT_HOLE],
    }));
  return render({ attrs, html });
}

/**
 * Whether a mark would still be recognised after a round trip through HTML.
 *
 * A text style with no colour renders as a bare `<span>`, which the parser does
 * not read back as a text style; the same goes for a comment anchor without an
 * id, or a link without an href. Keeping such a mark makes the document differ
 * from its own serialization, so the normalizer drops it — the mark carried no
 * information in the first place.
 */
export function markSurvivesSerialization(mark: DocMark): boolean {
  const spec = markSpec(mark.type);
  if (!spec?.match?.length) return true;
  const tree = markTree(mark);
  if (!tree) return true;
  const element = new AttrsElement(tree.tag, tree.attrs ?? {});
  return spec.match.some((matcher) => matches(matcher, element));
}

function markOpenTag(mark: DocMark): string {
  const tree = markTree(mark);
  if (!tree) return "";
  return `<${tree.tag}${renderAttributeString(tree.attrs)}>`;
}

function markTag(mark: DocMark): string {
  return markTree(mark)?.tag ?? "span";
}

function sameMark(a: DocMark | undefined, b: DocMark | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  return JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function defaultsOf(spec: Spec): Attrs {
  const attrs: Attrs = {};
  for (const [name, attr] of Object.entries(spec.attrs ?? {})) {
    attrs[name] = attrDefault(attr);
  }
  return attrs;
}

/** Attribute values → HTML attributes, in declaration order. */
function renderAttrs(spec: Spec, attrs: Attrs): HtmlAttrs {
  let html: HtmlAttrs = {};
  for (const [name, attr] of Object.entries(spec.attrs ?? {})) {
    html = mergeHtmlAttrs(html, contribution(name, attr, attrs));
  }
  return html;
}

function contribution(name: string, attr: AttrSpec, attrs: Attrs): HtmlAttrs {
  if (attr.rendered === false) return {};
  const value = attrs[name];
  if (attr.render) return attr.render(value, attrs);
  return { [name]: value as string };
}

/**
 * Merges attribute sets the way TipTap's `mergeAttributes` does: `class` and
 * `style` accumulate, everything else is replaced. Two attributes both
 * contributing a style — a coloured, right-aligned paragraph — have to end up
 * in one declaration list.
 */
export function mergeHtmlAttrs(...sets: HtmlAttrs[]): HtmlAttrs {
  const merged: HtmlAttrs = {};
  for (const set of sets) {
    for (const [name, value] of Object.entries(set)) {
      const existing = merged[name];
      if (existing === undefined || existing === null || existing === "") {
        merged[name] = value;
      } else if (name === "class") {
        const classes = new Set(String(existing).split(/\s+/).filter(Boolean));
        for (const token of String(value ?? "").split(/\s+/)) {
          if (token) classes.add(token);
        }
        merged[name] = [...classes].join(" ");
      } else if (name === "style") {
        const declarations = parseStyle(String(existing));
        for (const [property, declaration] of parseStyle(String(value ?? ""))) {
          declarations.set(property, declaration);
        }
        merged[name] = declarationString(declarations);
      } else {
        merged[name] = value;
      }
    }
  }
  return merged;
}

function declarationString(declarations: Map<string, string>): string {
  return [...declarations].map(([property, value]) => `${property}: ${value}`).join("; ");
}

function renderAttributeString(attrs: HtmlAttrs | undefined): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined) continue;
    if (name === "style") {
      const declarations = parseStyle(String(value));
      if (declarations.size === 0) continue;
      // A browser's style serializer terminates the last declaration too;
      // matching it keeps stored documents byte-identical across the cutover.
      parts.push(` style="${escapeHtml(`${declarationString(declarations)};`)}"`);
      continue;
    }
    parts.push(` ${name}="${escapeHtml(String(value))}"`);
  }
  return parts.join("");
}
