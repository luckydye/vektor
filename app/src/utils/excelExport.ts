const EXCEL_HTML_MIME = "application/vnd.ms-excel;charset=utf-8";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function excelFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") + ".xls";
}

export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export function buildExcelHtml(rows: string[][]): string {
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
</head>
<body>
  <table>${body}</table>
</body>
</html>`;
}

export function downloadExcelRows(rows: string[][], fileName: string): void {
  const blob = new Blob([buildExcelHtml(rows)], { type: EXCEL_HTML_MIME });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = excelFileName(fileName);
  a.click();
  URL.revokeObjectURL(a.href);
}
