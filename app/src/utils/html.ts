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
 * either position; call sites never have to reason about which characters a
 * local variant happened to cover.
 *
 * The one exception is document serialization, which needs `escapeHtmlText`.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Escape a string for use as HTML *text*, escaping exactly the three characters
 * a browser's own serializer does.
 *
 * Document HTML is stored, diffed line by line, and shown in revision views, so
 * it has to come back out of the serializer the way it went in: escaping quotes
 * as well (which `escapeHtml` does, correctly, for attribute positions) would
 * rewrite every stored document that contains one.
 */
export function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

/** Elements that never have a closing tag. */
export const VOID_TAGS = new Set([
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

/** Elements that break the text flow — the unit a quoted excerpt is cut at. */
export const BLOCK_TAGS = new Set([
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
 *
 * The trailing semicolon is optional on a numeric reference because it is
 * optional to a browser: `&#106avascript:` is a parse error the tokenizer
 * recovers from by emitting the `j` and reading on, which makes it a
 * `javascript:` URL. Named references are only decoded terminated, which is the
 * conservative half of the browser's rule — `isSafeUrlValue` and
 * `sanitizedStyleValue` refuse a value still holding a `&` rather than guess.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([\da-f]+);?|#(\d+);?|(nbsp|amp|lt|gt|quot|apos);)/gi,
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

// ---------------------------------------------------------------------------
// Sanitizing untrusted HTML
// ---------------------------------------------------------------------------

/**
 * Three policies, one walker.
 *
 * Every path that stores or renders markup a user could have written goes
 * through one of the entry points at the bottom of this module:
 *
 *  - `sanitizeDocumentHtml` — document content, the format the editor writes.
 *    Keeps the whole document vocabulary (custom elements, `data-` attributes,
 *    inline styles, task-item checkboxes) and removes what executes.
 *  - `sanitizeVektorDocumentPreviewHtml` — markup this app did not write and
 *    only displays: a preview card fetched from somewhere else, a workflow
 *    run's `html` output. Nothing but prose survives.
 *  - `sanitizeSvgMarkup` — a space logo or extension icon, injected as markup.
 *
 * A policy names the tags it keeps and the tags it drops together with their
 * subtree. A tag that is neither is *unwrapped*: its children survive, the
 * element does not. On top of that the shared rules below hold for all three:
 * no event handler, no attribute a browser resolves into a navigation or a
 * fetch unless the URL passes `isSafeUrlValue`, no CSS that can load a
 * resource, and no comment (see `sanitizeNode`).
 *
 * Sanitizing is idempotent and, for markup this app wrote itself, byte-stable:
 * content is sanitized on write *and* on render, and a document whose bytes
 * changed on every save would rewrite its own revision history.
 */
interface SanitizePolicy {
  /** Dropped with their whole subtree — their content is not prose. */
  readonly drop: ReadonlySet<string>;
  /** Kept as an element. Anything else is unwrapped. */
  keeps(tag: string): boolean;
  /** Kept on a kept element, on top of the shared attribute rules. */
  keepsAttribute(tag: string, attribute: string): boolean;
  /** URLs may only address this document (`#id`) or inline image data. */
  readonly localUrlsOnly?: boolean;
  /** `<html-block data-html>` payloads are sanitized with the same policy. */
  readonly sanitizesHtmlBlocks?: boolean;
  /**
   * Links keeping an `href` get a `rel` when they carry none — `"all"` for
   * every link, `"newTab"` only for those that also keep a `target`.
   */
  readonly hardensLinks?: "all" | "newTab";
  /** `width` / `height` / `colspan` / `rowspan` must be plain integers. */
  readonly numericSizesOnly?: boolean;
}

/**
 * A structurally valid attribute name. Anything else is dropped rather than
 * inspected: `html5parser` reports `<img/onerror="alert(1)">` — which browsers
 * read as an `onerror` handler — as an attribute literally named `/onerror`,
 * which no `on*` prefix test would catch.
 */
const ATTRIBUTE_NAME_PATTERN = /^[a-z_:][a-z\d_:.-]*$/;

/**
 * Attributes dropped on every element in every policy: each one either points a
 * browser at a URL in a context we do not want to underwrite (`srcdoc`,
 * `formaction`, `ping`, `background`, …) or changes what an element *is* (`is`
 * upgrades it to a custom element).
 */
const DANGEROUS_ATTRIBUTES = new Set([
  "action",
  "background",
  "classid",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "http-equiv",
  "is",
  "lowsrc",
  "ping",
  "srcdoc",
  "srcset",
]);

/** Attributes holding a URL, kept only when the URL itself is safe. */
const URL_ATTRIBUTES = new Set([
  "cite",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "profile",
  "src",
  "xlink:href",
]);

/** URL attributes that address a subresource rather than a navigation. */
const MEDIA_URL_ATTRIBUTES = new Set(["poster", "src", "xlink:href"]);

/**
 * Elements whose URL attributes address a subresource however they are named:
 * SVG 1.1 writes an image reference as `xlink:href` and SVG 2 as plain `href`,
 * which on an `<a>` would be a navigation.
 */
const MEDIA_TAGS = new Set([
  "audio",
  "image",
  "img",
  "input",
  "source",
  "track",
  "video",
]);

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_MEDIA_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

/**
 * Inline image data, which an editor can legitimately paste. `image/svg+xml` is
 * deliberately absent: an inline SVG document is markup, and this is the one
 * place a `data:` URL would carry markup rather than pixels.
 */
const INLINE_IMAGE_DATA_URL =
  /^data:image\/(?:apng|avif|bmp|gif|jpeg|jpg|png|webp|x-icon)[;,]/i;

/**
 * CSS that can reach outside the page. `url()` in any declaration makes every
 * reader's browser fetch an attacker-chosen host (see the `brandColor` and
 * `background` shorthand sinks); a backslash is CSS's escape character, so a
 * declaration carrying one cannot be read at face value.
 */
const RESOURCE_LOADING_CSS = /url\(|image-set\(|expression\(|javascript:|@import|\\/i;

function isSanitizableAttributeName(name: string): boolean {
  if (!ATTRIBUTE_NAME_PATTERN.test(name)) return false;
  // Every event handler, including the ones no browser has shipped yet.
  if (name.startsWith("on")) return false;
  return !DANGEROUS_ATTRIBUTES.has(name);
}

/**
 * The value a browser will actually resolve: it drops tab, LF and CR wherever
 * they appear in a URL, and ignores leading and trailing C0 controls and spaces.
 */
function normalizeUrlWhitespace(value: string): string {
  const stripped = value.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "");
  let start = 0;
  let end = stripped.length;
  while (start < end && stripped.charCodeAt(start) <= 0x20) start++;
  while (end > start && stripped.charCodeAt(end - 1) <= 0x20) end--;
  return stripped.slice(start, end);
}

/**
 * Is this attribute value a URL we are willing to hand a browser?
 *
 * What makes a URL dangerous is its scheme, so the judgement is made on the
 * region a browser reads before it can tell the value is relative — everything
 * up to the first `/`, `?` or `#`. A scheme there has to be in the allow-list; a
 * region with no `:` in it cannot name one and the value is relative.
 *
 * The value is entity-decoded first because a browser decodes it before
 * resolving it, so `&#106;avascript:alert(1)` is judged as `javascript:alert(1)`.
 * A `&` left in the scheme region after that is a character reference this
 * module does not decode but a browser might — `java&NewLine;script:` becomes
 * `javascript:` — so it fails closed rather than being read at face value. That
 * cannot reject a legitimate query string, whose `&` lives past the `?`.
 */
export function isSafeUrlValue(
  value: string,
  options: { localOnly?: boolean; media?: boolean } = {},
): boolean {
  const decoded = normalizeUrlWhitespace(
    decodeHtmlEntities(normalizeUrlWhitespace(value)),
  );
  if (!decoded) return true;
  if (options.media && INLINE_IMAGE_DATA_URL.test(decoded)) return true;
  // A value that opens with `#` is a fragment: no reference in it can move it.
  if (options.localOnly) return decoded.startsWith("#");

  const schemeRegion = decoded.split(/[/?#]/, 1)[0] ?? "";
  if (schemeRegion.includes("&")) return false;
  if (!schemeRegion.includes(":")) return true;

  let protocol: string;
  try {
    protocol = new URL(decoded).protocol;
  } catch {
    // A scheme region we cannot parse is one we cannot vouch for.
    return false;
  }

  return (options.media ? SAFE_MEDIA_PROTOCOLS : SAFE_LINK_PROTOCOLS).has(protocol);
}

/**
 * Split a declaration list on the semicolons that actually end a declaration.
 * A quoted value may contain one (`font-family:"A;B"`), and splitting there
 * halves a declaration into two fragments that mean something else.
 */
function splitStyleDeclarations(value: string): string[] {
  const declarations: string[] = [];
  let start = 0;
  let quote: string | null = null;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ";") {
      declarations.push(value.slice(start, index));
      start = index + 1;
    }
  }

  declarations.push(value.slice(start));
  return declarations;
}

/**
 * A declaration a browser could turn into a request. Decoding comes first
 * because the browser decodes the attribute before the CSS parser ever sees it:
 * `background-image:&#117;rl(//evil)` is a `url()` to a browser, and `&#117;`
 * carries the very semicolon the declaration list is split on. A `&` surviving
 * the decode is a reference this module does not know, so the declaration goes.
 */
function isResourceLoadingDeclaration(declaration: string): boolean {
  return RESOURCE_LOADING_CSS.test(declaration) || declaration.includes("&");
}

/**
 * The declarations of an inline style that cannot load a resource, or `null`
 * when none are left. An untouched style is returned as it came in: documents
 * are stored as HTML and re-sanitized on every save, so rewriting a style that
 * was already safe would churn every stored document.
 */
function sanitizedStyleValue(value: string): string | null {
  const declarations = splitStyleDeclarations(decodeHtmlEntities(value));
  if (!declarations.some(isResourceLoadingDeclaration)) {
    return value;
  }

  const safe = declarations.filter(
    (declaration) => declaration.trim() && !isResourceLoadingDeclaration(declaration),
  );
  return safe.length ? `${safe.join(";")};` : null;
}

/**
 * Text as text. Only `<` is escaped: a text node arrives holding its own source
 * (`&amp;` is still `&amp;`), so escaping `&` as well would double-escape every
 * entity in the document each time it is saved.
 */
function escapeSanitizedText(value: string): string {
  return value.replaceAll("<", "&lt;");
}

/** Attribute values are emitted double-quoted, so `"` and `<` are enough. */
function escapeSanitizedAttributeValue(value: string): string {
  return value.replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

// ---------------------------------------------------------------------------
// Policy: remote document previews
// ---------------------------------------------------------------------------

const PREVIEW_DROP_TAGS = new Set([
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

const PREVIEW_TAGS = new Set([
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
const SIZE_ATTRIBUTES = new Set(["colspan", "height", "rowspan", "width"]);

const PREVIEW_POLICY: SanitizePolicy = {
  drop: PREVIEW_DROP_TAGS,
  hardensLinks: "all",
  numericSizesOnly: true,
  keeps: (tag) => PREVIEW_TAGS.has(tag),
  keepsAttribute: (tag, attribute) => {
    if (GLOBAL_ATTRIBUTES.has(attribute)) return true;
    if (tag === "a" && LINK_ATTRIBUTES.has(attribute)) return true;
    if (tag === "img" && IMAGE_ATTRIBUTES.has(attribute)) return true;
    return (tag === "td" || tag === "th") && TABLE_CELL_ATTRIBUTES.has(attribute);
  },
};

// ---------------------------------------------------------------------------
// Policy: document content
// ---------------------------------------------------------------------------

/**
 * Elements dropped with their content in document HTML.
 *
 * `script`, `style`, `textarea`, `title`, `noscript`, `xmp`, `plaintext` and
 * `listing` are all elements whose children a browser reads as raw text rather
 * than as markup — a sanitizer that walked into them and re-serialized what it
 * found would be arguing with the parser about where the element ends. The
 * rest (`iframe`, `object`, `embed`, `form`, `math`, `base`, `meta`, `link`,
 * `template`, `frame*`) either run code, issue a request, or move the document's
 * base URL, and no document needs any of them.
 */
const DOCUMENT_DROP_TAGS = new Set([
  "base",
  "embed",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "link",
  "listing",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "plaintext",
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
]);

/**
 * The element vocabulary of a document, which is wider than a preview's: the
 * editor stores task-item checkboxes, tables with colgroups, media, and — for
 * markup the schema has no node of its own for — whatever the author wrote,
 * verbatim, inside an `html-block` payload (see `HTML_BLOCK_TAGS`). Custom
 * elements are kept by shape (`isCustomElementTag`) rather than by name, since
 * that is the rule the document schema itself uses.
 */
const DOCUMENT_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
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
  "hgroup",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "meter",
  "nav",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "select",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

/** A custom element, which is any tag name containing a hyphen. */
function isCustomElementTag(tag: string): boolean {
  return tag.includes("-");
}

const DOCUMENT_POLICY: SanitizePolicy = {
  drop: DOCUMENT_DROP_TAGS,
  sanitizesHtmlBlocks: true,
  // Pasted markup can carry `target="_blank"` without a `rel`, which renders
  // with `window.opener` intact and leaks the document URL as a referrer. Only
  // those links are rewritten: documents are stored, so a plain in-document
  // link has to come back out of the sanitizer byte for byte.
  hardensLinks: "newTab",
  keeps: (tag) => DOCUMENT_TAGS.has(tag) || isCustomElementTag(tag),
  // A deny-list, unlike the preview policy: a document carries the schema's
  // `data-` attributes on its own elements and arbitrary attributes inside an
  // `html-block` payload, and none of them execute once the shared rules have
  // taken the handlers, the URLs and the resource-loading CSS out. What it does
  // leave a member is layout — `position:fixed` over the app chrome — which is
  // the price of storing inline styles at all, and is not an escalation.
  keepsAttribute: () => true,
};

// ---------------------------------------------------------------------------
// Policy: SVG
// ---------------------------------------------------------------------------

/**
 * SVG is markup with its own script surface, and a space logo is markup an
 * editor typed. `script` and `foreignObject` (which switches back to HTML)
 * carry code; `style` can load a resource; the animation elements exist to
 * assign attributes at runtime, which is a way to write an `href` or a handler
 * after the fact.
 */
const SVG_DROP_TAGS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "discard",
  "foreignobject",
  "handler",
  "script",
  "set",
  "style",
]);

/**
 * Shapes, text, gradients, filters and structure — the elements a logo or icon
 * is drawn from. `a` is absent (a logo does not navigate) and so is anything
 * that loads a document; `image` stays, but the shared URL rules leave it
 * `#`-fragments and inline image data only.
 */
const SVG_TAGS = new Set([
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feconvolvematrix",
  "fediffuselighting",
  "fedisplacementmap",
  "fedistantlight",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "fepointlight",
  "fespecularlighting",
  "fespotlight",
  "fetile",
  "feturbulence",
  "filter",
  "g",
  "image",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "svg",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tspan",
  "use",
  "view",
]);

const SVG_POLICY: SanitizePolicy = {
  drop: SVG_DROP_TAGS,
  localUrlsOnly: true,
  keeps: (tag) => SVG_TAGS.has(tag),
  keepsAttribute: () => true,
};

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/** How deep `html-block` payloads may nest before the innermost is dropped. */
const MAX_HTML_BLOCK_DEPTH = 4;

/**
 * How deep elements may nest before the rest of the subtree is dropped. The
 * walker recurses per element and runs on the document write paths, so without a
 * cap a document nested a few tens of thousands deep — which costs an attacker
 * one save — overflows the stack instead of being sanitized. Editor documents
 * nest a dozen levels; a browser stops building the tree around here too.
 */
const MAX_ELEMENT_DEPTH = 256;

function attributeName(attribute: IAttribute): string {
  return attribute.name.value.toLowerCase();
}

function sanitizedAttributes(
  tag: ITag,
  name: string,
  policy: SanitizePolicy,
  skip?: (attribute: string) => boolean,
): string {
  const attrs: string[] = [];
  let keptHref = false;
  let keptRel = false;
  let keptTarget = false;

  for (const attribute of tag.attributes ?? []) {
    const attributeKey = attributeName(attribute);
    if (skip?.(attributeKey)) continue;
    if (!isSanitizableAttributeName(attributeKey)) continue;
    if (!policy.keepsAttribute(name, attributeKey)) continue;

    // `<input checked>`: a valueless attribute stays valueless.
    if (attribute.value === undefined) {
      attrs.push(attributeKey);
      continue;
    }

    let value = attribute.value.value;

    if (URL_ATTRIBUTES.has(attributeKey)) {
      if (
        !isSafeUrlValue(value, {
          localOnly: policy.localUrlsOnly,
          media: MEDIA_URL_ATTRIBUTES.has(attributeKey) || MEDIA_TAGS.has(name),
        })
      ) {
        continue;
      }
    } else if (attributeKey === "style") {
      const style = sanitizedStyleValue(value);
      if (style === null) continue;
      value = style;
    } else if (
      policy.numericSizesOnly &&
      SIZE_ATTRIBUTES.has(attributeKey) &&
      !/^\d{1,4}$/u.test(value)
    ) {
      continue;
    }

    if (attributeKey === "href") keptHref = true;
    if (attributeKey === "rel") keptRel = true;
    if (attributeKey === "target") keptTarget = true;
    attrs.push(`${attributeKey}="${escapeSanitizedAttributeValue(value)}"`);
  }

  if (
    name === "a" &&
    keptHref &&
    !keptRel &&
    (policy.hardensLinks === "all" || (policy.hardensLinks === "newTab" && keptTarget))
  ) {
    attrs.push('rel="noopener noreferrer"');
  }

  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

/**
 * An `html-block` carries a whole HTML fragment in its `data-html` attribute,
 * which the element re-renders into a shadow root — so the payload is sanitized
 * with the same policy and written back in the encoding the schema renders it
 * with (`documents/schema/specs.ts`).
 */
function sanitizeHtmlBlock(
  tag: ITag,
  policy: SanitizePolicy,
  blockDepth: number,
  depth: number,
): string {
  const attrs = sanitizedAttributes(tag, "html-block", policy, (attribute) =>
    attribute.startsWith("data-html"),
  );

  const payload = tag.attributes?.find(
    (attribute) => attributeName(attribute) === "data-html",
  );
  if (!payload) return `<html-block${attrs}></html-block>`;

  const encoding = tag.attributes?.find(
    (attribute) => attributeName(attribute) === "data-html-encoding",
  );
  let source = payload.value?.value ?? "";
  if (encoding?.value?.value === "uri") {
    try {
      source = decodeURIComponent(source);
    } catch {
      // Keep the raw value: an undecodable payload is still sanitized below.
    }
  }

  const sanitized =
    blockDepth >= MAX_HTML_BLOCK_DEPTH
      ? ""
      : sanitizeNodes(parse(source), policy, blockDepth + 1, depth);

  // `encodeURIComponent` leaves nothing a parser could read as markup, so the
  // payload needs no further escaping.
  return `<html-block${attrs} data-html="${encodeURIComponent(sanitized)}" data-html-encoding="uri"></html-block>`;
}

function sanitizeNodes(
  nodes: INode[],
  policy: SanitizePolicy,
  blockDepth: number,
  depth: number,
): string {
  let out = "";
  for (const node of nodes) out += sanitizeNode(node, policy, blockDepth, depth);
  return out;
}

function sanitizeNode(
  node: INode,
  policy: SanitizePolicy,
  blockDepth: number,
  depth: number,
): string {
  if (node.type === SyntaxKind.Text) {
    return escapeSanitizedText((node as IText).value);
  }

  if (node.type !== SyntaxKind.Tag) return "";
  if (depth >= MAX_ELEMENT_DEPTH) return "";

  const tag = node as ITag;
  const name = tag.name.toLowerCase();

  // Comments and declarations, which `html5parser` reports as tags named `!--`
  // and `!doctype`. They are dropped with their content because the two parsers
  // disagree about where a malformed comment ends: `<!--><img src=x onerror=…>`
  // is one comment node here and an abruptly-closed comment followed by a live
  // `<img>` in a browser, so passing the text through would ship the payload.
  if (name.startsWith("!")) return "";

  if (policy.drop.has(name)) return "";

  // An `<svg>` subtree is SVG, whatever policy it was found under.
  const scoped = name === "svg" ? SVG_POLICY : policy;

  // An unwrapped element does not nest its children any deeper.
  if (!scoped.keeps(name))
    return sanitizeNodes(tag.body ?? [], scoped, blockDepth, depth);

  if (name === "html-block" && scoped.sanitizesHtmlBlocks) {
    return sanitizeHtmlBlock(tag, scoped, blockDepth, depth);
  }

  const attrs = sanitizedAttributes(tag, name, scoped);
  if (VOID_TAGS.has(name)) return `<${name}${attrs}>`;
  const body = sanitizeNodes(tag.body ?? [], scoped, blockDepth, depth + 1);
  return `<${name}${attrs}>${body}</${name}>`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Document HTML, safe to store and to hand `innerHTML`.
 *
 * This is the sanitization boundary for document content: the save, edit and
 * collaboration-persist paths run it on the way in, and every render path runs
 * it again on the way out, so content stored before the boundary existed is
 * still rendered safely.
 */
export function sanitizeDocumentHtml(html: string): string {
  if (!html.trim()) return "";
  return sanitizeNodes(parse(html), DOCUMENT_POLICY, 0, 0);
}

/**
 * Is this a URL an `<img src>` may point at?
 *
 * The same rule the sanitizer applies to a document's own images, exposed for
 * the stored values that reach a `src` without passing through markup — a space
 * logo given as a URL rather than as inline SVG.
 */
export function isSafeImageUrl(value: string): boolean {
  return isSafeUrlValue(value, { media: true });
}

/** Someone else's HTML, reduced to the prose a preview card shows. */
export function sanitizeVektorDocumentPreviewHtml(html: string): string {
  if (!html.trim()) return "";
  return sanitizeNodes(parse(html), PREVIEW_POLICY, 0, 0);
}

/**
 * An `<svg>` document, safe to hand `innerHTML` — used for the space logo and
 * for extension-supplied icons, which are stored as markup.
 *
 * Only `<svg>` roots survive: a value that is not an SVG document (a URL, a
 * bare `<img onerror>`) sanitizes to the empty string, which the caller reads
 * as "no icon".
 */
export function sanitizeSvgMarkup(svg: string): string {
  if (!svg.trim()) return "";

  let out = "";
  for (const node of parse(svg)) {
    if (node.type !== SyntaxKind.Tag) continue;
    if ((node as ITag).name.toLowerCase() !== "svg") continue;
    out += sanitizeNode(node, SVG_POLICY, 0, 0);
  }
  return out;
}
