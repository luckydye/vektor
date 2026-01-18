import { render, html } from "lit-html";
import * as ICON from "../../assets/icons.ts";

const OS = navigator.platform;

customElements.define(
  "a-shortcut",
  class ShortcutElement extends HTMLElement {
    get shortcut() {
      return this.dataset.shortcut || "";
    }

    static get observedAttributes() {
      return ["data-shortcut"];
    }

    attributeChangedCallback(name: string, oldValue: string, newValue: string) {
      this.ariaLabel = "Shortcut: " + this.shortcut;
      render(this.render(), this.shadowRoot);
    }

    connectedCallback() {
      render(this.render(), this.shadowRoot);
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    render() {
      const combinations = this.shortcut?.split(",").map((c) => c.trim());

      const prefferedCombination =
        combinations?.find((c) => OS === "MacIntel" && c.includes("meta")) ||
        combinations?.[0];

      const keys = prefferedCombination?.split("-").map(
        (key) => {
          const icon = document.createElement("span");
          icon.className = "key";
          icon.innerHTML = ICON[key.toLowerCase() + 'Icon'] || key.toUpperCase();
          return icon;
        },
      );

      return html`
        <style>
        :host {
          vertical-align: text-bottom;
          font-family: monospace;
          font-size: 1em;
          color: white;
          line-height: 100%;
          vertical-align: text-top;
          padding: 0.125em 0.33em;
          display: inline-flex;
          align-items: center;

          --background-color: #eee;
          --seperator: "";
        }
        .key {
            background-color: var(--background-color);
            line-height: 1.5em;
        }
        .spacer::after {
          content: var(--seperator);
          padding: 2px;
        }
        svg {
          width: 1.125em;
          height: 1.125em;
          vertical-align: text-bottom;
        }
        </style>

        ${keys?.map((key, index) =>
            index > 0 ? html`<span class="spacer"></span>${key}` : key,
        )}
      `;
    }
  },
);
