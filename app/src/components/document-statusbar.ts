import { html, render } from "lit-html";
import { type ActionOptions, Actions } from "#utils/actions.ts";

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
      private paintHandle: number | null = null;
      private root: ShadowRoot;

      constructor() {
        super();
        this.root = this.attachShadow({ mode: "open" });
      }

      connectedCallback() {
        window.addEventListener("document:save", this.onEditorEvent);
        // Selection and document changes decide which actions apply, so repaint
        // on every editor update.
        window.addEventListener("editor-update", this.paint);
        // editor-ready / editor-destroyed are dispatched on the view element and
        // don't bubble, so catch them on the way down.
        window.addEventListener("editor-ready", this.paint, true);
        window.addEventListener("editor-destroyed", this.paint, true);
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
        window.removeEventListener("document:save", this.onEditorEvent);
        window.removeEventListener("editor-update", this.paint);
        window.removeEventListener("editor-ready", this.paint, true);
        window.removeEventListener("editor-destroyed", this.paint, true);
        this.unsubscribeActionsRegister?.();
        this.unsubscribeActionsUnregister?.();
        if (this.paintHandle !== null) cancelAnimationFrame(this.paintHandle);
        this.paintHandle = null;
      }

      private onEditorEvent = (event: Event) => {
        if (event.type === "document:save") {
          this.paint();
        }
      };

      /**
       * Coalesced onto the next frame: editor events arrive while the
       * transaction is still being applied, and the Yjs UndoManager only
       * updates its stacks afterwards — painting synchronously reads a
       * `can().redo()` that is still false.
       */
      private paint = () => {
        if (this.paintHandle !== null) return;
        this.paintHandle = requestAnimationFrame(() => {
          this.paintHandle = null;
          render(this.render(), this.root);
        });
      };

      /** An action is listed only when it has a shortcut and currently applies. */
      private isListed(id: string, action: ActionOptions) {
        if (!Actions.getShortcutsForAction(id)) return false;
        return action.available?.() ?? true;
      }

      private render() {
        const actions = Actions.group("formatting").filter(([id, action]) =>
          this.isListed(id, action),
        );

        return html`
          <style>
            .container {
              pointer-events: auto;
              white-space: nowrap;
              margin-left: -0.5rem;
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
              const shortcut = Actions.getShortcutsForAction(id)?.values().next().value;

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
