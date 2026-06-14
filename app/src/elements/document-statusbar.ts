import { html, render } from "lit-html";
import { Actions } from "../utils/actions.ts";

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("document-statusbar")
) {
  customElements.define(
    "document-statusbar",
    class StatusbarElement extends HTMLElement {
      private unsubscribeActionsRegister: (() => void) | null = null;
      private unsubscribeActionsUnregister: (() => void) | null = null;

      constructor() {
        super();
        this.attachShadow({ mode: "open" });
      }

      connectedCallback() {
        window.addEventListener("document:edit", this.onEditorEvent);
        window.addEventListener("document:save", this.onEditorEvent);
        this.unsubscribeActionsRegister = Actions.subscribe(
          "actions:register",
          this.paint,
        );
        this.unsubscribeActionsUnregister = Actions.subscribe(
          "actions:unregister",
          this.paint,
        );
        this.paint();
      }

      disconnectedCallback() {
        window.removeEventListener("document:edit", this.onEditorEvent);
        window.removeEventListener("document:save", this.onEditorEvent);
        this.unsubscribeActionsRegister?.();
        this.unsubscribeActionsUnregister?.();
      }

      private onEditorEvent = (event: Event) => {
        if (event.type === "document:edit") {
          this.paint();
        }
      };

      private paint = () => {
        render(this.render(), this.shadowRoot);
      };

      private render() {
        const actions = [...Actions.group("edit"), ...Actions.group("formatting")];

        return html`
          <style>
            .container {
              pointer-events: auto;
            }
            a-shortcut {
              --background-color: transparent;
              color: var(--color-neutral-400);
              background: var(--color-neutral-50);
              border-radius: var(--radius-sm);
            }
            button:hover a-shortcut {
              color: var(--color-neutral-700);
              background-color: var(--color-neutral-50);
            }
            button {
              border: none;
              user-select: none;
              display: inline-flex;
              align-items: center;
              gap: 0.5rem;
              padding: 0.25rem 0.5rem;
              color: var(--color-neutral-400);
              background-color: var(--color-neutral-10);
              border-radius: var(--radius-md);
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
            ${actions.map(([id, action]) => {
              const shortcut = Actions.getShortcutsForAction(id)?.values().next()
                .value;

              if (!shortcut) return null;

              return html`
                <button
                  type="button"
                  @click=${() => {
                    Actions.run(id);
                  }}
                >
                  <a-shortcut data-shortcut=${shortcut}></a-shortcut>
                  ${action.title}
                </button>
              `;
            })}
          </div>
        `;
      }
    },
  );
}
