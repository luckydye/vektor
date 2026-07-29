import "#cosmetics/CosmeticElement.ts";
import { selectToolIcon } from "~/src/assets/icons.ts";

const canvasPresenceCursorTag = "canvas-presence-cursor";

const styles = `
  :host {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 8;
    display: block;
    width: 0;
    height: 0;
    pointer-events: none;
    transition: transform 120ms linear;
  }

  :host(.is-instant) {
    transition: none;
  }

  [hidden] {
    display: none;
  }

  .cursor {
    position: absolute;
    left: -3px;
    top: -3px;
    width: 24px;
    height: 24px;
    color: var(--presence-color);
    transform: scaleX(-1);
    filter: drop-shadow(0 1px 1.5px rgba(15, 23, 42, 0.3));
  }

  .cursor svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .label {
    position: absolute;
    left: 14px;
    top: 16px;
    border-radius: 4px;
    background: var(--presence-color);
    padding: 3px 6px;
    color: var(--canvas-presence-text);
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: normal;
    white-space: nowrap;
  }

  .companion {
    position: absolute;
    left: 20px;
    top: -24px;
    width: 44px;
    height: 40px;
    filter: drop-shadow(0 2px 2px rgba(15, 23, 42, 0.2));
  }

  @media (prefers-reduced-motion: reduce) {
    :host {
      transition: none;
    }
  }
`;

const CanvasPresenceCursorElement =
  typeof HTMLElement === "undefined"
    ? undefined
    : class CanvasPresenceCursorElement extends HTMLElement {
        static observedAttributes = [
          "companion-id",
          "hide-label",
          "hide-pointer",
          "name",
        ];

        private readonly cursor: HTMLDivElement;
        private readonly label: HTMLSpanElement;
        private readonly companion: HTMLElement;

        constructor() {
          super();
          const shadow = this.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = styles;

          this.cursor = document.createElement("div");
          this.cursor.className = "cursor";
          this.cursor.innerHTML = selectToolIcon;

          this.label = document.createElement("span");
          this.label.className = "label";

          this.companion = document.createElement("vektor-cosmetic");
          this.companion.className = "companion";

          shadow.append(style, this.cursor, this.label, this.companion);
        }

        connectedCallback() {
          this.setAttribute("aria-hidden", "true");
          this.render();
        }

        attributeChangedCallback() {
          this.render();
        }

        private render() {
          const name = this.getAttribute("name")?.trim() ?? "";
          this.cursor.hidden = this.hasAttribute("hide-pointer");
          this.label.hidden = this.hasAttribute("hide-label") || !name;
          this.label.textContent = name;

          const companionId = this.getAttribute("companion-id")?.trim();
          if (companionId) {
            this.companion.setAttribute("asset-id", companionId);
          } else {
            this.companion.removeAttribute("asset-id");
          }
        }
      };

if (
  typeof customElements !== "undefined" &&
  CanvasPresenceCursorElement &&
  !customElements.get(canvasPresenceCursorTag)
) {
  customElements.define(canvasPresenceCursorTag, CanvasPresenceCursorElement);
}
