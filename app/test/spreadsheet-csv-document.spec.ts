import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import init, { type Model } from "@ironcalc/wasm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cellsToHtmlTable,
  htmlTableToCells,
  htmlTableToCsv,
  rowsToHtmlTable,
} from "#documents/htmlTable.ts";
import { createModel, toDocumentHtml } from "#spreadsheet/csvDocument.ts";

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
