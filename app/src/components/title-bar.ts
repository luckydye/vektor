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

      connectedCallback() {
        this.label = this.querySelector(".title-bar-label");
        if (!this.label) {
          this.label = document.createElement("span");
          this.label.className = "title-bar-label";
          this.append(this.label);
        }
        this.sync();

        const title = document.querySelector("title");
        if (!title) return;
        this.observer = new MutationObserver(this.sync);
        this.observer.observe(title, { childList: true, characterData: true });
      }

      disconnectedCallback() {
        this.observer?.disconnect();
        this.observer = null;
      }

      private sync = () => {
        if (this.label) this.label.textContent = document.title;
      };
    },
  );
}
