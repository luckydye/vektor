import { describe, expect, it } from "bun:test";
import { readXlsxRows, writeXlsx } from "#utils/xlsx.ts";
import { unzipSync } from "#utils/zip.ts";

describe("xlsx", () => {
  it("round-trips typed values and exports the supported cell styles", () => {
    const bytes = writeXlsx([
      {
        name: "Styled data",
        rows: [
          [
            {
              text: "Heading",
              bold: true,
              italic: true,
              underline: true,
              color: "#1d4ed8",
              fill: "#dbeafe",
              fontName: "Arial",
              fontSize: 14,
              horizontal: "center",
            },
            { value: 42, fill: "green", horizontal: "right" },
            true,
          ],
        ],
      },
    ]);

    expect(readXlsxRows(bytes, { raw: true }).rows).toEqual([["Heading", 42, true]]);

    const styles = new TextDecoder().decode(unzipSync(bytes)["xl/styles.xml"]);
    expect(styles).toContain("<b/>");
    expect(styles).toContain("<i/>");
    expect(styles).toContain("<u/>");
    expect(styles).toContain('<color rgb="FF1D4ED8"/>');
    expect(styles).toContain('<fgColor rgb="FFDBEAFE"/>');
    expect(styles).toContain('<name val="Arial"/>');
    expect(styles).toContain('horizontal="center"');
  });
});
