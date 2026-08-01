import { html, render } from "lit-html";
import { type IconName, iconMarkup } from "#components/Icon.tsx";
import { isMac } from "#utils/actions.ts";

/** Modifier keys that render as a glyph rather than their name. */
const KEY_ICONS: Record<string, IconName | undefined> = {
  meta: "cmd",
  cmd: "cmd",
  ctrl: "ctrl",
  shift: "shift",
};

customElements.define(
  "a-shortcut",
  class ShortcutElement extends HTMLElement {
    get shortcut() {
      return this.dataset.shortcut || "";
    }

    static get observedAttributes() {
      return ["data-shortcut"];
    }

    private root: ShadowRoot;

    attributeChangedCallback(_name: string, _oldValue: string, _newValue: string) {
      this.ariaLabel = `Shortcut: ${this.shortcut}`;
      render(this.render(), this.root);
    }

    connectedCallback() {
      render(this.render(), this.root);
    }

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
    }

    render() {
      const combinations = this.shortcut?.split(",").map((c) => c.trim());

      const prefferedCombination =
        combinations?.find((c) => isMac && c.includes("meta")) || combinations?.[0];

      const keys = prefferedCombination?.split("-").map((rawKey) => {
        // "mod" is the platform-aware modifier: Cmd on macOS, Ctrl elsewhere.
        const key = rawKey.toLowerCase() === "mod" ? (isMac ? "meta" : "ctrl") : rawKey;
        const icon = document.createElement("span");
        icon.className = "key";
        // Only modifiers have a glyph; everything else prints as its letter.
        const glyph = KEY_ICONS[key.toLowerCase()];
        icon.innerHTML = glyph ? iconMarkup(glyph) : key.toUpperCase();
        return icon;
      });

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
