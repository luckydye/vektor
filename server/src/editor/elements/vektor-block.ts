import type { BlockInstance, BlockTypes } from "#editor/blocks.ts";
import "./html-block.ts";

/**
 * Read mode of a `customBlock`: "html" blocks render their sanitized markup,
 * other types their extension's `view`, or their title without one. Viewers and
 * share links load no extensions, so their blocks stay a neutral label.
 *
 * The registry is read off the `vektor` global the extension manager defines,
 * so the share page does not pull the manager in.
 */
function blockTypes(): BlockTypes | undefined {
  return (globalThis as { vektor?: { extensions: { blockTypes: BlockTypes } } }).vektor
    ?.extensions.blockTypes;
}

function propsOf(element: HTMLElement): unknown {
  const value = element.getAttribute("data-props");
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
}

class VektorBlockElement extends HTMLElement {
  private instance: BlockInstance;
  private unsubscribe: (() => void) | null = null;

  connectedCallback() {
    this.draw();
    window.addEventListener("extensions:loaded", this.draw);
  }

  disconnectedCallback() {
    window.removeEventListener("extensions:loaded", this.draw);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clear();
  }

  private clear() {
    this.instance?.destroy?.();
    this.instance = undefined;
    this.replaceChildren();
  }

  private draw = () => {
    this.clear();
    const id = this.getAttribute("data-block") ?? "html";
    const props = propsOf(this);

    if (id === "html") {
      const block = document.createElement("html-block");
      block.setAttribute("data-html", (props as { html?: string } | null)?.html ?? "");
      this.append(block);
      return;
    }

    const registry = blockTypes();
    if (registry && !this.unsubscribe) this.unsubscribe = registry.subscribe(this.draw);
    const type = registry?.get(id);
    if (type?.view) {
      this.instance = type.view(this, props);
      return;
    }
    const label = document.createElement("div");
    label.className = "custom-block__unknown";
    label.textContent = type?.title ?? id;
    this.append(label);
  };
}

if (typeof customElements !== "undefined" && !customElements.get("vektor-block")) {
  customElements.define("vektor-block", VektorBlockElement);
}
