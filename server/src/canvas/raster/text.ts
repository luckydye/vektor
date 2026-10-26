/**
 * Text for the server: the bundled faces read from disk, and markdown turned
 * into the layout engine's blocks the way the client's rich-text path styles
 * them, so measured and drawn text matches what the canvas paints.
 */

import { type Token, type Tokens, marked } from "marked";
import boldPath from "#assets/fonts/Inter-Bold.ttf" with { type: "file" };
import boldItalicPath from "#assets/fonts/Inter-BoldItalic.ttf" with { type: "file" };
import italicPath from "#assets/fonts/Inter-Italic.ttf" with { type: "file" };
import regularPath from "#assets/fonts/Inter-Regular.ttf" with { type: "file" };
import semiboldPath from "#assets/fonts/Inter-SemiBold.ttf" with { type: "file" };
import monoPath from "#assets/fonts/JetBrainsMono-Regular.ttf" with { type: "file" };
import { type Font, parseFont } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import {
  type BlockSpacing,
  layoutText,
  type TextBlock,
  type TextLayout,
  type TextRun,
  type TextStyle,
} from "#canvas/render/textLayout.ts";

const FONT_PATHS: Record<FontFace, string> = {
  regular: regularPath,
  italic: italicPath,
  semibold: semiboldPath,
  bold: boldPath,
  boldItalic: boldItalicPath,
  mono: monoPath,
};

let fonts: Map<FontFace, Font> | null = null;

/** Every face, parsed once per process. */
export async function serverFonts(): Promise<ReadonlyMap<FontFace, Font>> {
  if (fonts) return fonts;
  const loaded = new Map<FontFace, Font>();
  for (const [face, path] of Object.entries(FONT_PATHS) as [FontFace, string][]) {
    loaded.set(face, parseFont(await Bun.file(path).arrayBuffer()));
  }
  fonts = loaded;
  return loaded;
}

export interface MarkdownTheme {
  size: number;
  color: string;
  align?: "start" | "center" | "end";
  /** Space above a paragraph after another block, in em, as `RichTextTheme.paragraphGap`. */
  paragraphGap?: number;
}

const LINE_HEIGHT = 1.35;
const HEADINGS = [1.75, 1.4, 1.2, 1.05, 1, 1];

function inlineRuns(tokens: readonly Token[], style: TextStyle, runs: TextRun[]) {
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        inlineRuns((token as Tokens.Strong).tokens, { ...style, face: style.face === "italic" ? "boldItalic" : "bold" }, runs);
        break;
      case "em":
        inlineRuns((token as Tokens.Em).tokens, { ...style, face: style.face === "bold" ? "boldItalic" : "italic" }, runs);
        break;
      case "del":
        inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }, runs);
        break;
      case "link":
        inlineRuns((token as Tokens.Link).tokens, { ...style, color: "#2563eb", underline: true }, runs);
        break;
      case "codespan":
        runs.push({
          text: (token as Tokens.Codespan).text,
          style: { ...style, face: "mono", highlight: "rgba(15, 23, 42, 0.08)" },
        });
        break;
      case "br":
        runs.push({ text: "\n", style });
        break;
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens?.length) inlineRuns(text.tokens, style, runs);
        else runs.push({ text: text.text.replace(/[ \t]+/g, " "), style });
        break;
      }
      case "escape":
        runs.push({ text: (token as Tokens.Escape).text, style });
        break;
      default:
        if ("raw" in token) runs.push({ text: token.raw, style });
    }
  }
}

/** Markdown as blocks, styled like the canvas editor's stylesheet at `theme.size`. */
export function markdownBlocks(markdown: string, theme: MarkdownTheme): TextBlock[] {
  const blocks: TextBlock[] = [];
  const base: TextStyle = { face: "regular", size: theme.size, color: theme.color };
  const spacing = (indent: number, lineHeight = LINE_HEIGHT): BlockSpacing => ({
    marginTop: 0,
    marginBottom: 0,
    indent,
    lineHeight,
  });
  const walk = (tokens: readonly Token[], indent: number, depth: number) => {
    for (const token of tokens) {
      if (token.type === "heading") {
        const heading = token as Tokens.Heading;
        const style = { ...base, face: "bold" as const, size: theme.size * HEADINGS[heading.depth - 1] };
        const runs: TextRun[] = [];
        inlineRuns(heading.tokens, style, runs);
        blocks.push({ kind: "text", runs, spacing: spacing(indent, 1.2) });
      } else if (token.type === "paragraph" || token.type === "text") {
        const runs: TextRun[] = [];
        const inline = (token as Tokens.Paragraph).tokens;
        if (inline?.length) inlineRuns(inline, base, runs);
        else runs.push({ text: (token as Tokens.Text).text, style: base });
        const gap = token.type === "paragraph" && depth === 0 ? (theme.paragraphGap ?? 0) * theme.size : 0;
        blocks.push({ kind: "text", runs, spacing: { ...spacing(indent), marginTop: gap } });
      } else if (token.type === "list") {
        const list = token as Tokens.List;
        let number = typeof list.start === "number" ? list.start : 1;
        for (const item of list.items) {
          const before = blocks.length;
          walk(item.tokens, indent + 24, depth + 1);
          const first = blocks[before];
          if (first?.kind === "text") {
            first.marker = {
              kind: "text",
              text: list.ordered ? `${number++}.` : ["•", "◦", "▪"][depth % 3],
              style: { ...base, color: theme.color },
            };
          }
        }
      } else if (token.type === "code") {
        blocks.push({
          kind: "text",
          runs: [{ text: (token as Tokens.Code).text, style: { ...base, face: "mono", size: theme.size * 0.9 } }],
          spacing: spacing(indent),
          box: { color: "rgba(15, 23, 42, 0.08)", padding: 8, radius: 4 },
          preserve: true,
        });
      } else if (token.type === "blockquote") {
        const before = blocks.length;
        walk((token as Tokens.Blockquote).tokens, indent + 12, depth);
        for (const block of blocks.slice(before)) {
          if (block.kind === "text") block.bar = { color: "rgba(15, 23, 42, 0.16)", width: 3 };
        }
      } else if (token.type === "hr") {
        blocks.push({ kind: "rule", color: "rgba(15, 23, 42, 0.16)", spacing: spacing(indent, 1) });
      } else if (token.type === "table") {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows]) {
          const cells = row.map((cell) => {
            const runs: TextRun[] = [];
            inlineRuns(cell.tokens, base, runs);
            return runs;
          });
          blocks.push({ kind: "row", cells, border: "rgba(15, 23, 42, 0.16)", spacing: spacing(indent) });
        }
      }
    }
  };
  walk(marked.lexer(markdown, { gfm: true, breaks: true }), 0, 0);
  return blocks;
}

export function layoutMarkdown(
  markdown: string,
  theme: MarkdownTheme,
  width: number,
  faces: ReadonlyMap<FontFace, Font>,
): TextLayout {
  return layoutText(markdownBlocks(markdown, theme), faces, {
    width,
    align: theme.align,
    imageAspect: () => null,
  });
}

/** One plain line in one style, such as a frame title or a connector label. */
export function layoutLine(
  text: string,
  style: TextStyle,
  faces: ReadonlyMap<FontFace, Font>,
  maxWidth = Number.POSITIVE_INFINITY,
): TextLayout {
  return layoutText(
    [{ kind: "text", runs: [{ text, style }], spacing: { marginTop: 0, marginBottom: 0, indent: 0, lineHeight: 1.2 } }],
    faces,
    { width: maxWidth, imageAspect: () => null },
  );
}
