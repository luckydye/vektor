import { type Accessor, createSignal } from "solid-js";
import type { DocumentProperties } from "#documents/properties.ts";
import { propertyValueToText, readDocumentProperty } from "#documents/properties.ts";
import { type IcsEvent, parseIcsEvents } from "#utils/ics.ts";
import { parseCsvRows } from "#utils/xlsx.ts";
import type { DatabaseColumn } from "./useDatabaseRows.ts";
import { useToast } from "./useToast.ts";

interface DatabaseFileImportOptions {
  derivedColumns: Accessor<DatabaseColumn[]>;
  /** The rows already in the database, so an import cannot repeat one. */
  existingRows: Accessor<{ properties: DocumentProperties }[]>;
  addColumns: (columns: DatabaseColumn[]) => Promise<void>;
  addRow: (
    properties?: DocumentProperties,
    options?: { invalidate?: boolean },
  ) => Promise<unknown>;
  refreshRows: () => void;
}

interface ImportTable {
  columns: DatabaseColumn[];
  rows: string[][];
  titleIndex: number;
}

function normalizedHeader(value: string, index: number): string {
  return value.replace(/^﻿/, "").trim() || `Column ${index + 1}`;
}

function uniqueHeaders(headerRow: string[]): string[] {
  const counts = new Map<string, number>();
  return headerRow.map((header, index) => {
    const base = normalizedHeader(header, index);
    const nextCount = (counts.get(base.toLowerCase()) ?? 0) + 1;
    counts.set(base.toLowerCase(), nextCount);
    return nextCount === 1 ? base : `${base} ${nextCount}`;
  });
}

function titleHeaderIndex(headers: string[]): number {
  const titleIndex = headers.findIndex(
    (header) => header.trim().toLowerCase() === "title",
  );
  if (titleIndex >= 0) return titleIndex;
  return headers.findIndex((header) => header.trim().toLowerCase() === "name");
}

/**
 * Identifies a row by the values the import writes, so re-running a file adds
 * nothing. Sorted, trimmed and case-folded: column order in the file and
 * incidental whitespace do not make a new row.
 */
function rowFingerprint(properties: DocumentProperties, columns: string[]): string {
  return columns
    .map((column) => {
      const value = readDocumentProperty(properties, column);
      return `${column}=${(value ? propertyValueToText(value) : "").trim().toLowerCase()}`;
    })
    .sort()
    .join("\u0000");
}

function isEmptyCsvRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

function csvTable(text: string): ImportTable {
  const parsedRows = parseCsvRows(text);
  const headerRow = parsedRows.find((row) => !isEmptyCsvRow(row));
  if (!headerRow) throw new Error("CSV file is empty");

  const headerIndex = parsedRows.indexOf(headerRow);
  const headers = uniqueHeaders(headerRow);
  const rows = parsedRows.slice(headerIndex + 1).filter((row) => !isEmptyCsvRow(row));
  if (rows.length === 0) throw new Error("CSV has no rows to import");

  return {
    columns: headers.map((header) => ({ name: header, label: header, type: "text" })),
    rows,
    titleIndex: titleHeaderIndex(headers),
  };
}

interface IcsField {
  name: string;
  value: (event: IcsEvent) => string;
}

const icsFields: IcsField[] = [
  { name: "Title", value: (event) => event.summary },
  { name: "Start", value: (event) => event.start },
  { name: "End", value: (event) => event.end },
  { name: "All Day", value: (event) => (event.allDay ? "Yes" : "") },
  { name: "Location", value: (event) => event.location },
  { name: "Description", value: (event) => event.description },
  { name: "Status", value: (event) => event.status },
  { name: "Organizer", value: (event) => event.organizer },
  { name: "Attendees", value: (event) => event.attendees },
  { name: "Categories", value: (event) => event.categories },
  { name: "URL", value: (event) => event.url },
  { name: "Recurrence", value: (event) => event.recurrence },
  { name: "UID", value: (event) => event.uid },
];

/** `YYYY-MM-DD` fits the date cell editor; anything carrying a time does not. */
function isDateOnly(values: string[]): boolean {
  return (
    values.some(Boolean) &&
    values.every((value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value))
  );
}

function icsTable(text: string): ImportTable {
  const events = parseIcsEvents(text);
  if (events.length === 0) throw new Error("ICS file has no events to import");

  const columnValues = icsFields.map((field) => events.map(field.value));
  const usedIndexes = icsFields
    .map((_, index) => index)
    // Title anchors every row, so it stays even when no event has a summary.
    .filter((index) => index === 0 || columnValues[index].some((value) => value !== ""));

  return {
    columns: usedIndexes.map((index) => ({
      name: icsFields[index].name,
      label: icsFields[index].name,
      type:
        (icsFields[index].name === "Start" || icsFields[index].name === "End") &&
        isDateOnly(columnValues[index])
          ? "date"
          : "text",
    })),
    rows: events.map((_, rowIndex) =>
      usedIndexes.map((index) => columnValues[index][rowIndex]),
    ),
    titleIndex: 0,
  };
}

function isIcsFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".ics") || file.type === "text/calendar";
}

export function useDatabaseFileImport(options: DatabaseFileImportOptions) {
  const { show: showToast, update: updateToast } = useToast();
  const [isImporting, setIsImporting] = createSignal(false);

  async function importFile(file: File) {
    if (isImporting()) return;

    const format = isIcsFile(file) ? "ICS" : "CSV";
    let cancelled = false;
    const toastId = showToast(`Preparing ${format} import...`, "info", 0, {
      progress: 0,
      cancel: () => {
        cancelled = true;
      },
    });
    setIsImporting(true);
    let created = 0;
    let skipped = 0;
    let total = 0;

    try {
      const text = await file.text();
      const table = format === "ICS" ? icsTable(text) : csvTable(text);
      const { columns, rows, titleIndex } = table;
      total = rows.length;

      const existingColumns = new Set(
        options.derivedColumns().map((column) => column.name),
      );
      await options.addColumns(
        columns.filter(
          (column, index) => index !== titleIndex && !existingColumns.has(column.name),
        ),
      );

      // Fingerprints cover the file's own columns, so an existing row counts as
      // the same row even when it carries properties the file knows nothing of.
      const fingerprintColumns = columns.map((column) => column.name);
      const seen = new Set(
        options
          .existingRows()
          .map((row) => rowFingerprint(row.properties, fingerprintColumns)),
      );

      updateToast(toastId, { message: `0/${total} created..`, progress: 0 });

      for (const row of rows) {
        // Rows are created one request at a time, so cancelling keeps whatever
        // already landed and simply stops here.
        if (cancelled) break;

        const properties: DocumentProperties = {};
        let fallbackTitle = "";

        columns.forEach((column, index) => {
          const value = (row[index] ?? "").trim();
          if (!value) return;

          if (index === titleIndex) {
            properties.title = value;
            return;
          }

          properties[column.name] = value;
          if (!fallbackTitle) fallbackTitle = value;
        });

        // No usable column to name the row after leaves the title to `addRow`,
        // which fills in the placeholder.
        if (!properties.title && fallbackTitle) properties.title = fallbackTitle;

        const fingerprint = rowFingerprint(properties, fingerprintColumns);
        if (seen.has(fingerprint)) {
          skipped++;
          updateToast(toastId, {
            message: `${created}/${total} created..`,
            progress: (created + skipped) / total,
          });
          continue;
        }
        seen.add(fingerprint);

        await options.addRow(properties, { invalidate: false });
        created++;
        updateToast(toastId, {
          message: `${created}/${total} created..`,
          progress: (created + skipped) / total,
        });
      }

      options.refreshRows();
      updateToast(
        toastId,
        cancelled
          ? {
              message: `Import cancelled after ${created}/${total} ${
                created === 1 ? "row" : "rows"
              }`,
              type: "info",
              progress: undefined,
              cancel: undefined,
            }
          : {
              message: `Imported ${created} ${created === 1 ? "row" : "rows"}${
                skipped > 0 ? `, skipped ${skipped} duplicate` : ""
              }${skipped > 1 ? "s" : ""}`,
              type: "success",
              progress: 1,
              cancel: undefined,
            },
        { duration: 3000 },
      );
    } catch (e) {
      if (created > 0) {
        options.refreshRows();
      }
      const errorMessage = e instanceof Error ? e.message : `Failed to import ${format}`;
      updateToast(
        toastId,
        {
          message:
            total > 0 && created > 0
              ? `Imported ${created}/${total} rows before failing: ${errorMessage}`
              : errorMessage,
          type: "error",
          progress: 1,
          cancel: undefined,
        },
        { duration: 5000 },
      );
    } finally {
      setIsImporting(false);
    }
  }

  return {
    isImporting,
    importFile,
  };
}
