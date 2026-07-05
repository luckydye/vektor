import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { figmaClipboardToFrames, figmaClipboardToSVG } from "../src/utils/clipboard.ts";

const html = readFileSync(join(import.meta.dir, "fixtures/figma-clipboard.html"), "utf8");
const svgHtml = readFileSync(
  join(import.meta.dir, "fixtures/figma-clipboard-svg.html"),
  "utf8",
);
const complexHtml = readFileSync(
  join(import.meta.dir, "fixtures/figma-clipboard-complex.html"),
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

describe("figmaClipboardToFrames (HTML-entity-encoded clipboard)", () => {
  it("decodes when comment markers are HTML-entity-encoded in attribute values", async () => {
    // complexHtml uses &lt;!--(figmeta) / &lt;!--(figma) inside data-* attributes
    // instead of literal <!-- comment markers — as produced by some clipboard implementations.
    const frames = await figmaClipboardToFrames(complexHtml);
    expect(frames).not.toBeNull();
    expect(frames!.length).toBe(1);
    expect(frames![0].name).toBe("iPhone 16 Pro - 1");
    expect(frames![0].width).toBe(402);
    expect(frames![0].height).toBe(874);
  });

  it("renders INSTANCE nodes via their master SYMBOL children", async () => {
    const frames = (await figmaClipboardToFrames(complexHtml))!;
    const svg = frames[0].svg;
    // The design is built from component instances; without symbol resolution
    // no ink renders at all. With the fix, we get rects, paths, and text.
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThan(0);
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(0);
    expect((svg.match(/<text /g) ?? []).length).toBeGreaterThan(0);
  });
});

describe("figmaClipboardToFrames", () => {
  it("returns one frame per selected top-level node", async () => {
    const frames = (await figmaClipboardToFrames(html))!;
    expect(frames).not.toBeNull();
    // The fixture's selection is a single 512×512 frame "Group 13".
    expect(frames.length).toBe(1);
    expect(frames[0].name).toBe("Group 13");
    expect(frames[0].width).toBe(512);
    expect(frames[0].height).toBe(512);
    // Each frame's SVG is self-contained and sized to that frame.
    expect(frames[0].svg).toContain('viewBox="0 0 512 512"');
    expect(frames[0].svg).toContain("<path ");
  });

  it("scales vector vertices from normalizedSize to the node's render size", async () => {
    // "Group 27": two circles + a checkmark whose network is stored in a 10×7.7
    // normalized space but rendered at 26.67×20.54 (scale 2.6667×).
    const frames = (await figmaClipboardToFrames(svgHtml))!;
    expect(frames.length).toBe(1);
    const svg = frames[0].svg;
    expect(svg).toContain('viewBox="0 0 64 64"');
    // Both circles, concentric at the frame centre.
    expect(svg).toContain('cx="32" cy="32" rx="32" ry="32"');
    expect(svg).toContain('fill="#26522e"');
    expect(svg).toContain('fill="#6eb57f"');
    // Checkmark vertices, scaled into the node's 26.67-wide local space
    // (10 × 2.6667 ≈ 26.667). Without scaling these would top out near 10.
    expect(svg).toContain("L26.667 4.541");
    expect(svg).toContain('fill="#1c3f23"');
  });
});
