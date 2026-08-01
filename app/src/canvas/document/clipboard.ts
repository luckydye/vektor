import type * as Y from "yjs";
import { cloneFreehandPoint, createStrokeMap } from "#canvas/extensions/drawing.ts";
import type { CanvasExtensionManager } from "#canvas/extensions/registry.ts";
import type {
  CanvasInputKind,
  CanvasSerializedShape,
  CanvasShape,
  CanvasStroke,
  CanvasStrokeSnapshot,
} from "#canvas/extensions/types.ts";
import type { CanvasPoint } from "#canvas/viewport/geometry.ts";
import {
  CANVAS_CLIPBOARD_MIME,
  type CanvasClipboard,
  canvasClipboardToDocumentHtml,
  canvasClipboardToPlainText,
  createCanvasClipboard,
  documentClipboardToCanvasShapes,
  hasActiveTextSelection,
  readSystemClipboard,
  serializeCanvasClipboard,
} from "#utils/clipboard.ts";
import { shapeToYMap } from "./shapeSerialization.ts";

/**
 * Shapes in and out of the system clipboard.
 *
 * Copy, cut and paste are document I/O in the same sense serialization is:
 * they convert between the canvas's shapes and an external representation,
 * and every change they make goes through the Yjs document.
 *
 * Native clipboard events are synchronous and fire on `window`, so the
 * controller owns the listeners and passes the event in.
 */
export interface ClipboardContext {
  state: {
    readonly shapes: readonly CanvasShape[];
    readonly strokes: readonly CanvasStroke[];
    selectedShapeIds: ReadonlySet<string>;
    selectedStrokeIds: ReadonlySet<string>;
    contextMenuPos: CanvasPoint | null;
    activeTool: string;
  };
  host: { currentUserId?: string };
  ydoc: Y.Doc;
  yShapes: Y.Map<Y.Map<unknown>>;
  yStrokes: Y.Map<Y.Map<unknown>>;
  extensionManager: CanvasExtensionManager;
  extensionRuntime: { command(name: string, payload?: unknown): unknown };
  /** Where a paste with no pointer position of its own should land. */
  insertionPointFromEvent(event?: Event): CanvasPoint;
  /**
   * The point the context menu was opened at, cleared once a paste consumes it.
   * A ref rather than a value because the controller and this module share it.
   */
  contextMenuInsertWorld: { current: CanvasPoint | null };
  deleteSelectedShape(): void;
  renderScene(): void;
  renderInk(): void;
}

export function createClipboard(context: ClipboardContext) {
  const { state, host, ydoc, yShapes, yStrokes, extensionManager, extensionRuntime } =
    context;
  const { insertionPointFromEvent, deleteSelectedShape, renderScene, renderInk } =
    context;

  async function pasteFromContextMenu() {
    const insertAt = context.contextMenuInsertWorld.current ?? insertionPointFromEvent();
    state.contextMenuPos = null;
    context.contextMenuInsertWorld.current = null;
    const clipboard = await readSystemClipboard();
    const data = {
      getData: (type: string) =>
        type === CANVAS_CLIPBOARD_MIME
          ? clipboard.canvasJson
          : type === "text/html"
            ? clipboard.html
            : type === "text/plain"
              ? clipboard.text
              : "",
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      types: [CANVAS_CLIPBOARD_MIME, "text/html", "text/plain"],
      // Only the four members the paste path reads; a real DataTransfer cannot be
      // constructed with content.
    } as unknown as DataTransfer;
    routeExtensionInput(
      "paste",
      { preventDefault: () => {} } as ClipboardEvent,
      data,
      insertAt,
    );
  }

  function collectSelection(): {
    shapes: CanvasSerializedShape[];
    strokes: CanvasStrokeSnapshot[];
  } {
    const selShapes = state.shapes
      .filter((shape) => state.selectedShapeIds.has(shape.id) && !shape.locked)
      .map((shape) => extensionManager.serialize(shape));
    const selStrokes = state.strokes
      .filter((stroke) => state.selectedStrokeIds.has(stroke.id) && !stroke.locked)
      .map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map(cloneFreehandPoint),
        style: { ...stroke.style },
        kind: stroke.kind,
        rotation: stroke.rotation,
        authorId: stroke.authorId,
        locked: stroke.locked,
        updatedAt: stroke.updatedAt,
      }));
    return { shapes: selShapes, strokes: selStrokes };
  }

  function selectedCanvasClipboard(): CanvasClipboard | null {
    return createCanvasClipboard(collectSelection());
  }

  /** True when the user has a real text selection (let the browser copy that instead). */
  // Native clipboard events are synchronous and land in the system clipboard, so
  // copies work across documents, canvases, tabs, and spaces.
  function handleCopy(event: ClipboardEvent) {
    if (hasActiveTextSelection(event.target)) return;
    const payload = selectedCanvasClipboard();
    if (!payload) return;
    const json = serializeCanvasClipboard(payload);
    event.preventDefault();
    event.clipboardData?.setData(CANVAS_CLIPBOARD_MIME, json);
    event.clipboardData?.setData(
      "text/html",
      canvasClipboardToDocumentHtml(payload, { includeMetadata: true }),
    );
    event.clipboardData?.setData("text/plain", canvasClipboardToPlainText(payload));
  }

  function handleCut(event: ClipboardEvent) {
    if (hasActiveTextSelection(event.target)) return;
    const payload = selectedCanvasClipboard();
    if (!payload) return;
    const json = serializeCanvasClipboard(payload);
    event.preventDefault();
    event.clipboardData?.setData(CANVAS_CLIPBOARD_MIME, json);
    event.clipboardData?.setData(
      "text/html",
      canvasClipboardToDocumentHtml(payload, { includeMetadata: true }),
    );
    event.clipboardData?.setData("text/plain", canvasClipboardToPlainText(payload));
    deleteSelectedShape();
  }

  function copySelectionToClipboard() {
    const payload = selectedCanvasClipboard();
    if (!payload) return;
    const html = canvasClipboardToDocumentHtml(payload, { includeMetadata: true });
    const text = canvasClipboardToPlainText(payload);
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      navigator.clipboard
        .write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ])
        .catch(() => navigator.clipboard?.writeText(text).catch(() => {}));
      return;
    }
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function cutSelectionToClipboard() {
    const payload = selectedCanvasClipboard();
    if (!payload) return;
    const html = canvasClipboardToDocumentHtml(payload, { includeMetadata: true });
    const text = canvasClipboardToPlainText(payload);
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      navigator.clipboard
        .write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ])
        .catch(() => navigator.clipboard?.writeText(text).catch(() => {}));
    } else {
      navigator.clipboard?.writeText(text).catch(() => {});
    }
    deleteSelectedShape();
  }

  /**
   * Recreates clipboard shapes/strokes with fresh ids, translated so the group's
   * top-left lands at the insertion point. One transaction = one undo step.
   */
  function pasteCanvasClipboard(
    payload: CanvasClipboard,
    at: { x: number; y: number },
  ): void {
    const xs = [
      ...payload.shapes.map((shape) => shape.frame.x),
      ...payload.strokes.flatMap((stroke) => stroke.points.map((point) => point.x)),
    ];
    const ys = [
      ...payload.shapes.map((shape) => shape.frame.y),
      ...payload.strokes.flatMap((stroke) => stroke.points.map((point) => point.y)),
    ];
    if (xs.length === 0 || ys.length === 0) return;
    const dx = at.x - Math.min(...xs);
    const dy = at.y - Math.min(...ys);
    const now = Date.now();
    const pastedShapeIds = new Set<string>();
    const pastedStrokeIds = new Set<string>();

    ydoc.transact(() => {
      for (const shape of payload.shapes) {
        const id = `shape-${crypto.randomUUID()}`;
        pastedShapeIds.add(id);
        yShapes.set(
          id,
          shapeToYMap(
            {
              ...shape,
              id,
              frame: {
                ...shape.frame,
                x: Math.round(shape.frame.x + dx),
                y: Math.round(shape.frame.y + dy),
              },
              // A pasted personal element belongs to the person who pasted it,
              // never the author of the source clipboard item.
              authorId: shape.authorId ? host.currentUserId : undefined,
              updatedAt: now,
            },
            extensionManager,
          ),
        );
      }
      for (const stroke of payload.strokes) {
        const id = `stroke-${crypto.randomUUID()}`;
        pastedStrokeIds.add(id);
        yStrokes.set(
          id,
          createStrokeMap({
            id,
            points: stroke.points.map((point) => ({
              ...point,
              x: point.x + dx,
              y: point.y + dy,
            })),
            style: { ...stroke.style },
            kind: stroke.kind,
            rotation: stroke.rotation,
            authorId: stroke.authorId ? host.currentUserId : undefined,
            updatedAt: now,
          }),
        );
      }
    });

    state.selectedShapeIds = pastedShapeIds;
    state.selectedStrokeIds = pastedStrokeIds;
    state.activeTool = "select";
    renderInk();
  }

  function insertConvertedShapes(nextShapes: CanvasShape[]): boolean {
    if (nextShapes.length === 0) return false;
    const pastedShapeIds = new Set<string>();

    ydoc.transact(() => {
      for (const shape of nextShapes) {
        pastedShapeIds.add(shape.id);
        yShapes.set(
          shape.id,
          shapeToYMap({ ...shape, updatedAt: Date.now() }, extensionManager),
        );
      }
    });

    state.selectedShapeIds = pastedShapeIds;
    state.selectedStrokeIds = new Set();
    state.activeTool = "select";
    renderScene();
    return true;
  }

  function routeExtensionInput(
    kind: CanvasInputKind,
    event: ClipboardEvent | DragEvent,
    data: DataTransfer | null,
    at: { x: number; y: number },
    phase: "preview" | "commit" = "commit",
  ) {
    return extensionManager.handleInput(kind, event, {
      data,
      at: () => at,
      phase,
      command: (name, payload) => {
        const value = payload as Record<string, unknown> | undefined;
        if (name === "paste-canvas") {
          pasteCanvasClipboard(
            value?.payload as CanvasClipboard,
            value?.at as CanvasPoint,
          );
          return true;
        }
        if (name === "paste-rich") {
          const html = String(value?.html ?? "");
          const text = String(value?.text ?? "");
          return insertConvertedShapes(
            documentClipboardToCanvasShapes(
              html.trim()
                ? { html, text, at: value?.at as CanvasPoint }
                : { text, at: value?.at as CanvasPoint },
            ),
          );
        }
        return extensionRuntime.command(name, payload);
      },
    });
  }

  function handlePaste(event: ClipboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest("textarea, input, select, document-view")) return;
    routeExtensionInput("paste", event, event.clipboardData, insertionPointFromEvent());
  }

  return {
    collectSelection,
    selectedCanvasClipboard,
    handleCopy,
    handleCut,
    handlePaste,
    copySelectionToClipboard,
    cutSelectionToClipboard,
    pasteCanvasClipboard,
    pasteFromContextMenu,
    insertConvertedShapes,
    routeExtensionInput,
  };
}
