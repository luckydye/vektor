import { stripScriptTags } from "~/src/utils/utils.ts";

if (typeof customElements !== "undefined" && !customElements.get("html-block")) {
  customElements.define(
    "html-block",
    class extends HTMLElement {
      shadow: ShadowRoot | null = null;
      editmode: boolean = false;

      connectedCallback() {
        this.shadow = this.attachShadow({ mode: "open" });
        this.updateContent();
      }

      attributeChangedCallback(name: string, oldValue: string, newValue: string) {
        if (name === "data-html" && oldValue !== newValue) {
          this.updateContent();
        }
        if (name === "contenteditable") {
          this.editmode = this.hasAttribute("contenteditable");
          this.updateContent();
        }
      }

      static get observedAttributes() {
        return ["data-html", "data-html-encoding", "contenteditable"];
      }

      private updateContent() {
        if (!this.shadow) return;

        const encodedHtml = this.getAttribute("data-html") || "";
        let htmlString = encodedHtml;
        if (this.getAttribute("data-html-encoding") === "uri") {
          try {
            htmlString = decodeURIComponent(encodedHtml);
          } catch {
            htmlString = encodedHtml;
          }
        }

        const container = document.createElement("div");
        container.innerHTML = stripScriptTags(htmlString);
        container.contentEditable =
          this.getAttribute("contenteditable") === "true" ? "true" : "false";
        container.addEventListener("input", () => {
          const html = container.innerHTML;
          this.dispatchEvent(new CustomEvent("change", { detail: html }));
        });

        this.shadow.appendChild(container);
      }
    },
  );
}
