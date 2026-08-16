// Figma Embed Kit 2.0: the file URL with `www` swapped for `embed`, plus the
// required `embed-host`. `page-selector` and `footer` off strip Figma's own top
// bar and bottom bar so the embed shows only the canvas.
function createFigmaEmbedUrl(figmaUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(figmaUrl);
  } catch {
    return null;
  }
  url.hostname = "embed.figma.com";
  url.searchParams.set("embed-host", "vektor");
  url.searchParams.set("page-selector", "false");
  url.searchParams.set("footer", "false");
  return url.toString();
}

if (typeof customElements !== "undefined" && !customElements.get("figma-embed")) {
  customElements.define(
    "figma-embed",
    class extends HTMLElement {
      connectedCallback() {
        const figmaUrl = this.dataset.figmaUrl;
        if (!figmaUrl) return;

        const src = createFigmaEmbedUrl(figmaUrl);
        if (!src) return;

        // Read mode renders the height as an attribute; edit mode sets it as an
        // inline style on the host, which wins over this `:host` rule.
        const height = Number(this.getAttribute("height")) || 450;

        const shadow = this.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>
:host {
  display: block;
  height: ${height}px;
  border: 1px solid #e5e7eb;
  border-radius: var(--radius-xl);
  overflow: hidden;
}
iframe {
  width: 100%;
  height: 100%;
  display: block;
  border: none;
}
</style>`;

        const iframe = document.createElement("iframe");
        iframe.src = src;
        iframe.setAttribute("allowfullscreen", "true");

        shadow.appendChild(iframe);
      }
    },
  );
}

// Side-effect module: the empty export is what makes it a module rather than a
// script, which `import "…"` requires.
export {};
