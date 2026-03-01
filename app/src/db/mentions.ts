import * as html5parser from "html5parser";

export interface ExtractedMention {
  email: string;
  label?: string;
}

/**
 * Extracts user mentions from HTML content by parsing for <user-mention> elements
 *
 * This function is used to detect when users are mentioned in newly published documents,
 * triggering "mention" webhook events for each unique mentioned user.
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
 * Integration:
 *   - Called in createRevision() when a document is published (auto-publish on save)
 *   - Called in publishRevision() when manually publishing a revision
 *   - Triggers webhook events with type "mention" for each unique user
 *
 * Webhook payload example:
 *   {
 *     event: "mention",
 *     spaceId: "space-123",
 *     documentId: "doc-456",
 *     revisionId: 5,
 *     timestamp: "2024-01-15T10:30:00.000Z",
 *     data: {
 *       mentionedUser: "john@example.com",
 *       mentionedBy: "alice@example.com" // Only available in createRevision context
 *     }
 *   }
 */
export function extractMentionsFromHtml(html: string): ExtractedMention[] {
  const mentions: ExtractedMention[] = [];

  try {
    const ast = html5parser.parse(html);

    traverseNodes(ast, (node) => {
      if (node.type === html5parser.SyntaxKind.Tag && node.name === "user-mention") {
        const emailAttr = node.attributes?.find((attr) => attr.name.value === "email");
        const email = emailAttr?.value?.value;

        if (email) {
          let label: string | undefined;

          if (node.body && node.body.length > 0) {
            const textNode = node.body.find(
              (child) => child.type === html5parser.SyntaxKind.Text,
            );
            if (textNode && textNode.type === html5parser.SyntaxKind.Text) {
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
    console.error("Failed to parse HTML for mentions:", error);
  }

  return mentions;
}

/**
 * Recursively traverses the AST nodes
 */
function traverseNodes(
  nodes: html5parser.INode[],
  callback: (node: html5parser.INode) => void,
): void {
  for (const node of nodes) {
    callback(node);

    if (node.type === html5parser.SyntaxKind.Tag && node.body) {
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
