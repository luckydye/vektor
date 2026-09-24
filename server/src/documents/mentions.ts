import { appLogger } from "#observability/logger.ts";
import {
  BLOCK_TAGS,
  type HtmlNode,
  type HtmlTagNode,
  htmlToPlainText,
  parseHtml,
  SyntaxKind,
} from "#utils/html.ts";

export interface ExtractedMention {
  email: string;
  label?: string;
}

/**
 * Extracts user mentions from HTML content by parsing for <user-mention> elements
 *
 * The HTML is parsed using html5parser to create an AST (Abstract Syntax Tree),
 * which is then traversed to find all <user-mention> custom elements. These elements
 * are created by the TipTap editor's MentionExtension when users type @ followed by
 * a user's name.
 *
 * Example HTML input:
 *   <p>Hey <user-mention email="john@example.com">@John Doe</user-mention>, check this out!</p>
 *
 * Returns:
 *   [{ email: "john@example.com", label: "John Doe" }]
 *
 * Used to compute per-user mention counts for published document revisions.
 */
export function extractMentionsFromHtml(html: string): ExtractedMention[] {
  const mentions: ExtractedMention[] = [];

  try {
    const ast = parseHtml(html);

    traverseNodes(ast, (node) => {
      if (node.type === SyntaxKind.Tag && node.name === "user-mention") {
        const emailAttr = node.attributes?.find((attr) => attr.name.value === "email");
        const email = emailAttr?.value?.value;

        if (email) {
          let label: string | undefined;

          if (node.body && node.body.length > 0) {
            const textNode = node.body.find((child) => child.type === SyntaxKind.Text);
            if (textNode && textNode.type === SyntaxKind.Text) {
              label = textNode.value.replace(/^@/, "").trim();
            }
          }

          mentions.push({
            email,
            label,
          });
        }
      }
    });
  } catch (error) {
    appLogger.error("Failed to parse HTML for mentions", { error });
  }

  return mentions;
}

/**
 * Recursively traverses the AST nodes
 */
function traverseNodes(nodes: HtmlNode[], callback: (node: HtmlNode) => void): void {
  for (const node of nodes) {
    callback(node);

    if (node.type === SyntaxKind.Tag && node.body) {
      traverseNodes(node.body, callback);
    }
  }
}

/**
 * Gets unique mentioned user emails from HTML content
 */
export function getUniqueMentionedEmails(html: string): string[] {
  const mentions = extractMentionsFromHtml(html);
  const uniqueEmails = new Set(mentions.map((m) => m.email));
  return Array.from(uniqueEmails);
}

function mentionEmail(node: HtmlTagNode): string | undefined {
  if (node.name !== "user-mention") return undefined;
  return node.attributes?.find((attr) => attr.name.value === "email")?.value?.value;
}

/**
 * The text around every mention, keyed by lowercased email — what a mention
 * notification quotes back so the recipient reads what they were pulled into.
 *
 * The excerpt is the innermost block the `<user-mention>` sits in, so a mention
 * in a list item quotes that item and not the whole list.
 */
export function getMentionContexts(html: string): Map<string, string[]> {
  const contexts = new Map<string, string[]>();

  const record = (email: string, node: HtmlTagNode) => {
    const text = htmlToPlainText(html.slice(node.start, node.end));
    if (!text) return;
    const key = email.trim().toLowerCase();
    const seen = contexts.get(key);
    if (!seen) contexts.set(key, [text]);
    else if (!seen.includes(text)) seen.push(text);
  };

  const visit = (nodes: HtmlNode[], block: HtmlTagNode | null) => {
    for (const node of nodes) {
      if (node.type !== SyntaxKind.Tag) continue;

      const email = mentionEmail(node);
      if (email) {
        record(email, block ?? node);
        continue;
      }

      if (node.body) {
        visit(node.body, BLOCK_TAGS.has(node.name.toLowerCase()) ? node : block);
      }
    }
  };

  try {
    visit(parseHtml(html), null);
  } catch (error) {
    appLogger.error("Failed to parse HTML for mention contexts", { error });
  }

  return contexts;
}
