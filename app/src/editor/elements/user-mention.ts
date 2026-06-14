import { authClient } from "~/src/composeables/auth-client.ts";

// Custom element for user mentions in the editor.
// Renders @mentions with click handling and tooltip support.
if (typeof customElements !== "undefined" && !customElements.get("user-mention")) {
  customElements.define(
    "user-mention",
    class UserMentionElement extends HTMLElement {
      connectedCallback() {
        this.setAttribute("role", "button");
        this.setAttribute("tabindex", "0");

        this.addEventListener("click", this.handleClick);
        this.addEventListener("keydown", this.handleKeyDown);

        this.checkSelfMention();
      }

      async checkSelfMention() {
        const mentionEmail = this.getAttribute("email");
        if (!mentionEmail) return;

        try {
          const { data: session } = await authClient.getSession();
          if (session?.user?.email === mentionEmail) {
            this.setAttribute("data-self-mention", "true");
          }
        } catch {
          // Silently fail if we can't check.
        }
      }

      disconnectedCallback() {
        this.removeEventListener("click", this.handleClick);
        this.removeEventListener("keydown", this.handleKeyDown);
      }

      handleClick = (event: Event) => {
        event.preventDefault();
        const email = this.getAttribute("email");

        if (email) {
          this.dispatchEvent(
            new CustomEvent("mention-click", {
              detail: { email },
              bubbles: true,
              composed: true,
            }),
          );
        }
      };

      handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.handleClick(event);
        }
      };

      get email(): string | null {
        return this.getAttribute("email");
      }

      set email(value: string | null) {
        if (value) {
          this.setAttribute("email", value);
        } else {
          this.removeAttribute("email");
        }
      }
    },
  );
}
