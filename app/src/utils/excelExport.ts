const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_EXCEL_CELL_LENGTH = 32767;
const MIN_COLUMN_WIDTH = 12;
const MAX_COLUMN_WIDTH = 60;
const DEFAULT_ROW_HEIGHT = 18;
const MAX_ROW_HEIGHT = 45;
const APPROX_PIXELS_PER_POINT = 4 / 3;
const APPROX_LINE_HEIGHT_PX = 18;

type ZipEntry = {
  name: string;
  data: Uint8Array;
};

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function excelFileName(fileName: string): string {
  const baseName = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return `${baseName || "data"}.xlsx`;
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

function columnName(index: number): string {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

export type ExcelCell = string | { text: string; bold?: boolean };

function cellValue(cell: ExcelCell): string {
  return typeof cell === "string" ? cell : cell.text;
}

function cellBold(cell: ExcelCell): boolean {
  return typeof cell === "object" && cell.bold === true;
}

function normalizedCellText(value: string): string {
  return String(value).slice(0, MAX_EXCEL_CELL_LENGTH);
}

function visibleTextLength(value: string): number {
  return value
    .split(/\r\n|\r|\n/)
    .reduce((longest, line) => Math.max(longest, line.length), 0);
}

function columnWidths(rows: ExcelCell[][]): number[] {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const longest = rows.reduce((maxLength, row) => {
      const cell = row[columnIndex] ?? "";
      return Math.max(maxLength, visibleTextLength(normalizedCellText(cellValue(cell))));
    }, 0);

    return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, longest + 2));
  });
}

function rowHeight(row: ExcelCell[], widths: number[]): number {
  const estimatedLines = Math.max(
    1,
    ...row.map((cell, columnIndex) => {
      const text = normalizedCellText(cellValue(cell));
      const explicitLines = text.split(/\r\n|\r|\n/);
      const width = Math.max(widths[columnIndex] ?? MAX_COLUMN_WIDTH, 1);
      return explicitLines.reduce(
        (lineCount, line) => lineCount + Math.max(1, Math.ceil(line.length / width)),
        0,
      );
    }),
  );
  const estimatedHeight = Math.round(
    (estimatedLines * APPROX_LINE_HEIGHT_PX) / APPROX_PIXELS_PER_POINT,
  );
  return Math.max(DEFAULT_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, estimatedHeight));
}

function worksheetXml(rows: ExcelCell[][]): string {
  const widths = columnWidths(rows);
  const colsXml = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");

  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => {
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          const text = escapeXml(normalizedCellText(cellValue(cell)));
          const style = cellBold(cell) ? "2" : "1";
          return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join("");

      return `<row r="${rowIndex + 1}" ht="${rowHeight(row, widths)}" customHeight="1">${cells}</row>`;
    })
    .join("");

  const columnCount = widths.length;
  const rowCount = Math.max(rows.length, 1);
  const dimension = `A1:${columnName(columnCount - 1)}${rowCount}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="${DEFAULT_ROW_HEIGHT}"/>
  <cols>${colsXml}</cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function textData(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const CRC_TABLE = new Uint32Array(
  Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return crc >>> 0;
  }),
);

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array {
  const data = new Uint8Array(2);
  new DataView(data.buffer).setUint16(0, value, true);
  return data;
}

function uint32(value: number): Uint8Array {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return data;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const data = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}

function createZip(entries: ZipEntry[]): Uint8Array {
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = textData(entry.name);
    const crc = crc32(entry.data);
    const localHeader = concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(entry.data.length),
      uint32(entry.data.length),
      uint16(name.length),
      uint16(0),
      name,
    ]);

    fileParts.push(localHeader, entry.data);

    centralParts.push(
      concat([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(crc),
        uint32(entry.data.length),
        uint32(entry.data.length),
        uint16(name.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        name,
      ]),
    );

    offset += localHeader.length + entry.data.length;
  }

  const centralDirectory = concat(centralParts);
  const endRecord = concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.length),
    uint32(offset),
    uint16(0),
  ]);

  return concat([...fileParts, centralDirectory, endRecord]);
}

export interface ExcelSheet {
  name: string;
  rows: ExcelCell[][];
}

export function sanitizeSheetName(name: string): string {
  return name
    .replace(/[\\/?*[\]:]/g, "_")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, 31);
}

function buildXlsx(sheets: ExcelSheet[]): Uint8Array {
  const stylesRelId = `rId${sheets.length + 1}`;

  const contentTypeOverrides = sheets
    .map((_, i) => `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("\n");

  const sheetElements = sheets
    .map((s, i) => `    <sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("\n");

  const sheetRelationships = sheets
    .map((_, i) => `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("\n");

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: textData(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${contentTypeOverrides}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      name: "_rels/.rels",
      data: textData(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: textData(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${sheetElements}
  </sheets>
</workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: textData(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRelationships}
  <Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    {
      name: "xl/styles.xml",
      data: textData(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">
      <alignment vertical="top" wrapText="1"/>
    </xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1">
      <alignment vertical="top" wrapText="1"/>
    </xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`),
    },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: textData(worksheetXml(sheet.rows)),
    })),
  ];

  return createZip(entries);
}

export function downloadExcelRows(rows: ExcelCell[][], fileName: string): void {
  downloadExcelSheets([{ name: "Data", rows }], fileName);
}

export function downloadExcelSheets(sheets: ExcelSheet[], fileName: string): void {
  const blob = new Blob([buildXlsx(sheets)], { type: XLSX_MIME });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = excelFileName(fileName);
  a.click();
  URL.revokeObjectURL(a.href);
}
