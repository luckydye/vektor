import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import init, { type Model } from "@ironcalc/wasm";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { toHtmlIfMarkdown } from "#documents/content.ts";
import {
  cellsToHtmlTable,
  htmlTableToCells,
  htmlTableToCsv,
  rowsToHtmlTable,
} from "#documents/htmlTable.ts";
import { createModel, toDocumentHtml } from "#spreadsheet/csvDocument.ts";
import {
  htmlFromSheetDoc,
  readCell,
  sheetDocFromHtml,
  sheetRows,
} from "#spreadsheet/sheetDoc.ts";

// `#spreadsheet/engine.ts` boots the engine from a Vite `?url` asset, which is a
// browser path. Here the module is handed the bytes directly.
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await init({
    module_or_path: readFileSync(require.resolve("@ironcalc/wasm/wasm_bg.wasm")),
  });
});

/** The stored markup for a grid of plain text, as a csv upload produces it. */
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

describe("csvDocument", () => {
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

    const saved = toDocumentHtml(model);
    expect(saved).toContain('data-source="=SUM(A2:A3)"');
    expect(saved).toContain(">42<");

    const reloaded = createModel(saved, "Test");
    expect(reloaded.getCellContent(0, 4, 1)).toBe("=SUM(A2:A3)");
    expect(reloaded.getFormattedCellValue(0, 4, 1)).toBe("42");
  });

  it("keeps a cell forced to text as text", () => {
    const model = createModel(stored([["code"]]), "Test");
    // The apostrophe is the spreadsheet convention for "this is text, not a
    // number" — without it `0012` would come back as 12.
    model.setUserInput(0, 2, 1, "'0012");
    model.evaluate();

    const reloaded = createModel(toDocumentHtml(model), "Test");
    expect(reloaded.getFormattedCellValue(0, 2, 1)).toBe("0012");
  });

  it("saves the same document again unchanged", () => {
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

    const saved = toDocumentHtml(model);
    expect(toDocumentHtml(createModel(saved, "Test"))).toBe(saved);
  });

  it("grows the saved table to cover cells added past the loaded range", () => {
    const model = createModel(stored([["a"]]), "Test");
    model.setUserInput(0, 12, 5, "far away");
    model.evaluate();

    const cells = htmlTableToCells(toDocumentHtml(model));
    expect(cells).toHaveLength(12);
    expect(cells?.[11]).toHaveLength(5);
    expect(cells?.[11]?.[4]?.value).toBe("far away");
  });

  it("handles a document with no table at all", () => {
    const model = createModel("", "Test");
    expect(toDocumentHtml(model)).toBe("<table><tbody></tbody></table>");
  });
});

describe("toHtmlIfMarkdown for csv documents", () => {
  const csv = "a,b\n1,2\n";
  const table = rowsToHtmlTable([
    ["a", "b"],
    ["1", "2"],
  ]);

  it("converts a csv upload", () => {
    expect(toHtmlIfMarkdown(csv, "text/csv")).toBe(table);
  });

  it("converts csv text sent without a useful content type", () => {
    // Creating a spreadsheet posts a JSON body; the content type describes the
    // envelope, so the document's type is what says the body is CSV.
    expect(toHtmlIfMarkdown(csv, "application/json", "csv")).toBe(table);
    expect(toHtmlIfMarkdown(csv, null, "csv")).toBe(table);
  });

  it("leaves an html body alone even when the document is a csv", () => {
    // Converting again would read the markup as CSV text and bury the whole
    // table inside one escaped cell.
    expect(toHtmlIfMarkdown(table, "text/html", "csv")).toBe(table);
    expect(toHtmlIfMarkdown(table, "text/html", "csv")).not.toContain("&lt;table&gt;");
  });

  it("still converts markdown for a plain document", () => {
    expect(toHtmlIfMarkdown("# Title", "text/markdown")).toContain("<h1>");
  });
});

describe("sheetDoc", () => {
  it("round-trips the stored markup through a collaborative document", () => {
    const original = cellsToHtmlTable(
      [
        [{ value: "name" }, { value: "qty", style: { font: { b: true } } }],
        [{ value: "Widget" }, { value: "42", source: "=SUM(B3:B4)" }],
      ],
      { columnWidths: [140, undefined], rowHeights: [undefined, 40] },
    );

    expect(htmlFromSheetDoc(sheetDocFromHtml(original))).toBe(original);
  });

  it("puts each cell under its own key, so peers do not collide", () => {
    const doc = sheetDocFromHtml(
      rowsToHtmlTable([
        ["a", "b"],
        ["c", "d"],
      ]),
    );
    const rows = sheetRows(doc);
    expect(rows.length).toBe(2);
    expect(readCell(rows.get(0) as never, 0)?.v).toBe("a");
    expect(readCell(rows.get(1) as never, 1)?.v).toBe("d");
  });

  it("merges concurrent edits to different cells", () => {
    const base = sheetDocFromHtml(
      rowsToHtmlTable([
        ["a", "b"],
        ["c", "d"],
      ]),
    );

    // Two peers that start from the same state and never see each other's edit
    // until they exchange updates.
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(base));

    (sheetRows(peerA).get(0) as Y.Map<unknown>).set("0", { v: "from A" });
    (sheetRows(peerB).get(1) as Y.Map<unknown>).set("1", { v: "from B" });

    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(peerB));
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA));

    for (const peer of [peerA, peerB]) {
      expect(readCell(sheetRows(peer).get(0) as never, 0)?.v).toBe("from A");
      expect(readCell(sheetRows(peer).get(1) as never, 1)?.v).toBe("from B");
    }
    expect(htmlFromSheetDoc(peerA)).toBe(htmlFromSheetDoc(peerB));
  });

  it("keeps a row insert from one peer alongside an edit from another", () => {
    const base = sheetDocFromHtml(rowsToHtmlTable([["a"], ["b"]]));
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(base));

    const inserted = new Y.Map<unknown>();
    inserted.set("0", { v: "inserted" });
    sheetRows(peerA).insert(1, [inserted]);
    (sheetRows(peerB).get(1) as Y.Map<unknown>).set("0", { v: "edited" });

    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(peerB));
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA));

    // The row keeps its identity through the insert, so B's edit lands on the
    // row it was made on rather than on whatever ends up at that index.
    const values = (doc: Y.Doc) => sheetRows(doc).map((row) => readCell(row, 0)?.v ?? "");
    expect(values(peerA)).toEqual(["a", "inserted", "edited"]);
    expect(values(peerA)).toEqual(values(peerB));
  });

  it("leaves an empty cell out rather than storing a blank", () => {
    const doc = sheetDocFromHtml(rowsToHtmlTable([["a", "", "c"]]));
    const row = sheetRows(doc).get(0) as Y.Map<unknown>;
    expect([...row.keys()].sort()).toEqual(["0", "2"]);
    // It still comes back as a cell, so the table stays rectangular.
    expect(htmlFromSheetDoc(doc)).toBe(
      "<table><thead><tr><th>a</th><th></th><th>c</th></tr></thead><tbody></tbody></table>",
    );
  });
});

describe("csvDocument formatting", () => {
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

    const saved = toDocumentHtml(model);
    // The whole style is ~130 bytes of defaults; only the difference is kept.
    expect(saved).toContain(
      `data-style="${'{"font":{"b":true}}'.replace(/"/g, "&quot;")}"`,
    );
    // The untouched neighbour carries no style at all.
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

    const reloaded = createModel(toDocumentHtml(model), "Test");
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

    const reloaded = createModel(toDocumentHtml(model), "Test");
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

    const saved = toDocumentHtml(model);
    expect(saved).toContain('data-width="175"');
    expect(saved).toContain('data-height="40"');

    const reloaded = createModel(saved, "Test");
    expect(reloaded.getColumnWidth(0, 2)).toBe(175);
    expect(reloaded.getRowHeight(0, 2)).toBe(40);
  });

  it("writes no colgroup when every column is the default width", () => {
    const model = createModel(stored([["a", "b"]]), "Test");
    expect(toDocumentHtml(model)).not.toContain("colgroup");
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

    const saved = toDocumentHtml(model);
    expect(toDocumentHtml(createModel(saved, "Test"))).toBe(saved);
  });

  it("ignores a data-style that is not usable JSON", () => {
    const html = '<table><tbody><tr><td data-style="{oops">x</td></tr></tbody></table>';
    expect(() => createModel(html, "Test")).not.toThrow();
    expect(createModel(html, "Test").getFormattedCellValue(0, 1, 1)).toBe("x");
  });
});
