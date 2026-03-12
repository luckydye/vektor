import * as html5parser from "html5parser";

type TagNode = html5parser.ITag;
type TextNode = html5parser.IText;
type AnyNode = html5parser.INode;

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

function attrsToString(attrs: html5parser.IAttribute[] = []): string {
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

function reconstructNode(node: AnyNode): string {
  if (node.type === html5parser.SyntaxKind.Text) {
    return (node as TextNode).value;
  }

  if (node.type !== html5parser.SyntaxKind.Tag) {
    return "";
  }

  const tag = node as TagNode;
  const attrs = tag.attributes?.length ? ` ${attrsToString(tag.attributes)}` : "";
  const name = tag.name.toLowerCase();

  if (VOID_TAGS.has(name)) {
    return `<${tag.name}${attrs}>`;
  }

  const body = (tag.body || []).map((child) => reconstructNode(child)).join("");
  return `<${tag.name}${attrs}>${body}</${tag.name}>`;
}

function hasBlockContent(nodes: AnyNode[]): boolean {
  return nodes.some((node) => {
    if (node.type !== html5parser.SyntaxKind.Tag) {
      return false;
    }

    const tag = node as TagNode;
    return BLOCK_TAGS.has(tag.name.toLowerCase()) || hasBlockContent(tag.body || []);
  });
}

function formatTextNode(node: TextNode, indent: string): string[] {
  if (node.value.trim().length === 0) {
    return [];
  }

  return node.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `${indent}${line}`);
}

function formatNode(node: AnyNode, depth: number): string[] {
  const indent = "  ".repeat(depth);

  if (node.type === html5parser.SyntaxKind.Text) {
    return formatTextNode(node as TextNode, indent);
  }

  if (node.type !== html5parser.SyntaxKind.Tag) {
    return [];
  }

  const tag = node as TagNode;
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

  return [
    `${indent}<${tag.name}${attrs}>`,
    ...childLines,
    `${indent}</${tag.name}>`,
  ];
}

export function prettyPrintHtml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed) {
    return "";
  }

  const ast = html5parser.parse(trimmed);
  const lines = ast.flatMap((node) => formatNode(node, 0));
  return lines.join("\n");
}
