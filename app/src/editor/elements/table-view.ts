const STYLES = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
  }

  .scroll {
    width: 100%;
    height: 100%;
    overflow: auto;
  }

  table {
    border-collapse: collapse;
    table-layout: fixed;
    width: max-content;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* Column-label row (A, B, C…) — frozen at top */
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
    overflow: hidden;
  }

  /* Column-header row (CSV field names) — frozen below col-labels */
  /* position:sticky makes this a containing block for .col-resize-handle */
  .col-headers th {
    position: sticky;
    top: 28px;
    z-index: 20;
    background: #f9fafb;
    /* right padding leaves room for the resize handle */
    padding: 4px 12px 4px 8px;
    font-weight: 600;
    color: #111827;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    height: 32px;
  }

  /* Row-number column — frozen at left; corner cells frozen on both axes */
  .col-labels th.row-num {
    position: sticky;
    left: 0;
    z-index: 30;
  }

  .col-headers th.row-num {
    position: sticky;
    top: 28px;
    left: 0;
    z-index: 30;
  }

  tbody .row-num {
    position: sticky;
    left: 0;
    z-index: 10;
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    text-align: center;
    font-size: 11px;
    color: #9ca3af;
    user-select: none;
    /* containing block for .row-resize-handle */
  }

  /* Body cells */
  tbody tr:nth-child(even) td { background: rgba(249, 250, 251, 0.5); }
  tbody tr:hover td { background: rgba(239, 246, 255, 0.5) !important; }
  tbody tr:hover .row-num { background: rgba(219, 234, 254, 0.5) !important; }

  tbody td {
    border: 1px solid #e5e7eb;
    padding: 4px 8px;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 0;
    height: 30px;
  }

  /* Resize handles */
  .col-resize-handle {
    position: absolute;
    right: 0;
    top: 0;
    height: 100%;
    width: 4px;
    cursor: col-resize;
    z-index: 1;
  }

  .col-resize-handle:hover,
  .col-resize-handle.resizing {
    background: #3b82f6;
  }

  .row-resize-handle {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: 4px;
    cursor: row-resize;
    z-index: 1;
  }

  .row-resize-handle:hover,
  .row-resize-handle.resizing {
    background: #3b82f6;
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
const MIN_COL_WIDTH = 40;
const MIN_ROW_HEIGHT = 20;

function render(html: string): string {
  const { headers, rows } = parseHtmlTable(html);

  const dataColCount = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  const colCount = Math.max(dataColCount, 26);
  const rowCount = Math.max(rows.length, 256);

  const colgroupHtml = `<colgroup>
    <col style="width:${ROW_NUM_WIDTH}px;min-width:${ROW_NUM_WIDTH}px" />
    ${Array.from({ length: colCount }, (_, i) => `<col data-col="${i}" style="width:${COL_WIDTH}px" />`).join("")}
  </colgroup>`;

  const colLabelsRow = `<tr class="col-labels">
    <th class="row-num"></th>
    ${Array.from({ length: colCount }, (_, i) => `<th>${colLabel(i)}</th>`).join("")}
  </tr>`;

  const colHeadersRow = `<tr class="col-headers">
    <th class="row-num"></th>
    ${headers.map((h, i) => `<th data-col-index="${i}" title="${escapeHtml(h)}">${escapeHtml(h)}<div class="col-resize-handle"></div></th>`).join("")}
    ${Array.from({ length: colCount - headers.length }, (_, i) => `<th data-col-index="${headers.length + i}"><div class="col-resize-handle"></div></th>`).join("")}
  </tr>`;

  const bodyRows = Array.from({ length: rowCount }, (_, ri) => {
    const row = rows[ri] ?? [];
    return `<tr>
      <td class="row-num">${ri + 1}<div class="row-resize-handle"></div></td>
      ${row.map((cell) => `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`).join("")}
      ${Array.from({ length: colCount - row.length }, () => `<td></td>`).join("")}
    </tr>`;
  }).join("");

  return `<div class="scroll">
    <table>
      ${colgroupHtml}
      <thead>${colLabelsRow}${colHeadersRow}</thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
}

export class TableViewElement extends HTMLElement {
  private wheelHandler: ((e: WheelEvent) => void) | null = null;
  private colDragCleanup: (() => void) | null = null;
  private rowDragCleanup: (() => void) | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
  }

  setContent(html: string) {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }

    this.colDragCleanup?.();
    this.rowDragCleanup?.();

    this.shadowRoot!.innerHTML = `<style>${STYLES}</style>${render(html)}`;

    const root = this.shadowRoot!;
    const scroll = root.querySelector<HTMLElement>(".scroll")!;
    const table = root.querySelector<HTMLTableElement>("table")!;

    if (this.wheelHandler) {
      this.removeEventListener("wheel", this.wheelHandler);
    }
    this.wheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      scroll.scrollLeft += e.deltaX;
      scroll.scrollTop += e.deltaY;
    };
    this.addEventListener("wheel", this.wheelHandler, { passive: false });

    // Column resizing
    {
      let activeHandle: HTMLElement | null = null;
      let startX = 0;
      let startWidth = 0;
      let colEl: HTMLElement | null = null;

      const onMouseMove = (e: MouseEvent) => {
        if (!colEl) return;
        const newWidth = Math.max(MIN_COL_WIDTH, startWidth + e.clientX - startX);
        colEl.style.width = `${newWidth}px`;
      };

      const onMouseUp = () => {
        activeHandle?.classList.remove("resizing");
        activeHandle = null;
        colEl = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      const onMouseDown = (e: MouseEvent) => {
        const handle = (e.target as HTMLElement).closest<HTMLElement>(".col-resize-handle");
        if (!handle) return;
        const th = handle.parentElement as HTMLElement;
        const colIndex = parseInt(th.dataset.colIndex ?? "0");
        // index 0 in querySelectorAll("col") is the row-num col; data cols start at 1
        colEl = table.querySelectorAll<HTMLElement>("col")[colIndex + 1] ?? null;
        if (!colEl) return;
        activeHandle = handle;
        startX = e.clientX;
        startWidth = colEl.offsetWidth;
        activeHandle.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
      };

      table.addEventListener("mousedown", onMouseDown);
      this.colDragCleanup = () => {
        table.removeEventListener("mousedown", onMouseDown);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
    }

    // Row resizing
    {
      let activeHandle: HTMLElement | null = null;
      let startY = 0;
      let startHeight = 0;
      let rowEl: HTMLElement | null = null;

      const onMouseMove = (e: MouseEvent) => {
        if (!rowEl) return;
        const newHeight = Math.max(MIN_ROW_HEIGHT, startHeight + e.clientY - startY);
        for (const td of rowEl.querySelectorAll<HTMLElement>("td")) {
          td.style.height = `${newHeight}px`;
        }
      };

      const onMouseUp = () => {
        activeHandle?.classList.remove("resizing");
        activeHandle = null;
        rowEl = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      const onMouseDown = (e: MouseEvent) => {
        const handle = (e.target as HTMLElement).closest<HTMLElement>(".row-resize-handle");
        if (!handle) return;
        const td = handle.parentElement as HTMLElement;
        rowEl = td.parentElement as HTMLElement;
        activeHandle = handle;
        startY = e.clientY;
        startHeight = td.offsetHeight;
        activeHandle.classList.add("resizing");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
      };

      table.addEventListener("mousedown", onMouseDown);
      this.rowDragCleanup = () => {
        table.removeEventListener("mousedown", onMouseDown);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
    }
  }

  disconnectedCallback() {
    if (this.wheelHandler) {
      this.removeEventListener("wheel", this.wheelHandler);
      this.wheelHandler = null;
    }
    this.colDragCleanup?.();
    this.rowDragCleanup?.();
  }
}

customElements.define("table-view", TableViewElement);
