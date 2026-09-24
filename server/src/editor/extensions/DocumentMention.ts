import { Node } from "@tiptap/core";
import { isSafeUrlValue } from "#utils/html.ts";
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

        // A mention only ever points at a document route on this origin, and
        // `data-href` is editor-supplied: anything else is a link wearing an
        // internal document's name.
        if (!isSafeUrlValue(href)) return;
        let target: URL;
        try {
          target = new URL(href, window.location.href);
        } catch {
          return;
        }
        if (target.origin !== window.location.origin) return;

        event.preventDefault();
        event.stopPropagation();
        window.open(target.href, "_blank", "noopener");
      }
    },
  );
}
