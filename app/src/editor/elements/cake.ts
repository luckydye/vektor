import { render, html, svg } from "lit-html";

// Palette cycles through these colors for each slice
const COLORS = [
  "#4f8ef7",
  "#f7834f",
  "#4fc97a",
  "#f7d44f",
  "#b04ff7",
  "#f74f6e",
  "#4fd4f7",
  "#f74fb5",
];

customElements.define(
  "d-cake",
  class CakeElement extends HTMLElement {
    static get observedAttributes() {
      return ["data-data", "data-size", "data-colors"];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    // Returns [{value, color}] pairs with zero values removed, colors aligned to original indices
    get sliceData(): { value: number; color: string }[] {
      let values: number[] = [];
      let colors: string[] = [];
      try {
        const parsed = JSON.parse(this.dataset.data || "[]");
        if (Array.isArray(parsed)) values = parsed.map(Number);
      } catch {}
      try {
        const parsed = JSON.parse(this.dataset.colors || "[]");
        if (Array.isArray(parsed) && parsed.length > 0) colors = parsed;
      } catch {}

      return values
        .map((v, i) => ({ value: v, color: colors[i] ?? COLORS[i % COLORS.length] }))
        .filter(({ value }) => value > 0);
    }

    get size(): number {
      return Number(this.dataset.size) || 80;
    }

    connectedCallback() {
      render(this.renderEl(), this.shadowRoot!);
    }

    attributeChangedCallback() {
      render(this.renderEl(), this.shadowRoot!);
    }

    renderEl() {
      const sliceData = this.sliceData;
      const size = this.size;
      const r = size / 2;
      const cx = r;
      const cy = r;

      const ir = r * 0.45; // inner (hole) radius
      const total = sliceData.reduce((a, s) => a + s.value, 0);

      // Build SVG donut slices
      const slices: ReturnType<typeof svg>[] = [];

      if (sliceData.length === 1) {
        // Single value — full donut ring via evenodd
        slices.push(svg`
          <path
            fill-rule="evenodd"
            fill=${sliceData[0].color}
            d="M${cx},${cy - r} A${r},${r} 0 1,1 ${cx - 0.001},${cy - r} Z
               M${cx},${cy - ir} A${ir},${ir} 0 1,0 ${cx - 0.001},${cy - ir} Z"
          />
        `);
      } else {
        let startAngle = -Math.PI / 2;
        for (const { value, color } of sliceData) {
          const fraction = value / total;
          const endAngle = startAngle + fraction * 2 * Math.PI;
          const largeArc = fraction > 0.5 ? 1 : 0;

          const x1 = cx + r * Math.cos(startAngle);
          const y1 = cy + r * Math.sin(startAngle);
          const x2 = cx + r * Math.cos(endAngle);
          const y2 = cy + r * Math.sin(endAngle);
          const ix1 = cx + ir * Math.cos(startAngle);
          const iy1 = cy + ir * Math.sin(startAngle);
          const ix2 = cx + ir * Math.cos(endAngle);
          const iy2 = cy + ir * Math.sin(endAngle);

          slices.push(svg`
            <path
              d="M${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2}
                 L${ix2},${iy2} A${ir},${ir} 0 ${largeArc},0 ${ix1},${iy1} Z"
              fill=${color}
            />
          `);

          startAngle = endAngle;
        }
      }

      return html`
        <style>
          :host {
            display: inline-block;
            vertical-align: middle;
          }
          svg {
            display: block;
            border-radius: 50%;
            overflow: hidden;
          }
        </style>
        <svg
          width=${size}
          height=${size}
          viewBox="0 0 ${size} ${size}"
          xmlns="http://www.w3.org/2000/svg"
        >
          ${slices}
        </svg>
      `;
    }
  },
);
