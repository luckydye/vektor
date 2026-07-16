import * as html5parser from "html5parser";

type TagNode = html5parser.ITag;
type TextNode = html5parser.IText;
type AnyNode = html5parser.INode;

function getAttr(node: TagNode, name: string): string | undefined {
  return node.attributes?.find((a) => a.name.value === name)?.value?.value;
}

function getTextContent(nodes: AnyNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === html5parser.SyntaxKind.Text) {
      text += (node as TextNode).value;
    } else if (node.type === html5parser.SyntaxKind.Tag) {
      const body = (node as TagNode).body;
      if (body) text += getTextContent(body);
    }
  }
  return text;
}

// Elements that should be kept as raw HTML in the markdown output
const HTML_PASSTHROUGH_TAGS = new Set([
  "table",
  "figma-embed",
  "file-attachment",
  "document-attachment",
]);

function attrsToString(attrs: html5parser.IAttribute[]): string {
  return attrs
    .map((a) => {
      if (a.value === undefined) return a.name.value;
      const quote = a.value.quote || '"';
      return `${a.name.value}=${quote}${a.value.value}${quote}`;
    })
    .join(" ");
}

const VOID_TAGS = new Set([
  "img",
  "br",
  "hr",
  "input",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "embed",
  "source",
  "track",
  "wbr",
]);

function reconstructHtml(tag: TagNode): string {
  const attrs = tag.attributes?.length ? ` ${attrsToString(tag.attributes)}` : "";

  // Void tags don't have closing tags
  if (VOID_TAGS.has(tag.name.toLowerCase())) {
    return `<${tag.name}${attrs}>`;
  }

  const children = tag.body || [];
  const inner = children
    .map((child) => {
      if (child.type === html5parser.SyntaxKind.Text) {
        return (child as TextNode).value;
      }
      return reconstructHtml(child as TagNode);
    })
    .join("");
  return `<${tag.name}${attrs}>${inner}</${tag.name}>`;
}

// Check if a div is a column layout
function isColumnLayout(node: TagNode): boolean {
  return node.name === "div" && getAttr(node, "data-type") === "column-layout";
}

function nodeToMarkdown(node: AnyNode): string {
  if (node.type === html5parser.SyntaxKind.Text) {
    return (node as TextNode).value;
  }

  if (node.type !== html5parser.SyntaxKind.Tag) return "";

  const tag = node as TagNode;
  const name = tag.name.toLowerCase();
  const children = tag.body || [];
  const childContent = () => children.map(nodeToMarkdown).join("");

  // HTML passthrough - keep as raw HTML
  if (HTML_PASSTHROUGH_TAGS.has(name) || isColumnLayout(tag)) {
    return `\n\n${reconstructHtml(tag)}\n\n`;
  }

  // Ignore html-block elements entirely
  if (name === "html-block") return "";

  switch (name) {
    // Block elements
    case "h1":
      return `\n\n# ${childContent().trim()}\n\n`;
    case "h2":
      return `\n\n## ${childContent().trim()}\n\n`;
    case "h3":
      return `\n\n### ${childContent().trim()}\n\n`;
    case "p":
      return `\n\n${childContent().trim()}\n\n`;
    case "blockquote":
      return `\n\n> ${childContent().trim().replace(/\n/g, "\n> ")}\n\n`;
    case "hr":
      return "\n\n---\n\n";
    case "br":
      return "\n";

    // Lists
    case "ul":
    case "ol":
      return `\n\n${childContent()}\n`;
    case "li": {
      const isTask = getAttr(tag, "data-type") === "taskItem";
      const checked = getAttr(tag, "data-checked") === "true";
      const prefix = isTask ? (checked ? "- [x] " : "- [ ] ") : "- ";
      return `${prefix + childContent().trim()}\n`;
    }

    // Inline formatting
    case "strong":
    case "b":
      return `**${childContent()}**`;
    case "em":
    case "i":
      return `*${childContent()}*`;
    case "s":
    case "strike":
      return `~~${childContent()}~~`;
    case "u":
      return `<u>${childContent()}</u>`;
    case "code":
      return `\`${childContent()}\``;
    case "sub":
      return `<sub>${childContent()}</sub>`;
    case "sup":
      return `<sup>${childContent()}</sup>`;

    // Links and images
    case "a": {
      const href = getAttr(tag, "href") || "";
      return `[${childContent()}](${href})`;
    }
    case "img": {
      const src = getAttr(tag, "src") || "";
      const alt = getAttr(tag, "alt") || "";
      return `![${alt}](${src})`;
    }

    // Code blocks
    case "pre": {
      const codeNode = children.find(
        (c) => c.type === html5parser.SyntaxKind.Tag && (c as TagNode).name === "code",
      ) as TagNode | undefined;
      const text = codeNode ? getTextContent(codeNode.body || []) : childContent();
      const lang =
        codeNode?.attributes
          ?.find((a) => a.name.value === "class")
          ?.value?.value?.match(/language-(\w+)/)?.[1] || "";
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    }

    // Custom TipTap elements
    case "user-mention": {
      const email = getAttr(tag, "email") || "";
      const label = getTextContent(children).replace(/^@/, "");
      return `[@${label}](mailto:${email})`;
    }
    case "document-mention": {
      const href = getAttr(tag, "data-href") || "";
      const label = getTextContent(children);
      return href ? `[${label}](${href})` : label;
    }
    case "ticket-link": {
      const ticketId = getAttr(tag, "data-ticket-id") || childContent();
      const url = getAttr(tag, "data-connection-url");
      if (url) {
        const cleanId = ticketId.replace("#", "");
        const fullUrl = url.endsWith("/") ? `${url}${cleanId}` : `${url}/${cleanId}`;
        return `[${ticketId}](${fullUrl})`;
      }
      return ticketId;
    }
    case "date-picker": {
      const dateStr = getAttr(tag, "data-date") || "";
      try {
        return new Date(dateStr).toLocaleDateString("en-AU", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      } catch {
        return dateStr;
      }
    }
    case "expression-cell": {
      return getAttr(tag, "data-formula") || getTextContent(children) || "=";
    }

    // Default: just render children
    default:
      return childContent();
  }
}

export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  const ast = html5parser.parse(html);
  return ast
    .map(nodeToMarkdown)
    .join("")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}
