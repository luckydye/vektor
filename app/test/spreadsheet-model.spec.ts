import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import init, { type Model } from "@ironcalc/wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDocumentTypeForContentType, prepareDocumentContent } from "#documents/content.ts";
import { createModel, toTableHtml } from "@vektorapp/spreadsheet/model";
import {
  cellsToHtmlTable,
  htmlTableToCells,
  htmlTableToCsv,
  rowsToHtmlTable,
} from "@vektorapp/spreadsheet/table";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await init({
    module_or_path: readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")),
  });
});

function stored(rows: string[][]): string {
  return rowsToHtmlTable(rows);
}

function values(model: Model, rows: number, columns: number): string[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) =>
      model.getFormattedCellValue(0, row + 1, column + 1),
    ),
  );
}

describe("htmlTable", () => {
  it("round-trips cells that contain the delimiters", () => {
    const rows = [
      ["name", "note"],
      ["comma", "a, b"],
      ["quote", 'say "hi"'],
      ["tab", "a\tb"],
      ["newline", "a\nb"],
      ["markup", "<b>&amp;</b>"],
    ];
    expect(
      htmlTableToCells(stored(rows))?.map((row) => row.map((cell) => cell.value)),
    ).toEqual(rows);
  });

  it("keeps a cell's source alongside its value", () => {
    const html = cellsToHtmlTable([
      [{ value: "total" }],
      [{ value: "42", source: "=SUM(A1:A2)" }],
    ]);
    expect(html).toContain('data-source="=SUM(A1:A2)"');
    expect(htmlTableToCells(html)?.[1]?.[0]).toEqual({
      value: "42",
      source: "=SUM(A1:A2)",
    });
  });

  it("reports no table rather than an empty one", () => {
    expect(htmlTableToCells("<p>not a table</p>")).toBeNull();
    expect(htmlTableToCsv("<p>not a table</p>")).toBeNull();
  });

  it("drops the source when flattening to csv, and quotes what needs it", () => {
    const html = cellsToHtmlTable([
      [{ value: "a" }, { value: "b, c" }],
      [{ value: "42", source: "=1+41" }, { value: "" }],
    ]);
    expect(htmlTableToCsv(html)).toBe('a,"b, c"\n42,');
  });

  it("collapses whitespace only when asked", () => {
    const html = "<table><tbody><tr><td>  a\n  b  </td></tr></tbody></table>";
    expect(htmlTableToCells(html)?.[0]?.[0]?.value).toBe("  a\n  b  ");
    expect(htmlTableToCells(html, { collapseWhitespace: true })?.[0]?.[0]?.value).toBe(
      "a b",
    );
  });
});

describe("spreadsheetModel", () => {
  it("loads a stored table into the grid", () => {
    const model = createModel(
      stored([
        ["name", "qty"],
        ["Widget", "42"],
        ["Gadget", "7"],
      ]),
      "Test",
    );
    expect(values(model, 3, 2)).toEqual([
      ["name", "qty"],
      ["Widget", "42"],
      ["Gadget", "7"],
    ]);
  });

  it("survives cells holding commas, quotes, tabs and newlines", () => {
    const rows = [["a, b"], ['say "hi"'], ["tab\there"], ["line\nbreak"]];
    const model = createModel(stored(rows), "Test");
    expect(values(model, rows.length, 1)).toEqual(rows);
  });

  it("keeps a formula as a formula across a save and reload", () => {
    const model = createModel(stored([["qty"], ["40"], ["2"]]), "Test");
    model.setUserInput(0, 4, 1, "=SUM(A2:A3)");
    model.evaluate();

    const saved = toTableHtml(model);
    expect(saved).toContain('data-source="=SUM(A2:A3)"');
    expect(saved).toContain(">42<");

    const reloaded = createModel(saved, "Test");
    expect(reloaded.getCellContent(0, 4, 1)).toBe("=SUM(A2:A3)");
    expect(reloaded.getFormattedCellValue(0, 4, 1)).toBe("42");
  });

  it("keeps a cell forced to text as text", () => {
    const model = createModel(stored([["code"]]), "Test");
    model.setUserInput(0, 2, 1, "'0012");
    model.evaluate();

    const reloaded = createModel(toTableHtml(model), "Test");
    expect(reloaded.getFormattedCellValue(0, 2, 1)).toBe("0012");
  });

  it("saves the same table again unchanged", () => {
    const model = createModel(
      stored([
        ["name", "qty"],
        ["Widget", "42"],
      ]),
      "Test",
    );
    model.setUserInput(0, 3, 1, "Gadget");
    model.setUserInput(0, 3, 2, "=B2*2");
    model.evaluate();

    const saved = toTableHtml(model);
    expect(toTableHtml(createModel(saved, "Test"))).toBe(saved);
  });

  it("grows the saved table to cover cells added past the loaded range", () => {
    const model = createModel(stored([["a"]]), "Test");
    model.setUserInput(0, 12, 5, "far away");
    model.evaluate();

    const cells = htmlTableToCells(toTableHtml(model));
    expect(cells).toHaveLength(12);
    expect(cells?.[11]).toHaveLength(5);
    expect(cells?.[11]?.[4]?.value).toBe("far away");
  });

  it("handles empty table markup", () => {
    const model = createModel("", "Test");
    expect(toTableHtml(model)).toBe("<table><tbody></tbody></table>");
  });
});

describe("CSV import", () => {
  const csv = "a,b\n1,2\n";
  const table = rowsToHtmlTable([
    ["a", "b"],
    ["1", "2"],
  ]);

  it("converts a csv upload", () => {
    expect(prepareDocumentContent(csv, "text/csv")).toBe(table);
  });

  it("imports csv uploads as normal documents", () => {
    expect(getDocumentTypeForContentType("text/csv; charset=utf-8")).toBe("document");
  });

  it("still converts markdown for a plain document", () => {
    expect(prepareDocumentContent("# Title", "text/markdown")).toContain("<h1>");
  });
});

describe("spreadsheetModel formatting", () => {
  const area = (row: number, column: number, width: number, height: number) => ({
    sheet: 0,
    row,
    column,
    width,
    height,
  });

  it("stores only what differs from the default style", () => {
    const model = createModel(stored([["a", "b"]]), "Test");
    model.updateRangeStyle(area(1, 1, 1, 1), "font.b", "true");

    const saved = toTableHtml(model);
    expect(saved).toContain(
      `data-style="${'{"font":{"b":true}}'.replace(/"/g, "&quot;")}"`,
    );
    expect(saved).toContain("<th>b</th>");
  });

  it("restores every kind of formatting across a save and reload", () => {
    const model = createModel(
      stored([
        ["a", "b"],
        ["1", "2"],
      ]),
      "Test",
    );
    model.updateRangeStyle(area(1, 1, 2, 1), "font.b", "true");
    model.updateRangeStyle(area(2, 1, 1, 1), "font.i", "true");
    model.updateRangeStyle(area(2, 1, 1, 1), "font.color", "#FF0000");
    model.updateRangeStyle(area(2, 2, 1, 1), "fill.color", "#FFCC00");
    model.updateRangeStyle(area(2, 2, 1, 1), "alignment.horizontal", "center");
    model.updateRangeStyle(area(2, 2, 1, 1), "num_fmt", "0.00%");
    model.updateRangeStyle(area(1, 1, 1, 1), "font.size", "18");

    const reloaded = createModel(toTableHtml(model), "Test");
    const style = (row: number, column: number) =>
      reloaded.getCellStyle(0, row, column).style;

    expect(style(1, 1).font.b).toBe(true);
    expect(style(1, 2).font.b).toBe(true);
    expect(style(1, 1).font.sz).toBe(18);
    expect(style(2, 1).font.i).toBe(true);
    expect(style(2, 1).font.color).toBe("#FF0000");
    expect(style(2, 2).fill.color).toBe("#FFCC00");
    expect(style(2, 2).alignment?.horizontal).toBe("center");
    expect(style(2, 2).num_fmt).toBe("0.00%");
  });

  it("keeps a style on a cell that has no value", () => {
    const model = createModel(stored([["a"]]), "Test");
    model.updateRangeStyle(area(4, 3, 1, 1), "fill.color", "#00FF00");

    const reloaded = createModel(toTableHtml(model), "Test");
    expect(reloaded.getCellStyle(0, 4, 3).style.fill.color).toBe("#00FF00");
    expect(reloaded.getFormattedCellValue(0, 4, 3)).toBe("");
  });

  it("restores column widths and row heights", () => {
    const model = createModel(
      stored([
        ["a", "b"],
        ["c", "d"],
      ]),
      "Test",
    );
    model.setColumnsWidth(0, 2, 2, 175);
    model.setRowsHeight(0, 2, 2, 40);

    const saved = toTableHtml(model);
    expect(saved).toContain('data-width="175"');
    expect(saved).toContain('data-height="40"');

    const reloaded = createModel(saved, "Test");
    expect(reloaded.getColumnWidth(0, 2)).toBe(175);
    expect(reloaded.getRowHeight(0, 2)).toBe(40);
  });

  it("writes no colgroup when every column is the default width", () => {
    const model = createModel(stored([["a", "b"]]), "Test");
    expect(toTableHtml(model)).not.toContain("colgroup");
  });

  it("saves a formatted document again unchanged", () => {
    const model = createModel(
      stored([
        ["a", "b"],
        ["1", "2"],
      ]),
      "Test",
    );
    model.updateRangeStyle(area(1, 1, 2, 1), "font.b", "true");
    model.updateRangeStyle(area(2, 2, 1, 1), "fill.color", "#FFCC00");
    model.setColumnsWidth(0, 1, 1, 140);

    const saved = toTableHtml(model);
    expect(toTableHtml(createModel(saved, "Test"))).toBe(saved);
  });

  it("ignores a data-style that is not usable JSON", () => {
    const html = '<table><tbody><tr><td data-style="{oops">x</td></tr></tbody></table>';
    expect(() => createModel(html, "Test")).not.toThrow();
    expect(createModel(html, "Test").getFormattedCellValue(0, 1, 1)).toBe("x");
  });
});
