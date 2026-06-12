import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { figmaClipboardToSVG } from "../src/utils/figma-clipboard.ts";

const html = readFileSync(
  join(import.meta.dir, "fixtures/figma-clipboard.html"),
  "utf8",
);

describe("figmaClipboardToSVG", () => {
  it("returns null for non-figma html", async () => {
    expect(await figmaClipboardToSVG("<div>hello</div>")).toBeNull();
  });

  it("renders the selected frame as an SVG of the root size", async () => {
    const svg = await figmaClipboardToSVG(html);
    expect(svg).not.toBeNull();
    // Root frame "Group 13" is 512×512.
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain('width="512" height="512"');
  });

  it("decodes VECTOR nodes into real path geometry, not rects", async () => {
    const svg = (await figmaClipboardToSVG(html))!;
    // Three white VECTOR shapes, each a <path>.
    const paths = svg.match(/<path /g) ?? [];
    expect(paths.length).toBe(3);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#ffffff"');
    // The only <rect> is the frame's background rectangle; the three vectors
    // are paths, never rect approximations.
    expect((svg.match(/<rect /g) ?? []).length).toBe(1);
  });

  it("produces the expected vertex coordinates (vector-network decode)", async () => {
    const svg = (await figmaClipboardToSVG(html))!;
    // Local anchor points that come straight out of the decoded blobs,
    // matching the reference export in fixtures/figma-svg.svg once the
    // parent <g> translates are applied.
    expect(svg).toContain("178.761 13.588"); // Vector 20
    expect(svg).toContain("36.256 2.937"); // Vector 21
    expect(svg).toContain("2.113 8.063"); // Vector 22
  });
});
