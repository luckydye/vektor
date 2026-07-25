/**
 * The one XLSX implementation. Reading, writing and the CSV helpers that sit
 * next to them all live here.
 *
 * We maintain this instead of depending on a library because the ecosystem has
 * nothing that is simultaneously maintained, dependency-free and able to write
 * styled cells: SheetJS is off-npm and paywalls styling, ExcelJS is inactive
 * and pulls ~10 packages. The two things we actually need — read a data grid,
 * write a formatted grid — are a small fraction of OOXML, so they are spelled
 * out below and the only dependency is `fflate` (via `#utils/zip.ts`) for the
 * ZIP container.
 *
 * Scope, deliberately: `.xlsx` (SpreadsheetML) and CSV. Legacy `.xls` (BIFF),
 * `.ods`, formulas (only their cached results are read), charts and images are
 * out. Values stay typed; date-formatted cells become UTC `Date`s on request.
 */

import { unzipSync, zipSync } from "#utils/zip.ts";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_EXCEL_CELL_LENGTH = 32767;
const MIN_COLUMN_WIDTH = 12;
const MAX_COLUMN_WIDTH = 60;
const DEFAULT_ROW_HEIGHT = 18;
const MAX_ROW_HEIGHT = 45;
const APPROX_PIXELS_PER_POINT = 4 / 3;
const APPROX_LINE_HEIGHT_PX = 18;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips XML-invalid control chars
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
  );
}

/** Reverses `escapeXml` plus the `_xHHHH_` escapes Excel writes for control chars. */
function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

/** Attributes of a single start tag, given the text between the name and `>`. */
function attributes(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tagBody.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

export function excelFileName(fileName: string): string {
  const baseName = fileName
    .replace(/\.[^.]+$/, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips filesystem-invalid control chars
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return `${baseName || "data"}.xlsx`;
}

export function sanitizeSheetName(name: string): string {
  return name
    .replace(/[\\/?*[\]:]/g, "_")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, 31);
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

/** `0 -> A`, `26 -> AA`. */
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

/** `"AB12" -> 27`. Returns null for a ref we cannot read. */
function columnIndex(ref: string | undefined): number | null {
  const letters = /^([A-Z]+)/.exec(ref ?? "")?.[1];
  if (!letters) return null;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

/** Named fills preserve the status colours used by the data-table export. */
export type ExcelCellFill = "red" | "yellow" | "green" | string;

export type ExcelCellAlignment = "left" | "center" | "right";
export type ExcelCellVerticalAlignment = "top" | "center" | "bottom";

/**
 * The styling surface supported by the XLSX writer. Colours accept `#RRGGBB`,
 * `RRGGBB`, `AARRGGBB`, or the named status fills (`red`, `yellow`, `green`).
 */
export interface ExcelCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Font colour. */
  color?: string;
  /** Cell background colour. */
  fill?: ExcelCellFill;
  fontName?: string;
  fontSize?: number;
  horizontal?: ExcelCellAlignment;
  vertical?: ExcelCellVerticalAlignment;
  /** Defaults to true, which is how exported tables have always behaved. */
  wrap?: boolean;
}

export type ExcelCellValue = string | number | boolean;

/** `text` is kept concise for display grids; use `value` for a styled typed cell. */
export type ExcelCell =
  | ExcelCellValue
  | ({ text?: string; value?: ExcelCellValue } & ExcelCellStyle);

export interface ExcelSheet {
  name: string;
  rows: ExcelCell[][];
}

type XlsxPart = {
  name: string;
  data: Uint8Array;
};

function isStyledCell(
  cell: ExcelCell,
): cell is { text?: string; value?: ExcelCellValue } & ExcelCellStyle {
  return typeof cell === "object";
}

function rawCellValue(cell: ExcelCell): ExcelCellValue {
  if (!isStyledCell(cell)) return cell;
  return cell.value ?? cell.text ?? "";
}

function cellValue(cell: ExcelCell): string {
  return String(rawCellValue(cell));
}

function cellFill(cell: ExcelCell): ExcelCellFill | undefined {
  return isStyledCell(cell) ? cell.fill : undefined;
}

type CellStyle = Required<Pick<ExcelCellStyle, "bold" | "italic" | "underline" | "wrap">> &
  Pick<ExcelCellStyle, "color" | "fill" | "fontName" | "fontSize" | "horizontal" | "vertical">;

const STATUS_FILL_COLORS: Record<string, string> = {
  red: "FFFEE2E2",
  yellow: "FFFEF3C7",
  green: "FFDCFCE7",
};

const STATUS_FONT_COLORS: Record<string, string> = {
  red: "FFDC2626",
  yellow: "FFB45309",
  green: "FF16A34A",
};

function normalizeColor(
  color: string | undefined,
  namedColors: Record<string, string>,
): string | undefined {
  if (!color) return undefined;
  const trimmed = color.trim();
  const named = namedColors[trimmed.toLowerCase()];
  if (named) return named;
  const hex = trimmed.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toUpperCase();
  return undefined;
}

function styleFor(cell: ExcelCell): CellStyle {
  if (!isStyledCell(cell)) {
    return { bold: false, italic: false, underline: false, wrap: true, vertical: "top" };
  }

  return {
    bold: cell.bold === true,
    italic: cell.italic === true,
    underline: cell.underline === true,
    color: normalizeColor(cell.color, STATUS_FONT_COLORS),
    fill: normalizeColor(cellFill(cell), STATUS_FILL_COLORS),
    fontName: cell.fontName?.trim() || undefined,
    fontSize:
      typeof cell.fontSize === "number" && Number.isFinite(cell.fontSize) && cell.fontSize > 0
        ? cell.fontSize
        : undefined,
    horizontal: cell.horizontal,
    vertical: cell.vertical ?? "top",
    wrap: cell.wrap !== false,
  };
}

function styleKey(style: CellStyle): string {
  return JSON.stringify(style);
}

type CompiledStyles = {
  indexFor: (cell: ExcelCell) => number;
  xml: string;
};

function compileStyles(sheets: ExcelSheet[]): CompiledStyles {
  const styles: CellStyle[] = [];
  const styleIndexes = new Map<string, number>();
  const addStyle = (style: CellStyle): number => {
    const key = styleKey(style);
    const existing = styleIndexes.get(key);
    if (existing !== undefined) return existing;
    const index = styles.length;
    styles.push(style);
    styleIndexes.set(key, index);
    return index;
  };

  // Keep the workbook's `Normal` style and font at index zero.
  addStyle({ bold: false, italic: false, underline: false, wrap: true, vertical: "top" });
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) addStyle(styleFor(cell));
    }
  }

  const fonts: Array<Pick<CellStyle, "bold" | "italic" | "underline" | "color" | "fontName" | "fontSize">> = [];
  const fontIndexes = new Map<string, number>();
  const fontIndex = (style: CellStyle): number => {
    const font = {
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      color: style.color,
      fontName: style.fontName,
      fontSize: style.fontSize,
    };
    const key = JSON.stringify(font);
    const existing = fontIndexes.get(key);
    if (existing !== undefined) return existing;
    const index = fonts.length;
    fonts.push(font);
    fontIndexes.set(key, index);
    return index;
  };

  const fills: Array<string | undefined> = [undefined, undefined];
  const fillIndexes = new Map<string, number>();
  const fillIndex = (fill: string | undefined): number => {
    if (!fill) return 0;
    const existing = fillIndexes.get(fill);
    if (existing !== undefined) return existing;
    const index = fills.length;
    fills.push(fill);
    fillIndexes.set(fill, index);
    return index;
  };

  const xfs = styles.map((style) => {
    const fontId = fontIndex(style);
    const fillId = fillIndex(style.fill);
    const alignment = [
      `vertical="${style.vertical ?? "top"}"`,
      style.horizontal ? `horizontal="${style.horizontal}"` : "",
      style.wrap ? 'wrapText="1"' : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyAlignment="1"><alignment ${alignment}/></xf>`;
  });

  const fontsXml = fonts
    .map((font) => {
      const properties = [
        font.bold ? "<b/>" : "",
        font.italic ? "<i/>" : "",
        font.underline ? "<u/>" : "",
        font.color ? `<color rgb="${font.color}"/>` : "",
        `<sz val="${font.fontSize ?? 11}"/>`,
        `<name val="${escapeXml(font.fontName ?? "Calibri")}"/>`,
      ].join("");
      return `<font>${properties}</font>`;
    })
    .join("");
  const fillsXml = fills
    .map((fill, index) => {
      if (index === 0) return '<fill><patternFill patternType="none"/></fill>';
      if (index === 1) return '<fill><patternFill patternType="gray125"/></fill>';
      return `<fill><patternFill patternType="solid"><fgColor rgb="${fill}"/><bgColor indexed="64"/></patternFill></fill>`;
    })
    .join("");

  return {
    indexFor: (cell) => styleIndexes.get(styleKey(styleFor(cell))) ?? 0,
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="${fonts.length}">${fontsXml}</fonts>
  <fills count="${fills.length}">${fillsXml}</fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };
}

function normalizedCellText(value: string): string {
  return String(value).slice(0, MAX_EXCEL_CELL_LENGTH);
}

function visibleTextLength(value: string): number {
  return value.split(/\r\n|\r|\n/).reduce((longest, line) => Math.max(longest, line.length), 0);
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

function worksheetXml(rows: ExcelCell[][], styles: CompiledStyles): string {
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
          const style = styles.indexFor(cell);
          const value = rawCellValue(cell);
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
          }
          if (typeof value === "boolean") {
            return `<c r="${ref}" t="b" s="${style}"><v>${value ? 1 : 0}</v></c>`;
          }
          const text = escapeXml(normalizedCellText(String(value)));
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

function textData(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

/** Build a styled workbook with inline strings and native number/boolean cells. */
export function writeXlsx(sheets: ExcelSheet[]): Uint8Array<ArrayBuffer> {
  const stylesRelId = `rId${sheets.length + 1}`;
  const styles = compileStyles(sheets);

  const contentTypeOverrides = sheets
    .map(
      (_, i) =>
        `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("\n");

  const sheetElements = sheets
    .map((s, i) => `    <sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("\n");

  const sheetRelationships = sheets
    .map(
      (_, i) =>
        `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("\n");

  const parts: XlsxPart[] = [
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
      data: textData(styles.xml),
    },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: textData(worksheetXml(sheet.rows, styles)),
    })),
  ];

  const files: Record<string, Uint8Array> = {};
  for (const part of parts) {
    files[part.name] = part.data;
  }
  return zipSync(files, { level: 6 });
}

export function downloadExcelRows(rows: ExcelCell[][], fileName: string): void {
  downloadExcelSheets([{ name: "Data", rows }], fileName);
}

export function downloadExcelSheets(sheets: ExcelSheet[], fileName: string): void {
  const blob = new Blob([writeXlsx(sheets)], { type: XLSX_MIME });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = excelFileName(fileName);
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Drops the parts of a format code that are literal text, leaving placeholders. */
function formatPlaceholders(code: string): string {
  return code
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
}

function isDateFormat(code: string): boolean {
  return /[ymdhs]/i.test(formatPlaceholders(code));
}

const XLSX_EPOCH_1900 = Date.UTC(1899, 11, 30);
const XLSX_EPOCH_1904 = Date.UTC(1904, 0, 1);
const MS_PER_DAY = 86400000;

/**
 * Excel serial to a UTC `Date`. Serials below 61 are shifted by a day because
 * the 1900 system pretends 1900-02-29 existed.
 */
function serialToDate(serial: number, date1904: boolean): Date {
  if (date1904) return new Date(Math.round(XLSX_EPOCH_1904 + serial * MS_PER_DAY));
  const epoch = serial > 59 ? XLSX_EPOCH_1900 : XLSX_EPOCH_1900 + MS_PER_DAY;
  return new Date(Math.round(epoch + serial * MS_PER_DAY));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

export type XlsxValue = string | number | boolean | Date | null;

export interface ReadXlsxOptions {
  /** Sheet name or zero-based index. Defaults to the first sheet. */
  sheet?: string | number;
  /** Accepted for the job-runtime API; values are always read without display formatting. */
  raw?: boolean;
  /** Turn date-formatted cells into `Date` (UTC) instead of serial numbers. */
  cellDates?: boolean;
  /** Keep rows where every cell is empty. Off by default. */
  blankRows?: boolean;
}

export interface XlsxRows {
  /** Name of the sheet that was read. */
  sheet: string;
  /** Every sheet in the workbook, in tab order. */
  sheets: string[];
  /** Row-major grid, padded so every row has the same length. */
  rows: XlsxValue[][];
}

type Workbook = {
  files: Record<string, Uint8Array>;
  /** Sheet name in tab order → worksheet part path. */
  sheets: Array<{ name: string; path: string }>;
  strings: string[];
  /** Style index → whether it encodes a date or time. */
  dateStyles: boolean[];
  date1904: boolean;
};

function partText(files: Record<string, Uint8Array>, path: string): string | undefined {
  const bytes = files[path];
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** Resolves a relationship target against the part that declared it. */
function resolveTarget(target: string, baseDir: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${baseDir}/${target}`.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    strings.push(match[1] === undefined ? "" : richText(match[1]));
  }
  return strings;
}

/** Concatenates the `<t>` runs of a shared or inline string, minus phonetics. */
function richText(inner: string): string {
  let text = "";
  for (const match of inner
    .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
    .matchAll(/<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    text += match[1] === undefined ? "" : decodeXml(match[1]);
  }
  return text;
}

function parseDateStyles(xml: string | undefined): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/>/g)) {
    const attrs = attributes(match[1]);
    custom.set(Number(attrs.numFmtId), attrs.formatCode ?? "");
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const dateStyles: boolean[] = [];
  for (const match of cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)) {
    const id = Number(attributes(match[1]).numFmtId ?? 0);
    dateStyles.push(BUILTIN_DATE_FORMAT_IDS.has(id) || isDateFormat(custom.get(id) ?? ""));
  }
  return dateStyles;
}

function parseWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes);
  const workbookXml = partText(files, "xl/workbook.xml");
  if (!workbookXml) throw new Error("not an xlsx file: xl/workbook.xml is missing");

  const rels = new Map<string, string>();
  const relsXml = partText(files, "xl/_rels/workbook.xml.rels") ?? "";
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, resolveTarget(attrs.Target, "xl"));
  }

  const sheets: Array<{ name: string; path: string }> = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = attributes(match[1]);
    const relId = attrs["r:id"] ?? attrs.id;
    sheets.push({
      name: attrs.name ?? `Sheet${sheets.length + 1}`,
      // Workbooks written without rels still follow the conventional layout.
      path: (relId && rels.get(relId)) || `xl/worksheets/sheet${sheets.length + 1}.xml`,
    });
  }

  return {
    files,
    sheets,
    strings: parseSharedStrings(partText(files, "xl/sharedStrings.xml")),
    dateStyles: parseDateStyles(partText(files, "xl/styles.xml")),
    date1904: /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbookXml),
  };
}

function readCell(
  attrs: Record<string, string>,
  body: string,
  workbook: Workbook,
  options: ReadXlsxOptions,
): XlsxValue {
  const type = attrs.t ?? "n";
  const text = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];

  if (type === "s") {
    const index = Number(text);
    return workbook.strings[index] ?? "";
  }
  if (type === "inlineStr") return richText(body);
  if (type === "str") return decodeXml(text ?? "");
  if (type === "b") return text === "1";
  // Error cells (#REF!, #N/A) carry no value we can hand to a consumer.
  if (type === "e") return null;
  if (type === "d") return options.cellDates ? new Date(text ?? "") : (text ?? null);

  if (text === undefined || text === "") return null;
  const value = Number(text);
  if (Number.isNaN(value)) return null;

  if (options.cellDates && workbook.dateStyles[Number(attrs.s ?? 0)]) {
    return serialToDate(value, workbook.date1904);
  }
  return value;
}

function readSheetRows(xml: string, workbook: Workbook, options: ReadXlsxOptions): XlsxValue[][] {
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? "";
  const grid: XlsxValue[][] = [];
  let width = 0;
  let nextRow = 0;

  for (const rowMatch of sheetData.matchAll(/<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = attributes(rowMatch[1] ?? rowMatch[2] ?? "");
    const rowIndex = rowAttrs.r ? Number(rowAttrs.r) - 1 : nextRow;
    nextRow = rowIndex + 1;

    const cells: XlsxValue[] = [];
    let nextColumn = 0;
    for (const cellMatch of (rowMatch[3] ?? "").matchAll(
      /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g,
    )) {
      const attrs = attributes(cellMatch[1] ?? cellMatch[2] ?? "");
      const column = columnIndex(attrs.r) ?? nextColumn;
      nextColumn = column + 1;
      // Cells are sparse in the file; the gaps become nulls when padding below.
      cells[column] = readCell(attrs, cellMatch[3] ?? "", workbook, options);
    }

    grid[rowIndex] = cells;
    width = Math.max(width, cells.length);
  }

  const rows: XlsxValue[][] = [];
  for (let i = 0; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    const row = Array.from({ length: width }, (_, column) => cells[column] ?? null);
    if (!options.blankRows && row.every((value) => value === null || value === "")) continue;
    rows.push(row);
  }
  return rows;
}

/**
 * Read one sheet of a workbook as a row grid.
 *
 * Also accepts CSV bytes — anything that is not a ZIP is decoded as UTF-8 text
 * and parsed as CSV, so callers holding a mixed bag of tabular uploads can use
 * one entry point.
 */
export function readXlsxRows(bytes: Uint8Array, options: ReadXlsxOptions = {}): XlsxRows {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    const rows = parseCsvRows(text).filter(
      (row) => options.blankRows || !row.every((cell) => cell === ""),
    );
    return { sheet: "Sheet1", sheets: ["Sheet1"], rows };
  }

  const workbook = parseWorkbook(bytes);
  const names = workbook.sheets.map((sheet) => sheet.name);
  const selected =
    typeof options.sheet === "string" && options.sheet
      ? workbook.sheets.find((sheet) => sheet.name === options.sheet)
      : typeof options.sheet === "number"
        ? workbook.sheets[options.sheet]
        : workbook.sheets[0];

  if (!selected) {
    throw new Error(
      `no sheet ${JSON.stringify(options.sheet ?? 0)}; have ${names.join(", ")}`,
    );
  }

  const xml = partText(workbook.files, selected.path);
  return {
    sheet: selected.name,
    sheets: names,
    rows: xml ? readSheetRows(xml, workbook, options) : [],
  };
}

/**
 * Flatten every sheet to plain text, for indexing and search. Cells are
 * tab-separated, rows newline-separated, sheets separated by a blank line.
 */
export function xlsxToText(bytes: Uint8Array): string {
  const workbook = parseWorkbook(bytes);
  const sheets: string[] = [];

  for (const sheet of workbook.sheets) {
    const xml = partText(workbook.files, sheet.path);
    if (!xml) continue;
    const rows = readSheetRows(xml, workbook, { cellDates: true });
    if (rows.length === 0) continue;
    sheets.push(
      rows
        .map((row) =>
          row
            .map((value) =>
              value == null ? "" : value instanceof Date ? value.toISOString() : String(value),
            )
            .join("\t")
            .trimEnd(),
        )
        .join("\n"),
    );
  }

  return sheets.join("\n\n");
}
