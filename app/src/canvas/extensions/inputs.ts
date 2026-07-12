// Paste / drop input routing for the canvas. This is the priority pipeline that
// recognizes what kind of thing the user pasted or dropped (our own clipboard,
// files, a Figma selection, a document URL, an image URL, a link, rich HTML,
// plain text) and dispatches it. The recognition/ordering — the type-awareness —
// lives here so Canvas.vue stays a generic host: it only provides the insertion
// primitives (which touch host UI state) via CanvasInputContext.
import {
  type CanvasClipboard,
  canvasClipboardFromDataTransfer,
  parseCanvasClipboardHtml,
  parseCanvasClipboardJson,
} from "#utils/clipboard.ts";
import { transformImageUrl } from "#utils/imageUrlTransformers.ts";
import { type DocumentLinkReference, droppedDocumentReference } from "./documentLink.ts";
import { isFigmaClipboardHtml } from "./figma.ts";
import { canvasFilesFromDataTransfer, dragHasCanvasFiles } from "./files.ts";
import { mediaFilesFromDataTransfer } from "./media.ts";
import type { CanvasPoint } from "./types.ts";

// Insertion primitives the host owns (they touch shape store / upload
// placeholders / save state / toast). Routing calls these; it never touches the
// host directly.
export interface CanvasInputContext {
  insertionPoint: (event?: MouseEvent | DragEvent) => CanvasPoint;
  // Host-coupled recognizer: does this URL resolve to an in-app document?
  isDocumentUrl: (url: string) => boolean;
  pasteCanvasClipboard: (payload: CanvasClipboard, at: CanvasPoint) => void;
  addDroppedFiles: (media: File[], files: File[], at: CanvasPoint) => void;
  insertDocumentUrl: (url: string, at: CanvasPoint) => void;
  insertDocumentRef: (ref: DocumentLinkReference, at: CanvasPoint) => boolean;
  insertImageUrl: (fetchUrl: string, originalUrl: string, at: CanvasPoint) => void;
  insertLink: (url: string, at: CanvasPoint) => void;
  // Rich document/web HTML → shapes; returns whether anything was inserted.
  pasteRichHtml: (html: string, text: string, at: CanvasPoint) => boolean;
  pasteFigma: (html: string, at: CanvasPoint) => void;
}

function isHttpUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

// Routes a native clipboard paste over the canvas. Returns true when it consumed
// the event (and has already called preventDefault).
export function routeCanvasPaste(
  event: ClipboardEvent,
  ctx: CanvasInputContext,
): boolean {
  const data = event.clipboardData;
  const text = data?.getData("text/plain") ?? "";
  const html = data?.getData("text/html") ?? "";
  const at = () => ctx.insertionPoint();

  // 1. Our own canvas elements (custom/html metadata, or legacy text/plain JSON).
  const payload = canvasClipboardFromDataTransfer(data);
  if (payload) {
    event.preventDefault();
    ctx.pasteCanvasClipboard(payload, at());
    return true;
  }

  // 2. Files — images/video keep their canvas renderers; the rest are file cards.
  const media = mediaFilesFromDataTransfer(data);
  const files = canvasFilesFromDataTransfer(data);
  if (media.length > 0 || files.length > 0) {
    event.preventDefault();
    ctx.addDroppedFiles(media, files, at());
    return true;
  }

  // 3. Figma selection — HTML blob with figmeta + kiwi scene data. Must run
  //    before the plain-text bail since Figma also populates text/plain.
  if (isFigmaClipboardHtml(html)) {
    event.preventDefault();
    ctx.pasteFigma(html, at());
    return true;
  }

  const url = text.trim();

  // 4. Internal document URL → document-attachment card.
  if ((isHttpUrl(url) || url.startsWith("/")) && ctx.isDocumentUrl(url)) {
    event.preventDefault();
    ctx.insertDocumentUrl(url, at());
    return true;
  }

  // 5. Image URL → canvas image shape (before the text bail: it's "real" text).
  const imageUrl = transformImageUrl(url);
  if (imageUrl) {
    event.preventDefault();
    ctx.insertImageUrl(imageUrl, url, at());
    return true;
  }

  // 6. Plain HTTP(S) URL → link preview card.
  if (isHttpUrl(url)) {
    event.preventDefault();
    ctx.insertLink(url, at());
    return true;
  }

  // 7. Rich document/web HTML → shapes.
  if (html.trim() && ctx.pasteRichHtml(html, text, at())) {
    event.preventDefault();
    return true;
  }

  // 8. Plain text → a text shape.
  if (text.trim().length > 0) {
    event.preventDefault();
    ctx.pasteRichHtml("", text, at());
    return true;
  }

  return false;
}

// Routes the context-menu "Paste" (reads the system clipboard; no file access).
export function routeContextMenuPaste(
  clipboard: { canvasJson: string; html: string; text: string },
  at: CanvasPoint,
  ctx: CanvasInputContext,
): void {
  const payload =
    parseCanvasClipboardJson(clipboard.canvasJson) ??
    parseCanvasClipboardHtml(clipboard.html) ??
    parseCanvasClipboardJson(clipboard.text);
  if (payload) {
    ctx.pasteCanvasClipboard(payload, at);
    return;
  }

  const url = clipboard.text.trim();
  if ((isHttpUrl(url) || url.startsWith("/")) && ctx.isDocumentUrl(url)) {
    ctx.insertDocumentUrl(url, at);
    return;
  }
  const imageUrl = transformImageUrl(url);
  if (imageUrl) {
    ctx.insertImageUrl(imageUrl, url, at);
    return;
  }
  if (isHttpUrl(url)) {
    ctx.insertLink(url, at);
    return;
  }
  if (clipboard.html.trim() && ctx.pasteRichHtml(clipboard.html, clipboard.text, at)) {
    return;
  }
  if (clipboard.text.trim().length > 0) ctx.pasteRichHtml("", clipboard.text, at);
}

// Routes a drop over the canvas. Returns true when it consumed the event.
export function routeCanvasDrop(event: DragEvent, ctx: CanvasInputContext): boolean {
  const data = event.dataTransfer;
  if (dragHasCanvasFiles(data)) {
    // Block the browser from navigating to the file even if we can't place it.
    event.preventDefault();
    const media = mediaFilesFromDataTransfer(data);
    const files = canvasFilesFromDataTransfer(data);
    if (media.length > 0 || files.length > 0) {
      ctx.addDroppedFiles(media, files, ctx.insertionPoint(event));
    }
    return true;
  }

  // A document dragged from the sidebar / command palette becomes a link card.
  const droppedRef = droppedDocumentReference(data);
  if (droppedRef && ctx.insertDocumentRef(droppedRef, ctx.insertionPoint(event))) {
    event.preventDefault();
    return true;
  }
  return false;
}
