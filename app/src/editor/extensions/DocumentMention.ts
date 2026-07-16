import { mergeAttributes, Node } from "@tiptap/core";

export const DocumentMention = Node.create({
  name: "documentMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      documentId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-document-id") ?? "",
        renderHTML: (attributes) => ({
          "data-document-id": attributes.documentId,
        }),
      },
      label: {
        default: "",
        parseHTML: (element) => element.textContent?.replace(/^@/, "") ?? "",
        renderHTML: () => ({}),
      },
      href: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-href") ?? "",
        renderHTML: (attributes) => ({
          "data-href": attributes.href,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "document-mention" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = node.attrs.label || node.attrs.documentId;
    return [
      "document-mention",
      mergeAttributes(HTMLAttributes, { contenteditable: "false" }),
      `@${label}`,
    ];
  },
});

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("document-mention")
) {
  customElements.define(
    "document-mention",
    class DocumentMentionElement extends HTMLElement {
      connectedCallback() {
        this.setAttribute("role", "link");
        this.setAttribute("tabindex", "0");
        this.addEventListener("click", this.handleClick);
        this.addEventListener("keydown", this.handleKeyDown);
      }

      disconnectedCallback() {
        this.removeEventListener("click", this.handleClick);
        this.removeEventListener("keydown", this.handleKeyDown);
      }

      private handleClick = (event: MouseEvent) => {
        if (event.button !== 0) return;
        this.openDocument(event);
      };

      private handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        this.openDocument(event);
      };

      private openDocument(event: Event) {
        const href = this.getAttribute("data-href");
        // `doc:` references are agent-only identifiers, not navigable URLs.
        if (!href || href.startsWith("doc:")) return;

        event.preventDefault();
        event.stopPropagation();
        window.open(href, "_blank", "noopener");
      }
    },
  );
}
