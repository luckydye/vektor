function createFigmaEmbedUrl(figmaUrl: string): string {
  return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(figmaUrl)}`;
}

if (typeof customElements !== "undefined" && !customElements.get("figma-embed")) {
  customElements.define(
    "figma-embed",
    class extends HTMLElement {
      connectedCallback() {
        const figmaUrl = this.dataset.figmaUrl;
        if (!figmaUrl) return;

        const height = this.getAttribute("height") || "450px";

        const shadow = this.attachShadow({ mode: "open" });
        shadow.innerHTML = `
          <style>
            :host {
              display: block;
              border: 1px solid #e5e7eb;
              border-radius: var(--radius-xl);
              overflow: hidden;
            }
          </style>
        `;

        const iframe = document.createElement("iframe");
        iframe.src = createFigmaEmbedUrl(figmaUrl);
        iframe.style.cssText = "width: 100%; height: 100%; display: block; border: none;";
        if (height) {
          iframe.style.height = `${height}px`;
        }
        iframe.setAttribute("allowfullscreen", "true");

        shadow.appendChild(iframe);
      }
    },
  );
}
