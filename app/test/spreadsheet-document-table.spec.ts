import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { contentExtensions } from "#editor/extensions.ts";
import {
  canConvertToSpreadsheet,
  isSpreadsheetTable,
  normalTableNodeFromSpreadsheet,
  spreadsheetTableData,
  spreadsheetTableNodeFromData,
} from "#spreadsheet/documentTable.ts";

const schema = getSchema(contentExtensions());

function tableFromHtml(html: string): Node {
  const doc = Node.fromJSON(schema, htmlToDoc(html));
  const table = doc.firstChild;
  if (!table || table.type.name !== "table") throw new Error("Expected a table");
  return table;
}

describe("spreadsheet tables inside documents", () => {
  it("reads computed values and engine metadata from a document table", () => {
    const table = tableFromHtml(
      '<table data-table-kind="spreadsheet"><tbody><tr data-height="32"><td data-source="=1+41" data-style="{&quot;font&quot;:{&quot;b&quot;:true}}"><p>42</p></td></tr></tbody></table>',
    );

    expect(isSpreadsheetTable(table)).toBe(true);
    expect(spreadsheetTableData(table)).toMatchObject({
      cells: [[{ value: "42", source: "=1+41", style: { font: { b: true } } }]],
      layout: { rowHeights: [32] },
    });
  });

  it("projects engine changes back to plain table paragraphs", () => {
    const table = tableFromHtml(
      '<table data-table-kind="spreadsheet"><tbody><tr><td><p>1</p></td></tr></tbody></table>',
    );
    const next = spreadsheetTableNodeFromData(table, schema, {
      cells: [
        [{ value: "Amount" }],
        [{ value: "42", source: "=40+2", style: { fill: { color: "#ffeeaa" } } }],
      ],
      layout: { columnWidths: [160], rowHeights: [undefined, 36] },
    });

    expect(next.childCount).toBe(2);
    expect(next.child(1).firstChild?.textContent).toBe("42");
    expect(next.child(1).firstChild?.attrs.dataSource).toBe("=40+2");
    expect(next.child(1).attrs.dataHeight).toBe(36);
  });

  it("only converts plain rectangular rich-text tables", () => {
    const plain = tableFromHtml(
      "<table><tbody><tr><td><p>plain</p></td></tr></tbody></table>",
    );
    const rich = tableFromHtml(
      "<table><tbody><tr><td><p><strong>rich</strong></p></td></tr></tbody></table>",
    );

    expect(canConvertToSpreadsheet(plain)).toBe(true);
    expect(canConvertToSpreadsheet(rich)).toBe(false);
  });

  it("flattens formulas to their displayed values when converted back", () => {
    const spreadsheet = tableFromHtml(
      '<table data-table-kind="spreadsheet"><tbody><tr><td data-source="=1+1"><p>2</p></td></tr></tbody></table>',
    );
    const table = normalTableNodeFromSpreadsheet(spreadsheet);

    expect(isSpreadsheetTable(table)).toBe(false);
    expect(table.firstChild?.firstChild?.attrs.dataSource).toBeNull();
    expect(table.textContent).toBe("2");
  });
});
