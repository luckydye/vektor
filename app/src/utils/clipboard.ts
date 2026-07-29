import type {
  CanvasSerializedShape,
  CanvasShape,
  CanvasStrokeSnapshot,
} from "#canvas/extensions/types.ts";
import { escapeHtml } from "#utils/html.ts";
import { htmlToMarkdown, renderMessageMarkdown } from "./markdown.ts";

export const CANVAS_CLIPBOARD_MARKER = "vektor-canvas-clipboard";
export const CANVAS_CLIPBOARD_MIME = "application/x-vektor-canvas";

export type CanvasClipboard = {
  "vektor-canvas-clipboard": 1;
  shapes: CanvasSerializedShape[];
  strokes: CanvasStrokeSnapshot[];
};

type DocumentClipboardUnit =
  | { type: "text"; html: string }
  | { type: "image"; src: string; alt: string; width: number; height: number }
  | { type: "video"; src: string; alt: string; width: number; height: number }
  | { type: "file"; src: string; filename: string };

const MEDIA_MIN_SIZE = { width: 80, height: 60 };
const TEXT_SIZE = { width: 280, height: 88 };
const FILE_SIZE = { width: 220, height: 150 };
const PASTE_GAP = 18;

function shapeSortKey(shape: CanvasSerializedShape) {
  return `${String(Math.round(shape.frame.y)).padStart(8, "0")}:${String(
    Math.round(shape.frame.x),
  ).padStart(8, "0")}`;
}

function shapeDataString(shape: CanvasSerializedShape, key: string) {
  const value = shape.data[key];
  return typeof value === "string" ? value : "";
}

function supportedShapes(payload: CanvasClipboard) {
  return [...payload.shapes].sort((a, b) =>
    shapeSortKey(a).localeCompare(shapeSortKey(b)),
  );
}

export function createCanvasClipboard(selection: {
  shapes: CanvasSerializedShape[];
  strokes: CanvasStrokeSnapshot[];
}): CanvasClipboard | null {
  if (selection.shapes.length === 0 && selection.strokes.length === 0) return null;
  return {
    [CANVAS_CLIPBOARD_MARKER]: 1,
    shapes: selection.shapes,
    strokes: selection.strokes,
  };
}

export function serializeCanvasClipboard(payload: CanvasClipboard): string {
  return JSON.stringify(payload);
}

export function parseCanvasClipboardJson(
  text: string | null | undefined,
): CanvasClipboard | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<CanvasClipboard>;
    if (parsed?.[CANVAS_CLIPBOARD_MARKER] !== 1) return null;
    if (!Array.isArray(parsed.shapes) || !Array.isArray(parsed.strokes)) return null;
    return parsed as CanvasClipboard;
  } catch {
    return null;
  }
}

export function parseCanvasClipboardHtml(
  html: string | null | undefined,
): CanvasClipboard | null {
  if (!html || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const marker = doc.querySelector<HTMLElement>("[data-vektor-canvas-clipboard]");
  return parseCanvasClipboardJson(marker?.dataset.vektorCanvasClipboard);
}

export function canvasClipboardFromDataTransfer(
  data: DataTransfer | null | undefined,
): CanvasClipboard | null {
  if (!data) return null;
  return (
    parseCanvasClipboardJson(data.getData(CANVAS_CLIPBOARD_MIME)) ??
    parseCanvasClipboardHtml(data.getData("text/html")) ??
    parseCanvasClipboardJson(data.getData("text/plain"))
  );
}

export function canvasClipboardToPlainText(payload: CanvasClipboard): string {
  const lines: string[] = [];
  for (const shape of supportedShapes(payload)) {
    const text = shapeDataString(shape, "text");
    const src = shapeDataString(shape, "src");
    const alt = shapeDataString(shape, "alt");
    if (
      (shape.type === "text" || shape.type === "note" || shape.type === "section") &&
      text.trim()
    ) {
      lines.push(text.trim());
    } else if (
      shape.type === "image" ||
      shape.type === "video" ||
      shape.type === "file"
    ) {
      lines.push(alt || src || shape.type);
    } else if (shape.type === "link" && src) {
      lines.push(text || src);
    } else if (shape.type === "document" && text.trim()) {
      lines.push(text.trim());
    }
  }
  return lines.join("\n\n");
}

export function canvasClipboardToDocumentHtml(
  payload: CanvasClipboard,
  options: { includeMetadata?: boolean } = {},
): string {
  const html: string[] = [];

  if (options.includeMetadata !== false) {
    html.push(
      `<div data-vektor-canvas-clipboard="${escapeHtml(
        serializeCanvasClipboard(payload),
      )}" style="display:none"></div>`,
    );
  }

  for (const shape of supportedShapes(payload)) {
    const text = shapeDataString(shape, "text");
    const src = shapeDataString(shape, "src");
    const alt = shapeDataString(shape, "alt");
    if (shape.type === "text" || shape.type === "note") {
      const rendered = renderMessageMarkdown(text);
      if (rendered.trim()) html.push(rendered);
      continue;
    }

    if (shape.type === "section") {
      if (text.trim()) html.push(`<h2>${escapeHtml(text.trim())}</h2>`);
      continue;
    }

    if (shape.type === "image" && src) {
      html.push(
        `<img src="${escapeHtml(src)}" alt="${escapeHtml(
          alt,
        )}" width="${Math.round(shape.frame.width ?? 0)}" height="${Math.round(shape.frame.height ?? 0)}">`,
      );
      continue;
    }

    if (shape.type === "video" && src) {
      html.push(
        `<video src="${escapeHtml(src)}" controls width="${Math.round(
          shape.frame.width ?? 0,
        )}" height="${Math.round(shape.frame.height ?? 0)}"></video>`,
      );
      continue;
    }

    if (shape.type === "file" && src) {
      html.push(
        `<file-attachment src="${escapeHtml(src)}" filename="${escapeHtml(
          alt || text || "file",
        )}"></file-attachment>`,
      );
      continue;
    }

    if (shape.type === "link" && src) {
      const label = text || src;
      html.push(`<p><a href="${escapeHtml(src)}">${escapeHtml(label)}</a></p>`);
      continue;
    }

    if (shape.type === "document" && text.trim()) {
      html.push(`<p>${escapeHtml(text.trim())}</p>`);
    }
  }

  return html.join("\n");
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseStyleSize(style: string, property: "width" | "height"): number | null {
  const match = new RegExp(`${property}\\s*:\\s*([0-9.]+)px`, "i").exec(style);
  return parseNumber(match?.[1]);
}

function mediaSize(element: Element, fallback: { width: number; height: number }) {
  const style = element.getAttribute("style") ?? "";
  const width =
    parseNumber(element.getAttribute("width")) ?? parseStyleSize(style, "width");
  const height =
    parseNumber(element.getAttribute("height")) ?? parseStyleSize(style, "height");
  const resolvedWidth = width ?? fallback.width;
  const resolvedHeight = height ?? fallback.height;
  const scale = Math.min(
    1,
    480 / Math.max(1, resolvedWidth),
    360 / Math.max(1, resolvedHeight),
  );
  return {
    width: Math.max(MEDIA_MIN_SIZE.width, Math.round(resolvedWidth * scale)),
    height: Math.max(MEDIA_MIN_SIZE.height, Math.round(resolvedHeight * scale)),
  };
}

function absoluteUrl(src: string): string {
  if (!src || typeof window === "undefined") return src;
  if (/^(?:data:|blob:|https?:|\/)/i.test(src)) {
    try {
      return new URL(src, window.location.origin).href;
    } catch {
      return src;
    }
  }
  try {
    return new URL(src, window.location.href).href;
  } catch {
    return src;
  }
}

function collectDocumentUnits(nodes: Iterable<Node>, units: DocumentClipboardUnit[]) {
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) {
        units.push({ type: "text", html: escapeHtml(node.textContent) });
      }
      continue;
    }
    if (!(node instanceof Element)) continue;

    if (node.matches("[data-vektor-canvas-clipboard]")) continue;

    if (node.matches("img[src]")) {
      const size = mediaSize(node, { width: 240, height: 150 });
      units.push({
        type: "image",
        src: absoluteUrl(node.getAttribute("src") ?? ""),
        alt: node.getAttribute("alt") ?? "",
        ...size,
      });
      continue;
    }

    if (node.matches("video[src]")) {
      const size = mediaSize(node, { width: 240, height: 150 });
      units.push({
        type: "video",
        src: absoluteUrl(node.getAttribute("src") ?? ""),
        alt: node.getAttribute("aria-label") ?? "",
        ...size,
      });
      continue;
    }

    if (node.matches("file-attachment[src]")) {
      units.push({
        type: "file",
        src: absoluteUrl(node.getAttribute("src") ?? ""),
        filename: node.getAttribute("filename") ?? "file",
      });
      continue;
    }

    if (node.querySelector("img[src], video[src], file-attachment[src]")) {
      collectDocumentUnits(node.childNodes, units);
      continue;
    }

    if (node.textContent?.trim()) {
      units.push({ type: "text", html: node.outerHTML });
    }
  }
}

function flushTextShape(
  htmlParts: string[],
  shapes: CanvasShape[],
  at: { x: number; y: number },
  cursorY: { value: number },
) {
  if (htmlParts.length === 0) return;
  const markdown = htmlToMarkdown(htmlParts.join("\n")).trim();
  htmlParts.length = 0;
  if (!markdown) return;

  shapes.push({
    id: `shape-${crypto.randomUUID()}`,
    type: "text",
    frame: {
      x: Math.round(at.x),
      y: Math.round(cursorY.value),
      width: TEXT_SIZE.width,
      height: TEXT_SIZE.height,
      rotation: 0,
    },
    style: { color: "#ffffff" },
    data: { text: markdown, fontScale: 1 },
    updatedAt: Date.now(),
  });
  cursorY.value += TEXT_SIZE.height + PASTE_GAP;
}

export function documentClipboardToCanvasShapes(params: {
  html?: string | null;
  text?: string | null;
  at: { x: number; y: number };
}): CanvasShape[] {
  const shapes: CanvasShape[] = [];
  const cursorY = { value: params.at.y };
  const htmlParts: string[] = [];

  if (params.html?.trim() && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(params.html, "text/html");
    doc.querySelectorAll("[data-vektor-canvas-clipboard]").forEach((node) => {
      node.remove();
    });

    const units: DocumentClipboardUnit[] = [];
    collectDocumentUnits(doc.body.childNodes, units);

    for (const unit of units) {
      if (unit.type === "text") {
        htmlParts.push(unit.html);
        continue;
      }

      flushTextShape(htmlParts, shapes, params.at, cursorY);

      if (unit.type === "image" || unit.type === "video") {
        shapes.push({
          id: `shape-${crypto.randomUUID()}`,
          type: unit.type,
          frame: {
            x: Math.round(params.at.x),
            y: Math.round(cursorY.value),
            width: unit.width,
            height: unit.height,
            rotation: 0,
          },
          style: { color: unit.type === "video" ? "#000000" : "transparent" },
          data: { text: "", src: unit.src, alt: unit.alt },
          updatedAt: Date.now(),
        });
        cursorY.value += unit.height + PASTE_GAP;
        continue;
      }

      shapes.push({
        id: `shape-${crypto.randomUUID()}`,
        type: "file",
        frame: {
          x: Math.round(params.at.x),
          y: Math.round(cursorY.value),
          width: FILE_SIZE.width,
          height: FILE_SIZE.height,
          rotation: 0,
        },
        style: { color: "transparent" },
        data: { text: "", src: unit.src, alt: unit.filename },
        updatedAt: Date.now(),
      });
      cursorY.value += FILE_SIZE.height + PASTE_GAP;
    }
  }

  flushTextShape(htmlParts, shapes, params.at, cursorY);

  if (shapes.length === 0 && params.text?.trim()) {
    shapes.push({
      id: `shape-${crypto.randomUUID()}`,
      type: "text",
      frame: {
        x: Math.round(params.at.x),
        y: Math.round(params.at.y),
        width: TEXT_SIZE.width,
        height: TEXT_SIZE.height,
        rotation: 0,
      },
      style: { color: "#ffffff" },
      data: { text: params.text.trim(), fontScale: 1 },
      updatedAt: Date.now(),
    });
  }

  return shapes;
}
