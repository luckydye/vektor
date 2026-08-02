import { Node } from "@tiptap/core";
import { nodeFromSpec } from "./specSchema.ts";

export const DocumentMention = Node.create({
  name: "documentMention",
  ...nodeFromSpec("documentMention"),
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
