/**
 * Sanitized HTML (rendered Markdown, a document preview, a tweet) as layout
 * blocks. The theme carries the stylesheet the same markup gets in the DOM, so
 * painted text matches the live editor that replaces it while editing.
 */

import { type FontFace, fontFaces } from "#canvas/render/fonts.ts";
import { loadedImage } from "#canvas/render/images.ts";
import {
  type BlockSpacing,
  layoutText,
  type TextBlock,
  type TextLayout,
  type TextMarker,
  type TextRun,
  type TextStyle,
} from "#canvas/render/textLayout.ts";

export interface RichTextTheme {
  size: number;
  lineHeight: number;
  color: string;
  /** Heading font sizes for h1…h6, in px. */
  headings: readonly number[];
  headingLineHeight: number;
  headingColor: string;
  headingFace: FontFace;
  /** Vertical margins, in em of the element's own size. */
  blockMargin: number;
  headingMargin: { top: number; bottom: number };
  listIndent: number;
  itemMargin: number;
  link: string;
  muted: string;
  codeBackground: string;
  divider: string;
  accent: string;
  /** `pre-wrap` text: spaces are kept, as in a text shape's editor. */
  preserveWhitespace?: boolean;
  /** Style overrides for elements carrying a class, e.g. a status pill. */
  classes?: Record<string, Partial<TextStyle>>;
}

interface InlineState {
  bold: boolean;
  italic: boolean;
  mono: boolean;
  style: TextStyle;
}

interface BlockContext {
  indent: number;
  quote: boolean;
  preserve: boolean;
  /** Inside a list item, whose blocks take `itemMargin`. */
  item: boolean;
  /** Claimed by the first block an `li` produces. */
  marker: TextMarker | null;
}

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "LI",
  "PRE",
  "BLOCKQUOTE",
  "HR",
  "TABLE",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "FIGURE",
  "FIGCAPTION",
  "DETAILS",
  "SUMMARY",
  "LABEL",
]);

const BULLETS = ["•", "◦", "▪"];

function faceOf(state: Pick<InlineState, "bold" | "italic" | "mono">): FontFace {
  if (state.mono) return "mono";
  if (state.bold) return state.italic ? "boldItalic" : "bold";
  return state.italic ? "italic" : "regular";
}

function isBlock(node: Node): node is Element {
  return node instanceof Element && BLOCK_TAGS.has(node.tagName);
}

export function richTextBlocks(html: string, theme: RichTextTheme): TextBlock[] {
  const root = new DOMParser().parseFromString(html, "text/html").body;
  const blocks: TextBlock[] = [];
  let taskIndex = 0;

  const baseStyle: TextStyle = { face: "regular", size: theme.size, color: theme.color };
  const spacing = (size: number, margin: number, lineHeight: number, indent: number) =>
    ({
      marginTop: margin * size,
      marginBottom: margin * size,
      indent,
      lineHeight,
    }) satisfies BlockSpacing;

  const classStyle = (element: Element, style: TextStyle): TextStyle => {
    let next = style;
    for (const name of element.classList) {
      const override = theme.classes?.[name];
      if (override) next = { ...next, ...override };
    }
    return next;
  };

  const inline = (node: Node, state: InlineState, runs: TextRun[], preserve: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? "";
      const text = preserve ? raw : raw.replace(/\s+/g, " ");
      if (text) runs.push({ text, style: state.style });
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      runs.push({ text: "\n", style: state.style });
      return;
    }
    if (tag === "INPUT" || tag === "IMG" || tag === "SCRIPT" || tag === "STYLE") return;
    const next: InlineState = { ...state, style: classStyle(node, state.style) };
    if (tag === "STRONG" || tag === "B") next.bold = true;
    if (tag === "EM" || tag === "I") next.italic = true;
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
      next.mono = true;
      next.style = {
        ...next.style,
        size: next.style.size * 0.9,
        highlight: preserve ? undefined : theme.codeBackground,
      };
    }
    if (tag === "A") {
      next.style = {
        ...next.style,
        color: theme.link,
        underline: true,
        href: node.getAttribute("href") ?? undefined,
      };
    }
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") {
      next.style = { ...next.style, strike: true };
    }
    // A workflow card's "open output document" button links to that document.
    const documentId = node.getAttribute("data-document-id");
    if (documentId) {
      next.style = { ...next.style, color: theme.link, href: `document:${documentId}` };
    }
    if (tag === "U") next.style = { ...next.style, underline: true };
    if (tag === "MARK") next.style = { ...next.style, highlight: "#fef08a" };
    next.style = { ...next.style, face: faceOf(next) };
    for (const child of node.childNodes) inline(child, next, runs, preserve);
  };

  const pushText = (
    runs: TextRun[],
    context: BlockContext,
    block: { size: number; margin: number; lineHeight: number },
    extra: Partial<Extract<TextBlock, { kind: "text" }>> = {},
  ) => {
    const style = runs[0]?.style ?? baseStyle;
    const marker = context.marker;
    context.marker = null;
    const margin = context.item ? theme.itemMargin / block.size : block.margin;
    blocks.push({
      kind: "text",
      runs: runs.length > 0 ? runs : [{ text: "", style }],
      spacing: spacing(block.size, margin, block.lineHeight, context.indent),
      marker: marker ?? undefined,
      bar: context.quote ? { color: theme.divider, width: 3 } : undefined,
      preserve: context.preserve,
      ...extra,
    });
  };

  const walk = (element: Element, context: BlockContext, state: InlineState) => {
    let pending: TextRun[] = [];
    const flush = () => {
      if (pending.some((run) => run.text.trim() !== "") || context.marker) {
        pushText(pending, context, {
          size: state.style.size,
          margin: theme.blockMargin,
          lineHeight: theme.lineHeight,
        });
      }
      pending = [];
    };
    for (const child of element.childNodes) {
      if (child instanceof Element && child.tagName === "IMG") {
        flush();
        const src = child.getAttribute("src");
        if (src) {
          blocks.push({
            kind: "image",
            src,
            spacing: spacing(state.style.size, theme.blockMargin, 1, context.indent),
          });
        }
        continue;
      }
      if (!isBlock(child)) {
        inline(child, state, pending, context.preserve);
        continue;
      }
      flush();
      block(child, context, state);
    }
    flush();
  };

  const block = (element: Element, context: BlockContext, inherited: InlineState) => {
    const tag = element.tagName;
    const state: InlineState = {
      ...inherited,
      style: classStyle(element, inherited.style),
    };
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      const size = theme.headings[Number(heading[1]) - 1];
      const style: TextStyle = {
        ...state.style,
        size,
        color: theme.headingColor,
        face: theme.headingFace,
      };
      const runs: TextRun[] = [];
      inline(element, { ...state, bold: true, style }, runs, false);
      for (const run of runs) run.style = { ...run.style, face: theme.headingFace };
      blocks.push({
        kind: "text",
        runs: runs.length > 0 ? runs : [{ text: "", style }],
        spacing: {
          marginTop: theme.headingMargin.top * size,
          marginBottom: theme.headingMargin.bottom * size,
          indent: context.indent,
          lineHeight: theme.headingLineHeight,
        },
        marker: context.marker ?? undefined,
      });
      context.marker = null;
      return;
    }
    if (tag === "P") {
      const runs: TextRun[] = [];
      for (const child of element.childNodes)
        inline(child, state, runs, context.preserve);
      pushText(runs, context, {
        size: state.style.size,
        margin: theme.blockMargin,
        lineHeight: theme.lineHeight,
      });
      return;
    }
    if (tag === "HR") {
      blocks.push({
        kind: "rule",
        color: theme.divider,
        spacing: spacing(state.style.size, theme.blockMargin, 1, context.indent),
      });
      return;
    }
    if (tag === "PRE") {
      const runs: TextRun[] = [];
      const mono = {
        ...state,
        mono: true,
        style: { ...state.style, face: "mono" as const },
      };
      for (const child of element.childNodes) inline(child, mono, runs, true);
      const text = runs
        .map((run) => run.text)
        .join("")
        .replace(/\n$/, "");
      blocks.push({
        kind: "text",
        runs: [{ text, style: { ...mono.style, size: state.style.size * 0.9 } }],
        spacing: spacing(
          state.style.size,
          theme.blockMargin,
          theme.lineHeight,
          context.indent,
        ),
        box: { color: theme.codeBackground, padding: 8, radius: 4 },
        preserve: true,
      });
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const depth = Number(element.getAttribute("data-depth") ?? 0);
      const isTask = element.getAttribute("data-type") === "taskList";
      let number = Number(element.getAttribute("start") ?? 1);
      for (const item of element.children) {
        if (item.tagName !== "LI") continue;
        for (const nested of item.querySelectorAll(":scope > ul, :scope > ol")) {
          nested.setAttribute("data-depth", String(depth + 1));
        }
        const checkbox = item.querySelector<HTMLInputElement>(
          ":scope input[type=checkbox]",
        );
        const marker: TextMarker =
          isTask || checkbox
            ? {
                kind: "checkbox",
                checked:
                  item.getAttribute("data-checked") === "true" ||
                  Boolean(checkbox?.checked),
                size: state.style.size * 0.9,
                color: theme.accent,
                index: taskIndex++,
              }
            : {
                kind: "text",
                text: tag === "OL" ? `${number++}.` : BULLETS[depth % BULLETS.length],
                style: { ...state.style, color: theme.muted, face: "regular" },
              };
        walk(
          item,
          { ...context, indent: context.indent + theme.listIndent, item: true, marker },
          state,
        );
      }
      return;
    }
    if (tag === "BLOCKQUOTE") {
      walk(
        element,
        { ...context, indent: context.indent + 16, quote: true },
        {
          ...state,
          italic: true,
          style: {
            ...state.style,
            face: faceOf({ ...state, italic: true }),
            color: theme.muted,
          },
        },
      );
      return;
    }
    if (tag === "TABLE") {
      for (const row of element.querySelectorAll("tr")) {
        const cells = [...row.children].map((cell) => {
          const runs: TextRun[] = [];
          const header = cell.tagName === "TH";
          const cellState = header
            ? {
                ...state,
                bold: true,
                style: { ...state.style, face: faceOf({ ...state, bold: true }) },
              }
            : state;
          inline(cell, cellState, runs, false);
          return runs;
        });
        blocks.push({
          kind: "row",
          cells,
          border: theme.divider,
          spacing: {
            marginTop: 0,
            marginBottom: 0,
            indent: context.indent,
            lineHeight: theme.lineHeight,
          },
        });
      }
      return;
    }
    walk(element, context, state);
  };

  walk(
    root,
    {
      indent: 0,
      quote: false,
      preserve: theme.preserveWhitespace === true,
      item: false,
      marker: null,
    },
    { bold: false, italic: false, mono: false, style: baseStyle },
  );
  return blocks;
}

const layouts = new Map<string, TextLayout>();

/**
 * `html` laid out at `width` with the given theme, cached; null until its fonts
 * have loaded, and `invalidate` repaints once they have.
 */
export function richTextLayout(
  html: string,
  theme: RichTextTheme,
  width: number,
  invalidate: () => void,
): TextLayout | null {
  const key = `${JSON.stringify(theme)}|${width}|${imageRevision}|${html}`;
  const cached = layouts.get(key);
  if (cached) return cached;
  const blocks = richTextBlocks(html, theme);
  const faces = new Set<FontFace>(["regular"]);
  for (const block of blocks) {
    if (block.kind === "text") {
      for (const run of block.runs) faces.add(run.style.face);
      if (block.marker?.kind === "text") faces.add(block.marker.style.face);
    }
    if (block.kind === "row")
      for (const cell of block.cells) for (const run of cell) faces.add(run.style.face);
  }
  const fonts = fontFaces(faces, invalidate);
  if (!fonts) return null;
  const layout = layoutText(blocks, fonts, {
    width,
    imageAspect: (src) => {
      const image = loadedImage(src, () => {
        imageRevision++;
        invalidate();
      });
      return image ? image.naturalWidth / image.naturalHeight : null;
    },
  });
  if (layouts.size > 256) layouts.clear();
  layouts.set(key, layout);
  return layout;
}

let imageRevision = 0;
