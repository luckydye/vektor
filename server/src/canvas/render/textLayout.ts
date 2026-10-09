/**
 * Rich text layout for painted text: blocks of styled runs are shaped with the
 * bundled fonts (advance plus GPOS kerning) and broken into lines the way CSS
 * does it, so a painted note wraps where its live editor will.
 */

import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import { parseColor, type Rgba } from "#canvas/render/webgl.ts";

export interface TextStyle {
  face: FontFace;
  size: number;
  color: string;
  underline?: boolean;
  strike?: boolean;
  /** Inline background, e.g. `code` or `mark`. */
  highlight?: string;
  href?: string;
}

/** `\n` is a hard line break; other whitespace is already normalised. */
export interface TextRun {
  text: string;
  style: TextStyle;
}

export interface BlockSpacing {
  marginTop: number;
  marginBottom: number;
  /** Left inset of the block's content. */
  indent: number;
  /** Multiplier of each run's font size. */
  lineHeight: number;
}

export type TextMarker =
  | { kind: "text"; text: string; style: TextStyle }
  | { kind: "checkbox"; checked: boolean; size: number; color: string; index: number };

export type TextBlock =
  | {
      kind: "text";
      runs: TextRun[];
      spacing: BlockSpacing;
      marker?: TextMarker;
      /** A padded box behind the block, e.g. a code block. */
      box?: { color: string; padding: number; radius: number };
      /** A bar 12px left of the block, e.g. a blockquote. */
      bar?: { color: string; width: number };
      /** `pre-wrap`: spaces are kept and only `\n` and the width break lines. */
      preserve?: boolean;
    }
  | { kind: "rule"; color: string; spacing: BlockSpacing }
  | { kind: "image"; src: string; spacing: BlockSpacing }
  | { kind: "row"; cells: TextRun[][]; border: string; spacing: BlockSpacing };

export interface LaidGlyph {
  face: FontFace;
  index: number;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  color: Rgba;
}

export interface LaidRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill?: Rgba;
  stroke?: Rgba;
  strokeWidth?: number;
}

export interface TextLayout {
  width: number;
  height: number;
  glyphs: LaidGlyph[];
  rects: LaidRect[];
  images: { src: string; x: number; y: number; width: number; height: number }[];
  checkboxes: { index: number; x: number; y: number; size: number }[];
  links: { href: string; x: number; y: number; width: number; height: number }[];
}

export interface LayoutOptions {
  /** Available width; `Infinity` lays every line out at its natural width. */
  width: number;
  /** Width over height of a loaded image, or null while it loads. */
  imageAspect: (src: string) => number | null;
}

interface ShapedChar {
  char: string;
  style: TextStyle;
  glyph: number;
  advance: number;
  space: boolean;
}

function shape(
  runs: readonly TextRun[],
  fonts: ReadonlyMap<FontFace, Font>,
): ShapedChar[] {
  const chars: ShapedChar[] = [];
  let previous: ShapedChar | null = null;
  for (const run of runs) {
    const font = fonts.get(run.style.face);
    if (!font) throw new Error(`Font ${run.style.face} is not loaded`);
    for (const char of run.text) {
      const glyph = font.glyphIndex(char.codePointAt(0) ?? 0);
      const shaped: ShapedChar = {
        char,
        style: run.style,
        glyph,
        advance: char === "\n" ? 0 : font.glyph(glyph).advance * run.style.size,
        space: char === " " || char === "\t",
      };
      if (previous && previous.style === run.style && char !== "\n") {
        previous.advance += font.kerning(previous.glyph, glyph) * run.style.size;
      }
      chars.push(shaped);
      previous = shaped;
    }
  }
  return chars;
}

interface Line {
  chars: ShapedChar[];
  width: number;
}

// Greedy breaking after spaces and hyphens; a word wider than the line breaks
// anywhere, like `overflow-wrap: break-word`.
function breakLines(chars: ShapedChar[], width: number, preserve: boolean): Line[] {
  const lines: Line[] = [];
  let line: ShapedChar[] = [];
  let lineWidth = 0;
  let breakAt = -1;

  const visibleWidth = (items: ShapedChar[]) => {
    let end = items.length;
    while (end > 0 && items[end - 1].space && !preserve) end--;
    let total = 0;
    for (let i = 0; i < end; i++) total += items[i].advance;
    return total;
  };
  const push = (items: ShapedChar[]) => {
    lines.push({ chars: items, width: visibleWidth(items) });
  };

  for (const char of chars) {
    if (char.char === "\n") {
      push(line);
      line = [];
      lineWidth = 0;
      breakAt = -1;
      continue;
    }
    if (line.length === 0 && char.space && !preserve) continue;
    if (lineWidth + char.advance > width && !char.space && line.length > 0) {
      if (breakAt >= 0) {
        const rest = line.slice(breakAt + 1);
        push(line.slice(0, breakAt + 1));
        line = rest;
      } else {
        push(line);
        line = [];
      }
      lineWidth = line.reduce((total, item) => total + item.advance, 0);
      breakAt = -1;
    }
    line.push(char);
    lineWidth += char.advance;
    if (char.space || char.char === "-") breakAt = line.length - 1;
  }
  push(line);
  return lines;
}

function lineMetrics(
  chars: readonly ShapedChar[],
  fallback: TextStyle,
  spacing: BlockSpacing,
  fonts: ReadonlyMap<FontFace, Font>,
) {
  let ascent = 0;
  let descent = 0;
  const styles = chars.length > 0 ? chars.map((char) => char.style) : [fallback];
  for (const style of styles) {
    const font = fonts.get(style.face);
    if (!font) throw new Error(`Font ${style.face} is not loaded`);
    // CSS half-leading: the line box is lineHeight × size, centred on the glyphs.
    const content = (font.ascender - font.descender) * style.size;
    const leading = (spacing.lineHeight * style.size - content) / 2;
    ascent = Math.max(ascent, font.ascender * style.size + leading);
    descent = Math.max(descent, -font.descender * style.size + leading);
  }
  return { ascent, descent };
}

export function layoutText(
  blocks: readonly TextBlock[],
  fonts: ReadonlyMap<FontFace, Font>,
  options: LayoutOptions,
): TextLayout {
  const layout: TextLayout = {
    width: 0,
    height: 0,
    glyphs: [],
    rects: [],
    images: [],
    checkboxes: [],
    links: [],
  };
  let y = 0;
  let previousMargin = 0;

  // Lays runs out at (x, top) within `width`, returning the height used.
  const flow = (
    runs: readonly TextRun[],
    x: number,
    top: number,
    width: number,
    spacing: BlockSpacing,
    preserve: boolean,
  ) => {
    const chars = shape(runs, fonts);
    const fallback = runs[0]?.style ?? {
      face: "regular" as const,
      size: 15,
      color: "#000",
    };
    let lineTop = top;
    let firstBaseline = top;
    for (const [lineIndex, line] of breakLines(chars, width, preserve).entries()) {
      const { ascent, descent } = lineMetrics(line.chars, fallback, spacing, fonts);
      const baseline = lineTop + ascent;
      if (lineIndex === 0) firstBaseline = baseline;
      let pen = x;
      let segmentStart = pen;
      let segmentStyle: TextStyle | null = null;
      const closeSegment = (end: number) => {
        const style = segmentStyle;
        if (!style || end <= segmentStart) return;
        const width = end - segmentStart;
        if (style.highlight) {
          layout.rects.push({
            x: segmentStart - 2,
            y: baseline - style.size * 0.95,
            width: width + 4,
            height: style.size * 1.25,
            radius: 3,
            fill: parseColor(style.highlight),
          });
        }
        const thickness = Math.max(1, style.size * 0.07);
        const color = parseColor(style.color);
        if (style.underline) {
          layout.rects.push({
            x: segmentStart,
            y: baseline + style.size * 0.12,
            width,
            height: thickness,
            radius: 0,
            fill: color,
          });
        }
        if (style.strike) {
          layout.rects.push({
            x: segmentStart,
            y: baseline - style.size * 0.3,
            width,
            height: thickness,
            radius: 0,
            fill: color,
          });
        }
        if (style.href) {
          layout.links.push({
            href: style.href,
            x: segmentStart,
            y: lineTop,
            width,
            height: ascent + descent,
          });
        }
      };
      for (const char of line.chars) {
        if (char.style !== segmentStyle) {
          closeSegment(pen);
          segmentStart = pen;
          segmentStyle = char.style;
        }
        if (!char.space) {
          layout.glyphs.push({
            face: char.style.face,
            index: char.glyph,
            x: pen,
            y: baseline,
            size: char.style.size,
            color: parseColor(char.style.color),
          });
        }
        pen += char.advance;
      }
      closeSegment(x + line.width);
      layout.width = Math.max(layout.width, x + line.width);
      lineTop += ascent + descent;
    }
    return { height: lineTop - top, firstBaseline };
  };

  for (const block of blocks) {
    const { spacing } = block;
    // The first block's top margin collapses away, like `:first-child { margin-top: 0 }`.
    if (block !== blocks[0]) y += Math.max(previousMargin, spacing.marginTop);
    const x = spacing.indent;
    const width = options.width - x;

    if (block.kind === "rule") {
      layout.rects.push({
        x,
        y,
        width,
        height: 1,
        radius: 0,
        fill: parseColor(block.color),
      });
      y += 1;
    } else if (block.kind === "image") {
      const aspect = options.imageAspect(block.src);
      const height = aspect ? width / aspect : 0;
      layout.images.push({ src: block.src, x, y, width, height });
      layout.width = Math.max(layout.width, x + width);
      y += height;
    } else if (block.kind === "row") {
      const cellWidth = width / Math.max(1, block.cells.length);
      let rowHeight = 0;
      for (const [index, cell] of block.cells.entries()) {
        const used = flow(
          cell,
          x + index * cellWidth + 6,
          y + 4,
          cellWidth - 12,
          spacing,
          false,
        );
        rowHeight = Math.max(rowHeight, used.height + 8);
      }
      for (let index = 0; index < block.cells.length; index++) {
        layout.rects.push({
          x: x + index * cellWidth,
          y,
          width: cellWidth,
          height: rowHeight,
          radius: 0,
          stroke: parseColor(block.border),
          strokeWidth: 1,
        });
      }
      y += rowHeight;
    } else {
      const padding = block.box?.padding ?? 0;
      const used = flow(
        block.runs,
        x + padding,
        y + padding,
        width - padding * 2,
        spacing,
        block.preserve === true,
      );
      const height = used.height + padding * 2;
      if (block.box) {
        layout.rects.unshift({
          x,
          y,
          width,
          height,
          radius: block.box.radius,
          fill: parseColor(block.box.color),
        });
      }
      if (block.bar) {
        layout.rects.push({
          x: x - 12,
          y,
          width: block.bar.width,
          height,
          radius: 0,
          fill: parseColor(block.bar.color),
        });
      }
      if (block.marker?.kind === "text") {
        // An outside list marker: right-aligned just before the first line.
        const { text, style } = block.marker;
        const chars = shape([{ text, style }], fonts);
        let pen =
          x - style.size * 0.4 - chars.reduce((sum, char) => sum + char.advance, 0);
        for (const char of chars) {
          if (!char.space) {
            layout.glyphs.push({
              face: style.face,
              index: char.glyph,
              x: pen,
              y: used.firstBaseline,
              size: style.size,
              color: parseColor(style.color),
            });
          }
          pen += char.advance;
        }
      } else if (block.marker?.kind === "checkbox") {
        const size = block.marker.size;
        const box = { x: x - size - 6, y: used.firstBaseline - size * 0.85, size };
        layout.rects.push({
          x: box.x,
          y: box.y,
          width: size,
          height: size,
          radius: 3,
          fill: block.marker.checked ? parseColor(block.marker.color) : undefined,
          stroke: parseColor(block.marker.color),
          strokeWidth: 1.25,
        });
        layout.checkboxes.push({ index: block.marker.index, ...box });
        if (block.marker.checked) {
          const style: TextStyle = { face: "bold", size: size * 0.8, color: "#ffffff" };
          const [tick] = shape([{ text: "✓", style }], fonts);
          layout.glyphs.push({
            face: style.face,
            index: tick.glyph,
            x: box.x + (size - tick.advance) / 2,
            y: box.y + size * 0.78,
            size: style.size,
            color: parseColor(style.color),
          });
        }
      }
      y += height;
    }
    previousMargin = spacing.marginBottom;
  }
  layout.height = y + previousMargin;
  return layout;
}
