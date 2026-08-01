import {
  type IAttribute,
  type INode,
  type ITag,
  type IText,
  parse,
  SyntaxKind,
} from "html5parser";

/**
 * HTML string helpers shared by every hand-built markup path: escaping for
 * interpolation into templates, pretty-printing for diff/suggestion views,
 * re-serializing parsed nodes, and sanitizing untrusted document HTML down to
 * an allow-listed subset before it is rendered as a preview.
 */

/**
 * Escape a string for interpolation into HTML — text content *or* a quoted
 * attribute value. Both quote styles are escaped so a single helper is safe in
 * either position; this is the only escaper in the app, so call sites never
 * have to reason about which characters a local variant happened to cover.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// This is the only module that imports `html5parser` directly. Everything that
// walks document HTML goes through the re-exports below, so the parser stays
// replaceable in one place and node-type aliases are named consistently.
export type {
  IAttribute as HtmlAttribute,
  INode as HtmlNode,
  ITag as HtmlTagNode,
  IText as HtmlTextNode,
};
export { parse as parseHtml, SyntaxKind };

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const BLOCK_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "div",
  "dl",
  "dt",
  "dd",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function attrsToString(attrs: IAttribute[] = []): string {
  return attrs
    .map((attr) => {
      if (attr.value === undefined) {
        return attr.name.value;
      }

      const quote = attr.value.quote || '"';
      return `${attr.name.value}=${quote}${attr.value.value}${quote}`;
    })
    .join(" ");
}

/**
 * Serialize a parsed node back to HTML, preserving attributes and quote style.
 * Used to pass tables and custom elements through markdown conversion verbatim.
 */
export function reconstructNode(node: INode): string {
  if (node.type === SyntaxKind.Text) {
    return (node as IText).value;
  }

  if (node.type !== SyntaxKind.Tag) {
    return "";
  }

  const tag = node as ITag;
  const attrs = tag.attributes?.length ? ` ${attrsToString(tag.attributes)}` : "";
  const name = tag.name.toLowerCase();

  if (VOID_TAGS.has(name)) {
    return `<${tag.name}${attrs}>`;
  }

  const body = (tag.body || []).map((child) => reconstructNode(child)).join("");
  return `<${tag.name}${attrs}>${body}</${tag.name}>`;
}

function hasBlockContent(nodes: INode[]): boolean {
  return nodes.some((node) => {
    if (node.type !== SyntaxKind.Tag) {
      return false;
    }

    const tag = node as ITag;
    return BLOCK_TAGS.has(tag.name.toLowerCase()) || hasBlockContent(tag.body || []);
  });
}

function formatTextNode(node: IText, indent: string): string[] {
  if (node.value.trim().length === 0) {
    return [];
  }

  return node.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `${indent}${line}`);
}

function formatNode(node: INode, depth: number): string[] {
  const indent = "  ".repeat(depth);

  if (node.type === SyntaxKind.Text) {
    return formatTextNode(node as IText, indent);
  }

  if (node.type !== SyntaxKind.Tag) {
    return [];
  }

  const tag = node as ITag;
  const attrs = tag.attributes?.length ? ` ${attrsToString(tag.attributes)}` : "";
  const name = tag.name.toLowerCase();

  if (VOID_TAGS.has(name)) {
    return [`${indent}<${tag.name}${attrs}>`];
  }

  const body = tag.body || [];
  if (!hasBlockContent(body)) {
    return [`${indent}${reconstructNode(tag)}`];
  }

  const childLines = body.flatMap((child) => formatNode(child, depth + 1));

  if (childLines.length === 0) {
    return [`${indent}<${tag.name}${attrs}></${tag.name}>`];
  }

  if (childLines.length === 1 && !childLines[0]?.trim().startsWith("<")) {
    return [`${indent}<${tag.name}${attrs}>${childLines[0].trim()}</${tag.name}>`];
  }

  return [`${indent}<${tag.name}${attrs}>`, ...childLines, `${indent}</${tag.name}>`];
}

export function prettyPrintHtml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) {
    return "";
  }

  const ast = parse(trimmed);
  const lines = ast.flatMap((node) => formatNode(node, 0));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plain text extraction
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

function decodedCodePoint(value: string, radix: number, original: string): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : original;
}

/**
 * Decode the character references a text node can carry. One pass only: a
 * decoded `&` must not start a second round of decoding, or `&amp;lt;` — text
 * that means the literal string `&lt;` — would turn into a `<`.
 */
function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([\da-f]+)|#(\d+)|(nbsp|amp|lt|gt|quot|apos));/gi,
    (match, hex: string | undefined, decimal: string | undefined, name?: string) => {
      if (hex !== undefined) return decodedCodePoint(hex, 16, match);
      if (decimal !== undefined) return decodedCodePoint(decimal, 10, match);
      return NAMED_ENTITIES[name?.toLowerCase() ?? ""] ?? match;
    },
  );
}

// Elements whose contents are not prose: markup, styling or serialized state
// that would read as noise (or leak attribute payloads) in a text rendering.
const NON_TEXT_TAGS = new Set(["script", "style", "svg", "math", "head", "template"]);

function plainTextNodes(nodes: INode[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === SyntaxKind.Text) {
      out.push(decodeHtmlEntities((node as IText).value));
      continue;
    }

    if (node.type !== SyntaxKind.Tag) continue;

    const tag = node as ITag;
    const name = tag.name.toLowerCase();
    // `!--` / `!doctype`: comments and declarations carry no readable text.
    if (name.startsWith("!") || NON_TEXT_TAGS.has(name)) continue;

    if (name === "br") {
      out.push("\n");
      continue;
    }

    const block = BLOCK_TAGS.has(name);
    if (block) out.push("\n");
    if (name === "li") out.push("• ");
    plainTextNodes(tag.body ?? [], out);
    if (block) out.push("\n");
  }
}

/**
 * Extract readable plain text from document HTML: element text in document
 * order, with block boundaries as newlines and list items bulleted.
 *
 * Parsed rather than regex-stripped — attribute values legally contain `>`,
 * quotes and encoded markup, so a `<[^>]*>` strip terminates mid-tag and spills
 * serialized attribute payloads (canvas state, data props) into the text.
 */
export function htmlToPlainText(html: string): string {
  const out: string[] = [];
  plainTextNodes(parse(html), out);
  return out
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s\n]*/g, "\n")
    .trim();
}

/**
 * Strip all script tags from HTML content to prevent XSS attacks
 */
export function stripScriptTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<script[^>]*>/gi, "");
}

// ---------------------------------------------------------------------------
// Sanitizing untrusted document HTML
// ---------------------------------------------------------------------------

const DROP_WITH_CONTENT_TAGS = new Set([
  "base",
  "canvas",
  "embed",
  "form",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "textarea",
]);

const ALLOWED_TAGS = new Set([
  "a",
  "article",
  "blockquote",
  "br",
  "caption",
  "code",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "img",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "wbr",
]);

const GLOBAL_ATTRIBUTES = new Set(["class", "title"]);
const LINK_ATTRIBUTES = new Set(["href"]);
const IMAGE_ATTRIBUTES = new Set(["alt", "height", "src", "width"]);
const TABLE_CELL_ATTRIBUTES = new Set(["colspan", "rowspan"]);

function safeUrl(
  value: string,
  options: { allowImagesOnly?: boolean } = {},
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    if (
      !options.allowImagesOnly &&
      (parsed.protocol === "mailto:" || parsed.protocol === "tel:")
    ) {
      return trimmed;
    }
  } catch {
    if (/^(?:\.\.?\/)[^\s]*$/u.test(trimmed)) return trimmed;
  }

  return null;
}

function normalizedAttrValue(attr: IAttribute): string {
  return attr.value?.value ?? "";
}

function isAllowedAttribute(tagName: string, attrName: string): boolean {
  if (attrName.startsWith("on")) return false;
  if (GLOBAL_ATTRIBUTES.has(attrName)) return true;
  if (tagName === "a" && LINK_ATTRIBUTES.has(attrName)) return true;
  if (tagName === "img" && IMAGE_ATTRIBUTES.has(attrName)) return true;
  if ((tagName === "td" || tagName === "th") && TABLE_CELL_ATTRIBUTES.has(attrName)) {
    return true;
  }
  return false;
}

function sanitizedAttributes(tag: ITag): string {
  const tagName = tag.name.toLowerCase();
  const attrs: string[] = [];

  for (const attr of tag.attributes ?? []) {
    const name = attr.name.value.toLowerCase();
    if (!isAllowedAttribute(tagName, name)) continue;

    let value = normalizedAttrValue(attr);
    if (name === "href") {
      const safe = safeUrl(value);
      if (!safe) continue;
      value = safe;
    } else if (name === "src") {
      const safe = safeUrl(value, { allowImagesOnly: true });
      if (!safe) continue;
      value = safe;
    } else if (
      (name === "width" ||
        name === "height" ||
        name === "colspan" ||
        name === "rowspan") &&
      !/^\d{1,4}$/u.test(value)
    ) {
      continue;
    }

    attrs.push(`${name}="${escapeHtml(value)}"`);
  }

  if (tagName === "a" && attrs.some((attr) => attr.startsWith("href="))) {
    attrs.push('rel="noopener noreferrer"');
  }

  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

function sanitizeNode(node: INode): string {
  if (node.type === SyntaxKind.Text) {
    return escapeHtml((node as IText).value);
  }

  if (node.type !== SyntaxKind.Tag) return "";

  const tag = node as ITag;
  const name = tag.name.toLowerCase();
  if (DROP_WITH_CONTENT_TAGS.has(name)) return "";

  const inner = (tag.body ?? []).map(sanitizeNode).join("");
  if (!ALLOWED_TAGS.has(name)) return inner;

  const attrs = sanitizedAttributes(tag);
  if (VOID_TAGS.has(name)) return `<${name}${attrs}>`;
  return `<${name}${attrs}>${inner}</${name}>`;
}

export function sanitizeVektorDocumentPreviewHtml(html: string): string {
  if (!html.trim()) return "";
  return parse(html).map(sanitizeNode).join("");
}
