import { render, html } from "lit-html";
import { Actions, type ActionOptions } from "../../utils/actions.ts";

customElements.define(
  "document-statusbar",
  class StatusbarElement extends HTMLElement {
    connectedCallback() {
      window.addEventListener("document:edit", this.onEditorEvent);
      window.addEventListener("document:save", this.onEditorEvent);
    }

    disconnectedCallback() {
      window.removeEventListener("document:edit", this.onEditorEvent);
      window.removeEventListener("document:save", this.onEditorEvent);
    }

    onEditorEvent = (event: Event) => {
      if (event.type === "document:edit") {
        render(this.render(), this.shadowRoot);
      }
      if (event.type === "document:save") {
      }
    };

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    render() {
      const actions1 = Actions.group("edit");
      const actions2 = Actions.group("formatting");

      return html`
        <style>
            .container {
                pointer-events: auto;
            }
            a-shortcut {
                --background-color: transparent;
                
                color: black;
                background: var(--color-neutral-100);
                border-radius: var(--radius-sm);
            }
            button {
                border: none;
                user-select: none;
                display: inline-flex;
                align-items: center;
                gap: 0.5rem;
                padding: 0.25rem 0.5rem;
                color: var(--color-neutral-900);
                background-color: var(--color-neutral-10);
                border-radius: 0.5rem;
                transition: all 0.15s ease;
                font-weight: bold;
                font-size: 0.75rem;
                font-family: monospace;
            }
            button:hover {
                opacity: 1;
                color: var(--color-neutral-700);
                background-color: var(--color-neutral-100);
            }
            button:active {
                background-color: var(--color-neutral-200);
            }
        </style>

        <div class="container">
          ${[...actions1, ...actions2].map(([id, action]) => {
            const shortcut = Actions.getShortcutsForAction(id)?.values().next().value;

            if (shortcut) {
              return html`
                    <button type="button" @click=${() => {
                      Actions.run(id);
                    }}>
                        <a-shortcut data-shortcut=${shortcut}></a-shortcut>
                        ${action.title}
                    </button>
                `;
            }
          })}
        </div>
      `;
    }
  },
);
