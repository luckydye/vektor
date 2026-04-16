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

    get colors(): string[] {
      try {
        const parsed = JSON.parse(this.dataset.colors || "[]");
        if (!Array.isArray(parsed)) return COLORS;
        return parsed.length > 0 ? parsed : COLORS;
      } catch {
        return COLORS;
      }
    }

    get values(): number[] {
      try {
        const parsed = JSON.parse(this.dataset.data || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.map(Number).filter((n) => n > 0);
      } catch {
        return [];
      }
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
      const values = this.values;
      const colors = this.colors;
      const size = this.size;
      const r = size / 2;
      const cx = r;
      const cy = r;

      const total = values.reduce((a, b) => a + b, 0);

      // Build SVG pie slices
      const slices: ReturnType<typeof svg>[] = [];

      if (values.length === 1) {
        // Single value — full circle
        slices.push(svg`
          <circle cx=${cx} cy=${cy} r=${r} fill=${colors[0] ?? COLORS[0]} />
        `);
      } else {
        let startAngle = -Math.PI / 2;
        for (let i = 0; i < values.length; i++) {
          const fraction = values[i] / total;
          const endAngle = startAngle + fraction * 2 * Math.PI;

          const x1 = cx + r * Math.cos(startAngle);
          const y1 = cy + r * Math.sin(startAngle);
          const x2 = cx + r * Math.cos(endAngle);
          const y2 = cy + r * Math.sin(endAngle);
          const largeArc = fraction > 0.5 ? 1 : 0;

          slices.push(svg`
            <path
              d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z"
              fill=${colors[i % colors.length]}
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
