import type { ComputedRef } from "vue";
import { ref } from "vue";
import type { DocumentPropertyValue } from "#utils/documentProperties.ts";
import { parseCsvRows } from "#utils/excelExport.ts";
import type { DatabaseColumn } from "./useDatabaseRows.ts";
import { useToast } from "./useToast.ts";

interface DatabaseCsvImportOptions {
  derivedColumns: ComputedRef<DatabaseColumn[]>;
  addColumns: (columns: DatabaseColumn[]) => Promise<void>;
  addRow: (
    properties?: Record<string, DocumentPropertyValue>,
    options?: { invalidate?: boolean },
  ) => Promise<unknown>;
  refreshRows: () => void;
}

function normalizedHeader(value: string, index: number): string {
  return value.replace(/^\ufeff/, "").trim() || `Column ${index + 1}`;
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

function isEmptyCsvRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

export function useDatabaseCsvImport(options: DatabaseCsvImportOptions) {
  const { show: showToast, update: updateToast } = useToast();
  const isImportingCsv = ref(false);

  async function importCsvFile(file: File) {
    if (isImportingCsv.value) return;

    const toastId = showToast("Preparing CSV import...", "info", 0, { progress: 0 });
    isImportingCsv.value = true;
    let created = 0;
    let total = 0;

    try {
      const text = await file.text();
      const parsedRows = parseCsvRows(text);
      const headerRow = parsedRows.find((row) => !isEmptyCsvRow(row));
      if (!headerRow) throw new Error("CSV file is empty");

      const headerIndex = parsedRows.indexOf(headerRow);
      const headers = uniqueHeaders(headerRow);
      const titleIndex = titleHeaderIndex(headers);
      const dataRows = parsedRows
        .slice(headerIndex + 1)
        .filter((row) => !isEmptyCsvRow(row));
      total = dataRows.length;
      if (total === 0) throw new Error("CSV has no rows to import");

      const existingColumns = new Set(
        options.derivedColumns.value.map((column) => column.name),
      );
      const columnsToAdd: DatabaseColumn[] = headers
        .filter((header, index) => index !== titleIndex && !existingColumns.has(header))
        .map((header) => ({ name: header, label: header, type: "text" }));

      await options.addColumns(columnsToAdd);

      updateToast(toastId, { message: `0/${total} created..`, progress: 0 });

      for (const row of dataRows) {
        const properties: Record<string, DocumentPropertyValue> = {};
        let fallbackTitle = "";

        headers.forEach((header, index) => {
          const value = (row[index] ?? "").trim();
          if (!value) return;

          if (index === titleIndex) {
            properties.title = value;
            return;
          }

          properties[header] = value;
          if (!fallbackTitle) fallbackTitle = value;
        });

        if (!properties.title) properties.title = fallbackTitle || "Untitled";

        await options.addRow(properties, { invalidate: false });
        created++;
        updateToast(toastId, {
          message: `${created}/${total} created..`,
          progress: created / total,
        });
      }

      options.refreshRows();
      updateToast(
        toastId,
        {
          message: `Imported ${created} ${created === 1 ? "row" : "rows"}`,
          type: "success",
          progress: 1,
        },
        { duration: 3000 },
      );
    } catch (e) {
      if (created > 0) {
        options.refreshRows();
      }
      const errorMessage = e instanceof Error ? e.message : "Failed to import CSV";
      updateToast(
        toastId,
        {
          message:
            total > 0 && created > 0
              ? `Imported ${created}/${total} rows before failing: ${errorMessage}`
              : errorMessage,
          type: "error",
          progress: 1,
        },
        { duration: 5000 },
      );
    } finally {
      isImportingCsv.value = false;
    }
  }

  return {
    isImportingCsv,
    importCsvFile,
  };
}
