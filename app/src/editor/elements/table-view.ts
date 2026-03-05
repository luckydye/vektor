const STYLES = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
    padding: 1rem;
  }

  .container {
    width: 100%;
    height: 100%;
    overflow: auto;
  }

  table {
    border-collapse: collapse;
    table-layout: fixed;
    min-width: max-content;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .col-labels th {
    position: sticky;
    top: 0;
    z-index: 20;
    background: #f3f4f6;
    text-align: center;
    font-size: 11px;
    font-weight: 500;
    color: #6b7280;
    padding: 2px 8px;
    height: 28px;
    user-select: none;
    white-space: nowrap;
  }

  .col-labels .row-num {
    position: sticky;
    left: 0;
    z-index: 30;
  }

  .col-headers th {
    position: sticky;
    top: 28px;
    z-index: 20;
    background: #f9fafb;
    padding: 4px 8px;
    font-weight: 600;
    color: #111827;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
    height: 32px;
  }

  .col-headers .row-num {
    position: sticky;
    left: 0;
    z-index: 30;
  }

  tbody tr:nth-child(even) td {
    background: rgba(249, 250, 251, 0.5);
  }

  tbody tr:hover td {
    background: rgba(239, 246, 255, 0.5) !important;
  }

  tbody td {
    border: 1px solid #e5e7eb;
    padding: 4px 8px;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
    height: 30px;
  }

  tbody .row-num {
    position: sticky;
    left: 0;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    text-align: center;
    font-size: 11px;
    color: #9ca3af;
    user-select: none;
    z-index: 10;
    width: 52px;
    min-width: 52px;
  }

  tbody tr:hover .row-num {
    background: rgba(219, 234, 254, 0.5) !important;
  }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function colLabel(index: number): string {
  let label = "";
  let i = index;
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

function parseHtmlTable(html: string): { headers: string[]; rows: string[][] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return { headers: [], rows: [] };

  const headers = Array.from(table.querySelectorAll("thead tr th")).map(
    (th) => th.textContent ?? "",
  );
  const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
  );

  return { headers, rows };
}

const COL_WIDTH = 160;
const ROW_NUM_WIDTH = 52;

function render(html: string): string {
  const { headers, rows } = parseHtmlTable(html);

  const dataColCount = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  const dataRowCount = rows.length;

  const colCount = Math.max(dataColCount, 26);
  const rowCount = Math.max(dataRowCount, 256);

  const colgroup = `
    <colgroup>
      <col style="width:${ROW_NUM_WIDTH}px;min-width:${ROW_NUM_WIDTH}px" />
      ${Array.from({ length: colCount }, () => `<col style="width:${COL_WIDTH}px;min-width:80px" />`).join("")}
    </colgroup>`;

  const colLabelsRow = `
    <tr class="col-labels">
      <th class="row-num"></th>
      ${Array.from({ length: colCount }, (_, i) => `<th>${colLabel(i)}</th>`).join("")}
    </tr>`;

  const colHeadersRow = `
    <tr class="col-headers">
      <th class="row-num"></th>
      ${headers.map((h) => `<th title="${escapeHtml(h)}">${escapeHtml(h)}</th>`).join("")}
      ${Array.from({ length: colCount - headers.length }, () => `<th></th>`).join("")}
    </tr>`;

  const bodyRows = Array.from({ length: rowCount }, (_, ri) => {
    const row = rows[ri] ?? [];
    return `
      <tr>
        <td class="row-num">${ri + 1}</td>
        ${row.map((cell) => `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`).join("")}
        ${Array.from({ length: colCount - row.length }, () => `<td></td>`).join("")}
      </tr>`;
  }).join("");

  return `
    <div class="container">
      <table>
        ${colgroup}
        <thead>${colLabelsRow}${colHeadersRow}</thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>`;
}

export class TableViewElement extends HTMLElement {
  private wheelHandler: ((e: WheelEvent) => void) | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
  }

  setContent(html: string) {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.shadowRoot!.innerHTML = `<style>${STYLES}</style>${render(html)}`;

    const container = this.shadowRoot!.querySelector<HTMLElement>(".container")!;

    if (this.wheelHandler) {
      this.removeEventListener("wheel", this.wheelHandler);
    }

    this.wheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      container.scrollLeft += e.deltaX;
      container.scrollTop += e.deltaY;
    };

    this.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  disconnectedCallback() {
    if (this.wheelHandler) {
      this.removeEventListener("wheel", this.wheelHandler);
      this.wheelHandler = null;
    }
  }
}

customElements.define("table-view", TableViewElement);
