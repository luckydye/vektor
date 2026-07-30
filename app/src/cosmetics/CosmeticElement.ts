import { getCosmeticAsset, subscribeCosmeticRegistry } from "./assetRegistry.ts";

const cosmeticElementTag = "vektor-cosmetic";

const styles = `
  :host {
    display: block;
    pointer-events: none;
    user-select: none;
  }

  :host([hidden]) {
    display: none;
  }

  span {
    display: block;
    width: 100%;
    height: 100%;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    transform-origin: 50% 80%;
  }

  :host([animated]) img {
    animation: cosmetic-float 1.8s ease-in-out infinite;
  }

  @keyframes cosmetic-float {
    0%, 100% { transform: translateY(0) rotate(-1deg); }
    50% { transform: translateY(-2px) rotate(1deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    :host([animated]) img {
      animation: none;
    }
  }
`;

const CosmeticElement =
  typeof HTMLElement === "undefined"
    ? undefined
    : class CosmeticElement extends HTMLElement {
        static observedAttributes = ["asset-id"];

        private readonly content: HTMLSpanElement;
        private unsubscribeRegistry: (() => void) | null = null;

        constructor() {
          super();
          const shadowRoot = this.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = styles;
          this.content = document.createElement("span");
          shadowRoot.append(style, this.content);
        }

        get assetId(): string | null {
          return this.getAttribute("asset-id");
        }

        set assetId(value: string | null) {
          if (value) {
            this.setAttribute("asset-id", value);
          } else {
            this.removeAttribute("asset-id");
          }
        }

        connectedCallback() {
          this.setAttribute("aria-hidden", "true");
          this.unsubscribeRegistry ??= subscribeCosmeticRegistry(() => this.render());
          this.render();
        }

        disconnectedCallback() {
          this.unsubscribeRegistry?.();
          this.unsubscribeRegistry = null;
        }

        attributeChangedCallback() {
          this.render();
        }

        private render() {
          const asset = getCosmeticAsset(this.assetId);
          this.toggleAttribute("animated", Boolean(asset?.animated));
          if (!asset) {
            this.content.replaceChildren();
            this.hidden = true;
            return;
          }

          const image = document.createElement("img");
          image.src = asset.src;
          image.alt = "";
          image.width = asset.width;
          image.height = asset.height;
          image.draggable = false;
          this.content.replaceChildren(image);
          this.hidden = false;
        }
      };

if (
  typeof customElements !== "undefined" &&
  CosmeticElement &&
  !customElements.get(cosmeticElementTag)
) {
  customElements.define(cosmeticElementTag, CosmeticElement);
}

export function createCosmeticElement(
  assetId: string | null | undefined,
): HTMLElement | null {
  if (!assetId || !getCosmeticAsset(assetId) || typeof document === "undefined") {
    return null;
  }
  const element = document.createElement(cosmeticElementTag);
  element.setAttribute("asset-id", assetId);
  return element;
}
