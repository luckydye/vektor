import { onInsets } from "#utils/insets.ts";

const tag = "title-bar";

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get(tag)
) {
  customElements.define(
    tag,
    class TitleBarElement extends HTMLElement {
      private label: HTMLElement | null = null;
      private observer: MutationObserver | null = null;
      private unsubscribeInsets: (() => void) | null = null;

      connectedCallback() {
        this.label = this.querySelector(".title-bar-label");
        if (!this.label) {
          this.label = document.createElement("span");
          this.label.className = "title-bar-label";
          this.append(this.label);
        }
        this.sync();

        // The overlay bar starts where the sidebar ends. Only the sidebar's own
        // width, not the full left inset: docked panels open inside the content
        // area and must not shift the window chrome.
        this.unsubscribeInsets = onInsets((insets) => {
          this.style.setProperty("--sidebar-inset", `${insets.sidebar}px`);
        });

        const title = document.querySelector("title");
        if (!title) return;
        this.observer = new MutationObserver(this.sync);
        this.observer.observe(title, { childList: true, characterData: true });
      }

      disconnectedCallback() {
        this.observer?.disconnect();
        this.observer = null;
        this.unsubscribeInsets?.();
        this.unsubscribeInsets = null;
      }

      private sync = () => {
        if (this.label) this.label.textContent = document.title;
      };
    },
  );
}
