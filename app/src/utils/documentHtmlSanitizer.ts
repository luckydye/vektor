import * as html5parser from "html5parser";

type HtmlNode = html5parser.INode;
type TagNode = html5parser.ITag;
type TextNode = html5parser.IText;

const VOID_TAGS = new Set(["br", "hr", "img", "wbr"]);

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function normalizedAttrValue(attr: html5parser.IAttribute): string {
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

function sanitizedAttributes(tag: TagNode): string {
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

function sanitizeNode(node: HtmlNode): string {
  if (node.type === html5parser.SyntaxKind.Text) {
    return escapeHtml((node as TextNode).value);
  }

  if (node.type !== html5parser.SyntaxKind.Tag) return "";

  const tag = node as TagNode;
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
  return html5parser.parse(html).map(sanitizeNode).join("");
}
