import "@sv/elements/scroll";

customElements.define(
  "wiki-scroll",
  class ScrollElement extends HTMLElement {
    /** The unique name of the scroll container. Fallback is className + className of the parent element. */
    public name?: string;

    private fallbackName() {
      return `${this.className}-${this.parentElement?.className}`.replace(" ", ".");
    }

    attributeChangedCallback(name: string, oldValue: string, newValue: string) {
      if (name === "name") {
        this.name = newValue || this.fallbackName();
      }
    }

    constructor() {
      super();

      this.name = this.name || this.fallbackName();

      // stops scrolling the body if this container can't scroll
      this.addEventListener("wheel", (e) => {
        if (
          this.scrollTop + e.deltaY > 0 &&
          this.scrollTop + e.deltaY < this.scrollHeight - this.offsetHeight
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
      });

      setTimeout(() => {
        this.loadSavedScrollPosition();
      }, 250);

      window.addEventListener("astro:page-load", () => {
        this.loadSavedScrollPosition();
      });

      setInterval(() => {
        const storage = sessionStorage;
        if (this.name) storage.setItem(this.name, this.scrollTop.toString());
      }, 1000);
    }

    connectedCallback() {
      this.name = this.name || this.fallbackName();

      this.loadSavedScrollPosition();
    }

    loadSavedScrollPosition() {
      const storage = sessionStorage;

      if (storage && this.name) {
        const top = storage.getItem(this.name);
        if (top !== null) {
          this.scrollTop = Number.parseInt(top, 10);
        }

        window.addEventListener("beforeunload", () => {
          if (this.name) storage.setItem(this.name, this.scrollTop.toString());
        });
      }
    }
  },
);
