import * as Y from "yjs";
import type { CanvasCollaborationFactory } from "#canvas/document/collaboration.ts";
import { shapeFromSource, shapeToYMap } from "#canvas/document/serialization.ts";
import {
  cloneFreehandPoint,
  createStrokeMap,
  strokeStyleFromUnknown,
  toCanvasStroke,
} from "#canvas/document/strokes.ts";
import type { DocumentPreviewSource } from "#canvas/extensions/documentLink.ts";
import { PEN_COLORS } from "#canvas/extensions/drawTool.ts";
import type { CanvasUploader } from "#canvas/extensions/media.ts";
import {
  activeShapeId,
  type CanvasShapeLibraryItem,
  setActiveShapeId,
} from "#canvas/extensions/shape.ts";
import { makeCanvasCursor } from "#canvas/render/cursor.ts";
import type { FreehandPoint, FreehandStroke } from "#canvas/render/freehand.ts";
import { FREEHAND_STYLE, translateFreehandStroke } from "#canvas/render/freehand.ts";
import { drawWorldDots, drawWorldGrid } from "#canvas/render/grid.ts";
import { drawCanvasSelections } from "#canvas/render/selectionLayer.ts";
import { drawCanvasStrokes, renderCanvasInkOverlay } from "#canvas/render/strokeLayer.ts";
import { readCanvasTheme, isDarkMode as resolveDarkMode } from "#canvas/render/theme.ts";
import { type CanvasTileView, compositeTiles } from "#canvas/render/tiles.ts";
import type { CanvasElementContext } from "#canvas/runtime/elementBase.ts";
import type {
  CanvasEditSession,
  CanvasElementExtension,
  CanvasFrame,
  CanvasHitTestHelpers,
  CanvasInputKind,
  CanvasPaintHelpers,
  CanvasPointerGestureCancelReason,
  CanvasPointerGestureEvent,
  CanvasPointerGestureHandlers,
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasSnapshot,
  CanvasStroke,
  CanvasStrokeSnapshot,
  CanvasToolContext,
  CanvasToolExtension,
  CanvasToolId,
  CanvasToolPropertyValue,
} from "#canvas/runtime/extensionApi.ts";
import {
  axisAlignedHandles,
  strokeBounds as boundsOfPoints,
  buildTransform,
  type CanvasPoint,
  clampFontScale,
  type FitReference,
  handleOffsets,
  hitTestCanvasStroke,
  isPointInRect,
  MIN_FONT_SCALE,
  normalizeRotation,
  pointOnRotatedShape,
  type Rect,
  rectContains,
  rectsIntersect,
  resizeRotatedShapeFromBottomRight,
  rotatedShapeBounds,
  rotatedShapeCorners,
  rotateVector,
  rotationFromPointer,
  type ScreenSize,
  type SnapGuide,
  scaleHandle,
  snapDragOffset as snapDrag,
  snapRotation,
  unionBounds,
  type ViewportCamera,
  screenToWorld as viewportScreenToWorld,
  worldToScreen as viewportWorldToScreen,
  type WorldRect,
  worldViewportBounds,
} from "#canvas/runtime/geometry.ts";
import {
  createViewportControls,
  panCameraByScreenDelta,
  pointerGesture,
  releasePointerCapture,
  screenPoint as screenPointIn,
  type ViewportControls,
} from "#canvas/runtime/input.ts";
import {
  type CanvasExtensionManager,
  createCanvasExtensionManager,
} from "#canvas/runtime/registry.ts";
import type {
  CanvasElementHandle,
  ScalableSelection,
  SelectionContext,
} from "#canvas/runtime/selection.ts";
import * as selection from "#canvas/runtime/selection.ts";
import { createWatchers, indexById, registerCanvas } from "#canvas/runtime/state.ts";
import { iconMarkup } from "#components/Icon.tsx";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import { Actions } from "#utils/actions.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
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
import { createTranslator, type TranslationKey } from "#utils/lang.ts";
import "#canvas/ui/PresenceCursorElement.ts";
import "#editor/elements/rich-text-editor.ts";
import "#editor/elements/toolbar.ts";
import "@atrium-ui/elements/popover";

/**
 * Everything the canvas needs from the page around it.
 *
 * The canvas is framework-free, so it cannot call `useSpace`, `useUserProfile`
 * or any other composable. Their resolved values arrive here instead, set as
 * properties on `<vektor-canvas>` by whatever shell is hosting it. That keeps
 * the dependency pointing one way — the shell knows about the canvas, never the
 * reverse — which is what lets the canvas outlive the app's framework.
 */
export interface CanvasToolDef {
  id: CanvasToolId;
  label: TranslationKey;
  shortcut: string;
  icon: string;
}

/** Element handles the template writes and the controller reads. */
export interface CanvasDomRefs {
  viewport: HTMLElement | null;
  scene: HTMLCanvasElement | null;
  activeInk: HTMLCanvasElement | null;
  selection: HTMLCanvasElement | null;
  shapePopover: (HTMLElement & { hide: () => void }) | null;
  canvasToolbar:
    | (HTMLElement & { editor: unknown; dismiss: () => void; reposition: () => void })
    | null;
  activeEditorElement: HTMLElement | null;
}

// Per-shape questions only the extension can answer.

/** Inline CSS for a shape's article wrapper. */
function shapeArticleStyle(
  shape: CanvasShape,
  extensions: CanvasExtensionManager,
): Record<string, string> {
  const extension = extensions.get(shape.type);
  const frame = shape.frame;
  const style: Record<string, string> = {
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    transform: `rotate(${frame.rotation}deg)`,
  };
  // Font-resized shapes size themselves from their content; writing a box would
  // fight the measurement.
  if (extension.behavior.transform.resize !== "font") {
    style.width = `${frame.width}px`;
    style.height = `${frame.height}px`;
  }
  if (extension.render.article?.background !== false) {
    style.background = shape.style.color;
  }
  return { ...style, ...extension.render.article?.style?.(shape) };
}

function shapeEditorTag(
  shape: CanvasShape,
  extensions: CanvasExtensionManager,
): string | undefined {
  return extensions.get(shape.type).render.chrome?.editorTag;
}

/** A container accepts other shapes dropped onto it — a section, for instance. */
function shapeIsContainer(
  shape: CanvasShape | undefined,
  extensions: CanvasExtensionManager,
): boolean {
  return Boolean(shape && extensions.get(shape.type).behavior.container);
}

/**
 * Whether the canvas should swallow native pointer events over this shape.
 *
 * A shape with an editable body (a text note) needs its own pointer handling;
 * everything else lets the canvas drive selection and dragging.
 */
function shapeSuppressesNativePointer(
  shape: CanvasShape,
  extensions: CanvasExtensionManager,
): boolean {
  return !extensions.get(shape.type).behavior.editableBody;
}

/**
 * Whether the browser's own find-in-page can see this shape's content.
 *
 * Only text-bearing shapes render their content as DOM text; the rest are
 * painted, so the browser has nothing to match against.
 */
export function isBrowserFindTarget(shape: CanvasShape): boolean {
  return shape.type === "text" || shape.type === "note";
}

export interface CanvasHost {
  readonly spaceId: string;
  readonly documentId: string | undefined;
  readonly ydoc: Y.Doc;
  readonly presenceProfiles: CollaborationPresenceProfile<CanvasPresenceState>[];
  readonly extensions: readonly CanvasElementExtension[] | undefined;
  readonly tools: readonly CanvasToolExtension[] | undefined;

  /** Resolved from `useUserProfile`. */
  readonly currentUserId: string | undefined;
  /** The cursor-colour override, already resolved against the avatar colour. */
  readonly cursorColor: string;
  /** Resolved from the space role — whether this user may modify the canvas. */
  readonly canEdit: boolean;
  readonly cursorCompanion: string | null;
  /** The document's `gridtype` property. */
  readonly gridType: string | undefined;
  /** Documents and spaces the shell has already loaded, for link previews. */
  readonly documents: DocumentPreviewSource[];
  readonly spaces: ReadonlyArray<{ id: string; slug?: string | null }> | undefined;
  readonly uploadFile: CanvasUploader | undefined;
  /** Opens a collaboration session for a document embedded on the canvas. */
  readonly createCollaboration: CanvasCollaborationFactory | undefined;

  save(snapshot: unknown): Promise<unknown>;
  error(message: string): void;
  presenceChanged(states: CanvasPresenceState[]): void;
  requestRender(): void;
}

// Derived from the factory, not declared: a hand-written `CanvasView` is a
// second copy of the view object below that drifts from it silently.
export type CanvasController = ReturnType<typeof createCanvasController>;
export type CanvasView = CanvasController["view"];

export function createCanvasController(
  host: CanvasHost,
  dom: CanvasDomRefs,
  lang: string,
) {
  const t = createTranslator(lang);
  type DragState =
    | {
        type: "shape";
        pointerId: number;
        startPointer: { x: number; y: number };
        // Every shape and stroke that moves with this drag (the grabbed shape,
        // anything else in the selection, and the contents of any dragged
        // section), captured at their starting positions.
        shapes: { id: string; x: number; y: number }[];
        strokes: { id: string; points: FreehandPoint[] }[];
      }
    | {
        type: "resize";
        pointerId: number;
        shapeId: string;
        fixedTopLeft: { x: number; y: number };
        minSize: { width: number; height: number };
        // Locked width/height ratio for media; undefined lets the axes move freely.
        aspect?: number;
        resizeMode: "box" | "font";
        initialScale?: number;
        initial: CanvasFrame;
      }
    | {
        type: "selection-scale";
        pointerId: number;
        origin: { x: number; y: number };
        startBounds: Rect;
        minSize: { width: number; height: number };
        shapes: Array<{
          id: string;
          frame: CanvasFrame;
          resizeMode: "box" | "font";
          fontScale: number;
        }>;
        strokes: Array<{ id: string; points: FreehandPoint[] }>;
      }
    | {
        type: "rotate";
        pointerId: number;
        shapeId: string;
        center: { x: number; y: number };
        initial: CanvasFrame;
      }
    | {
        type: "stroke-resize";
        pointerId: number;
        strokeId: string;
        fixedTopLeft: { x: number; y: number };
        startBounds: Rect;
        initialPoints: FreehandPoint[];
      }
    | {
        type: "stroke-rotate";
        pointerId: number;
        strokeId: string;
        center: { x: number; y: number };
        startRotation: number;
        initialRotation: number;
        initialPoints: FreehandPoint[];
      }
    | {
        type: "pan";
        pointerId: number;
        startPointer: { x: number; y: number };
        startCamera: ViewportCamera;
      }
    | {
        type: "marquee";
        pointerId: number;
        additive: boolean;
        startScreen: { x: number; y: number };
        baseIds: Set<string>;
      };

  type LockedCanvasElement = { type: "shape" | "stroke"; id: string };

  const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
  type ToolDef = CanvasToolDef & {
    id: CanvasToolId;
    label: TranslationKey;
    shortcut: string;
    icon: string;
  };

  const extensionManager = createCanvasExtensionManager({
    elements: host.extensions,
    tools: host.tools,
  });

  // Element tools come from the registry, so adding an element type surfaces
  // its tool without editing the host.
  // Select is the engine's default, not an extension: it is what "no tool
  // active" means. The rest arrive through the registry.
  const CANVAS_TOOLS: ToolDef[] = [
    { id: "select", label: "Select", shortcut: "V", icon: iconMarkup("select-tool") },
    ...extensionManager.toolbarTools(),
  ];

  // Alignment guides shown while dragging shapes; empty when no edge/center of
  // the dragged group is snapped to another shape. Drawn on the ink overlay.
  let activeSnapGuides: SnapGuide[] = [];

  const colorPalettes = extensionManager.colorPalettes();

  // --- state -------------------------------------------------------------
  /**
   * Everything a render reads. Writing a field does nothing on its own —
   * exactly like writing a local — and the entry points that change it ask for
   * a frame when they are done.
   */
  const state = {
    shapes: [] as CanvasShape[],
    strokes: [] as CanvasStroke[],
    // One set for both stores: ids are prefixed and unique across them, and
    // nothing that reads the selection cares which store an id came from.
    selectedIds: new Set<string>(),
    // Locked elements are intentionally excluded from normal hit testing. Keep a
    // separate hover target so their small unlock control remains reachable.
    hoveredLockedElement: null as LockedCanvasElement | null,
    // Section chrome is painted on the canvas. This transient input only appears
    // while its title is actively being edited.
    editingChromeId: null as string | null,
    // Live screen-space rectangle while drag-selecting; null when not marqueeing.
    marqueeRect: null as Rect | null,
    // True only while a pan drag is in progress, so the viewport shows the
    // grabbing hand during panning and a resting cursor otherwise.
    isPanning: false,
    activeTool: "select" as CanvasToolId,
    // Active swatch per color-capable element type, seeded from each
    // extension's palette. Recoloring a selected shape writes here too.
    activeColors: Object.fromEntries(
      colorPalettes.map((entry) => [entry.type, entry.palette[0]]),
    ) as Record<string, string>,
    penColor: PEN_COLORS[0] as string,
    // Tool property values, keyed by tool then property id. Seeded from each
    // tool's declared defaults so a tool can read a property before the reader
    // has touched one.
    toolProperties: extensionManager.toolPropertyDefaults(),
    // Backdrop grid style, driven by the document's "gridtype" property.
    gridType: "dots" as GridType,
    saveState: "idle" as "idle" | "saving" | "saved",
    isDarkMode: false,
    localPointerScreen: null as { x: number; y: number } | null,
    camera: { centerX: 0, centerY: 0, zoom: 1 } as ViewportCamera,
    screen: { width: 1, height: 1 } as ScreenSize,
    // Singleton extension-owned editor session. The host only mounts the
    // supplied tag/props and invokes its finish callback.
    activeEditSession: null as CanvasEditSession | null,
    // Screen-space position of the long-press context menu, null when hidden.
    contextMenuPos: null as { x: number; y: number } | null,
    intrinsicShapeSizes: new Map<string, { width: number; height: number }>(),
    // Remote pointers arrive as discrete presence updates; a CSS transition on
    // the cursor smooths the jumps. While the local camera moves the transition
    // is suspended, so cursors stay locked to the canvas instead of lagging.
    isCameraMoving: false,
    canUndo: false,
    canRedo: false,
  };

  /** Ask for a frame. Batched onto a microtask by the host. */
  const invalidate = () => host.requestRender();
  const watch = createWatchers();
  const watchPost = createWatchers();

  // "grid" draws ruled lines, "dots" a dot grid, "clean" leaves it empty.
  type GridType = "grid" | "clean" | "dots";

  let localPointer: { x: number; y: number } | null = null;

  const ydoc = host.ydoc;
  const yShapes = ydoc.getMap<Y.Map<unknown>>("canvas.shapes");
  const yStrokes = ydoc.getMap<Y.Map<unknown>>("canvas.strokes");

  const currentOrigin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;

  // Tracks only local edits (default trackedOrigins = {null}); remote/agent
  // updates arrive with origin "remote" and are excluded, so undo/redo only
  // reverts this user's own changes.
  const undoManager = new Y.UndoManager([yShapes, yStrokes]);

  function insertNewShape(shape: CanvasShape) {
    yShapes.set(shape.id, shapeToYMap(shape, extensionManager));
    selectOnly(shape.id);
    state.activeTool = "select";
    saveImmediately();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  let dragState: DragState | null = null;
  // True once a shape drag has actually moved the selection. Interactive
  // extensions use it to distinguish activation from repositioning.
  let dragMoved = false;
  type ActiveToolPointerGesture = {
    pointerId: number;
    captureTarget: HTMLElement | null;
    handlers: CanvasPointerGestureHandlers;
  };
  let activeToolPointerGesture: ActiveToolPointerGesture | null = null;
  let activeFreehandStroke: FreehandStroke | null = null;
  // World-space insertion point captured when the context menu was opened.
  // A ref, because `document/clipboard.ts` consumes and clears it too.
  const contextMenuInsertWorld: { current: { x: number; y: number } | null } = {
    current: null,
  };
  let isReady = false;
  let savePrunedInvalidShapesWhenReady = false;
  let viewportControls: ViewportControls | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let themeObserver: MutationObserver | null = null;
  let colorSchemeMedia: MediaQueryList | null = null;
  let dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  /**
   * Ink mid-gesture: the stored strokes are untouched until the pointer is
   * released, and the scene paints this in their place meanwhile.
   *
   * `strokes` carries replacement geometry for a resize or rotate; a plain move
   * leaves it as the originals and offsets them by `dx`/`dy` at paint time, so
   * dragging a hundred strokes does not rebuild a hundred point arrays a frame.
   */
  let strokePreview: {
    strokes: CanvasStroke[];
    dx: number;
    dy: number;
    // False until the gesture actually moves something, so a click that lands on
    // a transform handle without dragging commits nothing.
    changed: boolean;
  } | null = null;

  const extensionRuntime = extensionManager.createRuntime({
    spaceId: host.spaceId,
    documentId: host.documentId,
    currentOrigin,
    // Server-backed data the shell already has loaded; the canvas holds no query
    // composables of its own.
    documents: () => host.documents,
    spaces: () => host.spaces,
    uploadFile: (file, uploadOptions) =>
      host.uploadFile
        ? host.uploadFile(file, uploadOptions)
        : Promise.reject(new Error("No uploader configured for this canvas")),
    createCollaboration: (collaborationOptions) => {
      if (!host.createCollaboration) {
        throw new Error("No collaboration factory configured for this canvas");
      }
      return host.createCollaboration(collaborationOptions);
    },
    persistShape: (shape) => yShapes.set(shape.id, shapeToYMap(shape, extensionManager)),
    insertNewShape,
    selectShape: selectOnly,
    selectShapes: (ids) => setSelection(new Set(ids)),
    setActiveTool: (tool) => {
      state.activeTool = tool;
    },
    setBusy: (busy) => {
      state.saveState = busy ? "saving" : "idle";
      dispatchSaveStatus();
    },
    commitInsertion: saveImmediately,
    canEdit: () => host.canEdit,
    wasDragged: () => dragMoved,
    beginEdit,
    reportError: (error) =>
      host.error(error instanceof Error ? error.message : String(error)),
  });
  const uploadPlaceholders = extensionRuntime.uploadPlaceholders;

  const remoteCanvasPresences = () => host.presenceProfiles ?? [];

  const remoteCanvasPointerPresences = () =>
    remoteCanvasPresences().filter((presence) => presence.state?.pointer);

  const remoteCanvasSelections = () =>
    remoteCanvasPresences().flatMap((presence) => {
      const state = presence.state;
      if (!state?.selectionIds.length) return [];

      return state.selectionIds.flatMap((itemId) => {
        const shape = shapesById().get(itemId);
        if (!shape) return [];
        return [
          {
            clientId: presence.clientId,
            user: presence.user,
            cursorColor:
              state.cursorColor ||
              presence.user.color ||
              getAvatarColor(presence.user.id),
            itemId,
            bounds: shapeBounds(shape),
          },
        ];
      });
    });

  const remoteCanvasStrokeSelections = () =>
    remoteCanvasPresences().map((presence) => ({
      ids: new Set(
        presence.state?.selectionIds.filter((id) => strokesById().has(id)) ?? [],
      ),
      color:
        presence.state?.cursorColor ||
        presence.user.color ||
        getAvatarColor(presence.user.id),
    }));

  let cameraMoveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Resolves a selected id to the engine's uniform view of it.
   *
   * The two stores stay separate — a board holds tens of shapes and can hold
   * thousands of strokes, and the stroke list is deliberately the cheap one —
   * but selection, locking, permissions and transform handles do not care which
   * store an id came from, so they come through here instead of branching.
   */
  function elementHandle(id: string): CanvasElementHandle | null {
    const shape = shapesById().get(id);
    if (shape) {
      return {
        id,
        kind: "shape",
        type: shape.type,
        locked: shape.locked === true,
        canMove: canMoveShape(shape),
        bounds: shapeAabb(shape),
        rotation: shape.frame.rotation,
        transform: extensionManager.get(shape.type).behavior.transform,
        handles: true,
      };
    }
    const stroke = strokesById().get(id);
    if (!stroke) return null;
    return {
      id,
      kind: "stroke",
      type: stroke.kind === "shape" ? "shape" : "ink",
      locked: stroke.locked === true,
      canMove: canMoveStroke(stroke),
      bounds: strokeBounds(stroke),
      rotation: stroke.rotation ?? 0,
      // Ink scales as part of a group whatever it is, but only a stamped
      // primitive has a box worth grabbing on its own.
      transform: { move: true, resize: "box", rotate: stroke.kind === "shape" },
      handles: stroke.kind === "shape",
    };
  }

  /**
   * Built once with getters: the selectors below run every frame. It stays a
   * separate object because that is the seam `canvas-selection.vitest.ts`
   * drives the maths through.
   */
  const selectionModel: SelectionContext = {
    get selectedIds() {
      return state.selectedIds;
    },
    element: elementHandle,
  };

  const selectedElement = () => selection.selectedElement(selectionModel);
  const selectedTransformElement = () =>
    selection.selectedTransformElement(selectionModel);
  const selectedResizeOnlyElement = () =>
    selection.selectedResizeOnlyElement(selectionModel);
  const selectedGroupBounds = () => selection.selectedGroupBounds(selectionModel);
  const selectedScalableSelection = () =>
    selection.selectedScalableSelection(selectionModel);

  /** The single selected shape, when the selection is exactly one shape. */
  const selectedShape = () => {
    const element = selectedElement();
    return element?.kind === "shape" ? (shapesById().get(element.id) ?? null) : null;
  };

  /**
   * Screen positions of an element's rotate and resize handles.
   *
   * A shape's box can itself be rotated, so its handles ride around the rotated
   * corners. A stroke bakes rotation into its points and its bounds are already
   * axis-aligned, so its handles sit on the box.
   */
  function transformControlPositions(element: CanvasElementHandle) {
    if (element.kind === "stroke") {
      return element.bounds
        ? axisAlignedHandles(element.bounds, transform().scale, worldToScreen)
        : null;
    }
    const shape = shapesById().get(element.id);
    if (!shape) return null;
    // Text auto-sizes, so anchor the handles to its measured box.
    const bounds = shapeBounds(shape);
    // Handles stay a comfortable fixed size in screen space. Convert their
    // offset back to world units before placing them around the rotated shape.
    const offset = handleOffsets(transform().scale);
    return {
      rotation: worldToScreen(
        pointOnRotatedShape(bounds, { x: bounds.width / 2, y: -offset.rotation }),
      ),
      resize: worldToScreen(
        pointOnRotatedShape(bounds, {
          x: bounds.width + offset.resize,
          y: bounds.height + offset.resize,
        }),
      ),
    };
  }

  function selectionScaleControlPosition(bounds: Rect) {
    return scaleHandle(bounds, transform().scale, worldToScreen);
  }

  // Custom-element tag registered by an extension for its DOM body.
  function elementTagForShape(shape: CanvasShape): string | null {
    const tag = extensionManager.get(shape.type).render.tag;
    if (!tag || typeof customElements === "undefined" || !customElements.get(tag)) {
      return null;
    }
    // While an extension edits inline, the host swaps in the editor supplied by
    // that extension's active edit session.
    if (state.activeEditSession?.shapeId === shape.id) {
      return null;
    }
    return tag;
  }

  // Per-type reactive view model handed to an element via its `data` property.
  // The extension resolves it from the host's controllers; the host stays generic.
  function elementDataForShape(shape: CanvasShape): unknown {
    return extensionManager.get(shape.type).events?.data?.(shape, extHost) ?? null;
  }

  // Inline style for a shape's <article> wrapper, driven by extension metadata
  // rather than type-name checks. Font-resize types (text) auto-size to their
  // content, so they set a font-size variable instead of a fixed box; types that
  // paint their own visual (image) opt out of the card background.
  function articleStyle(shape: CanvasShape): Record<string, string> {
    return shapeArticleStyle(shape, extensionManager);
  }

  // Sets the host-owned singleton slot for an extension-supplied editor.
  function beginEdit(session: CanvasEditSession) {
    if (state.activeEditSession?.shapeId === session.shapeId) return;
    stopActiveEdit();
    selectOnly(session.shapeId);
    state.activeEditSession = session;
  }

  const extHost = extensionRuntime.host;

  function onElementActivate(shape: CanvasShape, event: MouseEvent) {
    extensionManager.get(shape.type).events?.activate?.(shape, extHost, event);
  }

  function onElementOpen(shape: CanvasShape, event: Event) {
    extensionManager.get(shape.type).events?.open?.(shape, extHost, event);
  }

  // Stable helpers/data handed to every element custom element via its
  // `canvasContext` property. Per-shape reactive values flow through `shape`/`data`.
  const hostContext: CanvasElementContext = {
    t,
    spaceId: host.spaceId,
    wasDragged: () => dragMoved,
    updateData: (id, patch) => {
      const shape = shapesById().get(id);
      if (!shape || shape.locked) return;
      updateShapeData(id, patch);
    },
    removeShape: (id) => {
      if (shapesById().get(id)?.locked) return;
      yShapes.delete(id);
      deselect(id);
    },
    selectShape: (id) => selectOnly(id),
    setFormattingEditor: (editor) => {
      const toolbar = dom.canvasToolbar;
      if (toolbar) toolbar.editor = editor;
    },
    reportSize: (id, size) => {
      const shape = shapesById().get(id);
      if (!shape || !yShapes.has(id)) return;
      const extension = extensionManager.get(shape.type);
      const minimum = extension.defaults.minSize;
      if (extension.behavior.transform.resize === "font") {
        if (size.width === undefined || size.height === undefined) return;
        const measured = {
          width: Math.max(minimum.width, size.width),
          height: Math.max(minimum.height, size.height),
        };
        const current = state.intrinsicShapeSizes.get(id);
        if (current?.width === measured.width && current?.height === measured.height)
          return;
        const next = new Map(state.intrinsicShapeSizes);
        next.set(id, measured);
        state.intrinsicShapeSizes = next;
        renderScene();
        return;
      }
      if (!host.canEdit || draggingShapeId() === id || !canMoveShape(shape)) {
        return;
      }
      const normalized = extension.behavior.measurement?.normalize
        ? extension.behavior.measurement.normalize(shape, size)
        : size;
      if (!normalized) return;
      const patch: Partial<Pick<CanvasFrame, "width" | "height">> = {};
      if (normalized.width !== undefined) {
        patch.width = Math.max(minimum.width, normalized.width);
      }
      if (normalized.height !== undefined) {
        patch.height = Math.max(minimum.height, normalized.height);
      }
      if (patch.width !== undefined || patch.height !== undefined)
        updateShapeFrame(id, patch);
    },
  };

  // DOM-surface elements stay mounted; content-visibility lets the browser skip
  // off-screen painting.
  const domShapes = () =>
    state.shapes.filter((shape) => extensionManager.rendersInDom(shape));

  // Shapes painted via a canvas-2d extension hook, drawn behind the DOM.
  const paintedShapes = () =>
    state.shapes.filter((shape) => extensionManager.paint(shape.type));

  const editingChromeShape = () => {
    const id = state.editingChromeId;
    if (!id) return null;
    const shape = shapesById().get(id);
    return shape && extensionManager.get(shape.type).render.chrome ? shape : null;
  };

  function editorTagForShape(shape: CanvasShape) {
    return shapeEditorTag(shape, extensionManager);
  }

  function elementChromePosition(shape: CanvasShape) {
    return (
      extensionManager.get(shape.type).render.chrome?.position(shape, {
        scale: transform().scale,
        worldToScreen,
      }) ?? worldToScreen({ x: shape.frame.x, y: shape.frame.y })
    );
  }

  function elementChromeSize(shape: CanvasShape) {
    return (
      extensionManager.get(shape.type).render.chrome?.size(shape, {
        scale: transform().scale,
        t,
      }) ?? { width: 1, height: 1 }
    );
  }

  // Canvas-rasterized shapes within the current viewport. Used only by
  // raster rendering to avoid paint calls for off-screen elements.
  const visibleRasterShapes = () => {
    const vr = worldViewportBounds(state.camera, state.screen, FIT_REFERENCE, 400);
    return state.shapes.filter(
      (shape) => extensionManager.rasters(shape) && rectsIntersect(vr, shapeAabb(shape)),
    );
  };

  const selectedStrokeColor = () => {
    let color: string | null = null;
    for (const id of state.selectedIds) {
      const stroke = strokesById().get(id);
      if (!stroke) continue;
      if (color === null) color = stroke.style.color;
      else if (stroke.style.color !== color) return null;
    }
    return color;
  };

  const shapeIndex = indexById<CanvasShape>();
  const strokeIndex = indexById<CanvasStroke>();
  const shapesById = () => shapeIndex(state.shapes);
  const strokesById = () => strokeIndex(state.strokes);
  const hasLockedStrokes = () => state.strokes.some((stroke) => stroke.locked);

  function canMoveUserScopedElement(authorId: string | undefined): boolean {
    // `authorId` is an internal creation-time capability, not a user-facing
    // canvas setting. Future cosmetic/sticker creators set it to the active
    // user's id; every movement path below then honors that ownership.
    return !authorId || authorId === host.currentUserId;
  }

  function canMoveShape(shape: CanvasShape): boolean {
    return !shape.locked && canMoveUserScopedElement(shape.authorId);
  }

  function canMoveStroke(stroke: CanvasStroke): boolean {
    return !stroke.locked && canMoveUserScopedElement(stroke.authorId);
  }

  const hoveredLockedElementPosition = () => {
    const element = state.hoveredLockedElement;
    if (!element) return null;

    if (element.type === "shape") {
      const shape = shapesById().get(element.id);
      if (!shape?.locked) return null;
      const bounds = shapeBounds(shape);
      return worldToScreen(pointOnRotatedShape(bounds, { x: bounds.width, y: 0 }));
    }

    const stroke = strokesById().get(element.id);
    const bounds = stroke ? strokeBounds(stroke) : null;
    if (!stroke?.locked || !bounds) return null;
    return worldToScreen({ x: bounds.x + bounds.width, y: bounds.y });
  };

  function isElementLocked(id: string): boolean {
    return elementHandle(id)?.locked === true;
  }

  /** Replaces the selection with one element. */
  function selectOnly(id: string) {
    if (isElementLocked(id)) return;
    setSelection(new Set([id]));
  }

  /** Adds or removes one element, leaving the rest of the selection alone. */
  function toggleSelection(id: string) {
    if (isElementLocked(id)) return;
    const next = new Set(state.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  }

  function clearSelection() {
    if (state.selectedIds.size > 0) setSelection(new Set());
  }

  // Selection outlines are painted, so every change to the set needs a frame.
  function setSelection(ids: Set<string>) {
    state.selectedIds = ids;
    renderInk();
  }

  function deselect(id: string) {
    if (!state.selectedIds.has(id)) return;
    const next = new Set(state.selectedIds);
    next.delete(id);
    setSelection(next);
  }

  /** Drops ids that no longer resolve, or that have since been locked. */
  function pruneSelection() {
    const next = new Set<string>();
    for (const id of state.selectedIds) {
      const element = elementHandle(id);
      if (element && !element.locked) next.add(id);
    }
    if (next.size !== state.selectedIds.size) setSelection(next);
  }

  function intrinsicShapeSize(shape: CanvasShape) {
    return (
      state.intrinsicShapeSizes.get(shape.id) ??
      extensionManager.get(shape.type).behavior.measurement?.fallback?.(shape) ??
      extensionManager.get(shape.type).defaults.size
    );
  }

  // Auto-sizing (font-resize) shapes report a measured box that the host caches;
  // their persisted width/height is a placeholder, so geometry uses the cache.
  // Every other type is sized by its stored box.
  function shapeBounds(shape: CanvasShape) {
    const frame =
      extensionManager.get(shape.type).behavior.transform.resize === "font"
        ? { ...shape.frame, ...intrinsicShapeSize(shape) }
        : shape.frame;
    return { ...frame, id: shape.id, type: shape.type };
  }

  // Container extensions cascade drag/lock/marquee to their contents.
  function isContainerShape(shape: CanvasShape | undefined): boolean {
    return shapeIsContainer(shape, extensionManager);
  }

  // Whether the host should preventDefault a shape's pointer interaction. Types
  // whose whole body is a live editor (text) opt out so native focus/caret works.
  function suppressesNativePointer(shape: CanvasShape): boolean {
    return shapeSuppressesNativePointer(shape, extensionManager);
  }

  function shapeAabb(shape: CanvasShape): Rect {
    return rotatedShapeBounds(shapeBounds(shape));
  }

  function strokeBounds(stroke: Pick<CanvasStroke, "points">): Rect | null {
    return boundsOfPoints(stroke.points);
  }

  /** Binds the ambient page origin and space id; the parsing itself is shared. */
  function toShape(
    id: string,
    source: Y.Map<unknown> | CanvasSerializedShape,
  ): CanvasShape | null {
    return shapeFromSource(id, source, {
      extensions: extensionManager,
      currentOrigin,
      defaultSpaceId: host.spaceId,
    });
  }

  function toStroke(
    id: string,
    source: Y.Map<unknown> | CanvasStrokeSnapshot,
  ): CanvasStroke {
    return toCanvasStroke(id, source, transform().scale);
  }

  function syncShapesFromY() {
    let removedInvalid = false;
    for (const [id, value] of yShapes.entries()) {
      const shape = toShape(id, value);
      if (!shape || !extensionManager.isValid(shape)) {
        yShapes.delete(id);
        removedInvalid = true;
      }
    }

    state.shapes = [...yShapes.entries()]
      .map(([id, value]) => toShape(id, value))
      .filter((shape): shape is CanvasShape =>
        Boolean(shape && extensionManager.isValid(shape)),
      )
      .sort(
        (a, b) =>
          extensionManager.zOrder(a.type) - extensionManager.zOrder(b.type) ||
          a.updatedAt - b.updatedAt ||
          a.id.localeCompare(b.id),
      );

    pruneSelection();
    if (removedInvalid) {
      if (isReady) scheduleSave();
      else savePrunedInvalidShapesWhenReady = true;
    }

    // Drop cached measured sizes for shapes that no longer exist (text elements
    // report their intrinsic size via reportSize; the element can't clean up
    // after itself once it's gone).
    if (state.intrinsicShapeSizes.size > 0) {
      const live = new Set(state.shapes.map((shape) => shape.id));
      let changed = false;
      const next = new Map(state.intrinsicShapeSizes);
      for (const id of next.keys()) {
        if (!live.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      if (changed) state.intrinsicShapeSizes = next;
    }
  }

  function syncStrokesFromY() {
    const previous = new Map(state.strokes.map((stroke) => [stroke.id, stroke]));
    // Unchanged strokes keep their object identity: `strokePointBounds` memoizes
    // against it, and culling asks for those bounds on every frame.
    const next = [...yStrokes.entries()]
      .map(([id, value]) => {
        const existing = previous.get(id);
        return existing && existing.updatedAt === value.get("updatedAt")
          ? existing
          : toStroke(id, value);
      })
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));

    state.strokes = next;
    pruneSelection();
    renderInk();
  }

  function serializeSnapshot(): string {
    const snapshot: CanvasSnapshot = {
      version: 1,
      shapes: state.shapes.map((shape) => extensionManager.serialize(shape)),
      strokes: state.strokes.map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map(cloneFreehandPoint),
        style: { ...stroke.style },
        kind: stroke.kind,
        rotation: stroke.rotation,
        authorId: stroke.authorId,
        locked: stroke.locked,
        updatedAt: stroke.updatedAt,
      })),
    };
    return JSON.stringify(snapshot);
  }

  function dispatchSaveStatus() {
    window.dispatchEvent(
      new CustomEvent("save-status-changed", {
        detail: { status: state.saveState },
      }),
    );
  }

  function markSaved() {
    state.saveState = "saved";
    dispatchSaveStatus();
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      if (state.saveState === "saved") {
        state.saveState = "idle";
        dispatchSaveStatus();
        invalidate();
      }
    }, 1600);
  }

  async function manualSave() {
    if (!isReady) return;

    // A collaborative canvas is persisted server-side straight from the Yjs
    // update stream (see scheduleYRoomDraftPersist in the realtime websocket
    // handler): every local edit is already broadcast to the server, which
    // serializes and stores it. PUTing the whole serialized snapshot from the
    // client would just duplicate that work — and a large canvas is tens of MB,
    // so echoing it on every edit stalled the single-threaded server for every
    // connected client. So for a document-backed canvas we only reflect save
    // status locally and let the server own persistence.
    if (host.documentId) {
      markSaved();
      return;
    }

    // Legacy path: a canvas not yet backed by a document has no Yjs room, so it
    // still needs an explicit create.
    state.saveState = "saving";
    dispatchSaveStatus();
    try {
      await host.save(serializeSnapshot());
      markSaved();
    } catch (err) {
      state.saveState = "idle";
      host.error(err instanceof Error ? err.message : String(err));
      dispatchSaveStatus();
    }
  }

  function scheduleSave() {
    if (!isReady) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void manualSave();
    }, 1200);
  }

  function saveImmediately() {
    if (!isReady) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void manualSave();
  }

  let cachedViewportRect: DOMRect | null = null;

  function screenPoint(event: MouseEvent) {
    return screenPointIn(event, cachedViewportRect);
  }

  const transform = () => buildTransform(state.camera, state.screen, FIT_REFERENCE);

  // --- camera ----------------------------------------------------------------
  // The canvas's entire scroll model; the viewport element never scrolls.

  // Owned here rather than by the controller: only `fitInitialView` reads it,
  // and it exists to make that call happen exactly once per document.
  let hasFitInitialView = false;

  /**
   * How much of the viewport's left edge the docked sidebar covers.
   *
   * Content is centred in the part the reader can actually see, not in the
   * full viewport, or it sits half behind the sidebar.
   */
  function reservedSidebarWidth(): number {
    if (typeof window === "undefined") return 0;
    // Below the md breakpoint the sidebar is an overlay drawer and reserves no space.
    if (!window.matchMedia("(min-width: 768px)").matches) return 0;
    const rect = document.querySelector(".sidebar")?.getBoundingClientRect();
    return Math.max(0, rect?.right ?? 0);
  }

  function moveToShape(shape: CanvasShape) {
    const bounds = shapeAabb(shape);
    const inset = reservedSidebarWidth();
    const scale = transform().scale;
    state.camera = {
      ...state.camera,
      // Center within the unobscured part of the canvas, not behind the sidebar.
      centerX: bounds.x + bounds.width / 2 - inset / (2 * scale),
      centerY: bounds.y + bounds.height / 2,
    };
    invalidate();
  }

  function fitView(maxZoom = 5) {
    // Accumulated rather than spread into Math.min/max: a freehand stroke can
    // carry tens of thousands of points, which overflows the argument stack.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let hasContent = false;

    for (const shape of state.shapes) {
      const bounds = shapeAabb(shape);
      if (bounds.x < minX) minX = bounds.x;
      if (bounds.y < minY) minY = bounds.y;
      if (bounds.x + bounds.width > maxX) maxX = bounds.x + bounds.width;
      if (bounds.y + bounds.height > maxY) maxY = bounds.y + bounds.height;
      hasContent = true;
    }
    for (const stroke of state.strokes) {
      for (const point of stroke.points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
        hasContent = true;
      }
    }

    const inset = reservedSidebarWidth();
    const baseScale = Math.min(
      state.screen.width / FIT_REFERENCE.width,
      state.screen.height / FIT_REFERENCE.height,
    );

    if (!hasContent) {
      // Center the world origin within the visible region (right of the nav).
      state.camera = { centerX: -inset / (2 * baseScale), centerY: 0, zoom: 1 };
      invalidate();
      return;
    }

    const width = Math.max(1, maxX - minX + 160);
    const height = Math.max(1, maxY - minY + 160);
    // Fit the content into the visible width, not the full (occluded) viewport.
    const availableWidth = Math.max(1, state.screen.width - inset);
    const fitScale = Math.min(availableWidth / width, state.screen.height / height);
    const zoom = Math.max(0.25, Math.min(maxZoom, fitScale / baseScale));
    const appliedScale = baseScale * zoom;

    state.camera = {
      // Shift the camera left by half the inset so the content centers in the
      // visible region rather than the full viewport.
      centerX: (minX + maxX) / 2 - inset / (2 * appliedScale),
      centerY: (minY + maxY) / 2,
      zoom,
    };
    invalidate();
  }

  /**
   * Frame the document the first time it has content, and never again.
   *
   * Content can arrive before or after the viewport is measured, so both the
   * Yjs sync and mount call this and whichever is second does the work.
   */
  function fitInitialView(isInitialContent: boolean) {
    if (hasFitInitialView || !isReady) return;
    if (state.shapes.length === 0 && state.strokes.length === 0) return;
    hasFitInitialView = true;
    // Frame the content but never magnify past 100% on load.
    if (isInitialContent) fitView(1);
  }

  /**
   * Bring a shape revealed by the browser's own find-in-page into view.
   *
   * Shapes are marked `hidden=until-found` so native find can reach their text.
   */
  function handleBrowserFindMatch(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const article = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
    const shapeId = article?.dataset.shapeId;
    const shape = shapeId ? shapesById().get(shapeId) : null;
    if (!article || !shape || !isBrowserFindTarget(shape)) return;

    moveToShape(shape);

    // The browser removes hidden=until-found after beforematch. Restore the
    // marker once it has finished revealing this match so advancing to another
    // result in the same shape emits beforematch again. The author-level
    // content-visibility:auto rule keeps these marked shapes normally visible.
    requestAnimationFrame(() => {
      if (article.isConnected) article.setAttribute("hidden", "until-found");
      // Native find may try to scroll the overflow-hidden viewport as well as
      // revealing the match. Camera state is the canvas's only scroll model.
      dom.viewport?.scrollTo(0, 0);
    });
  }

  const fitInitialViewIfNeeded = fitInitialView;

  // --- clipboard -------------------------------------------------------------
  // Copy, cut and paste are document I/O: they convert between shapes and an
  // external representation, and every change goes through the Yjs document.
  // Native clipboard events are synchronous and fire on `window`, so the window
  // handlers below pass the event straight in.

  async function pasteFromContextMenu() {
    const insertAt = contextMenuInsertWorld.current ?? insertionPointFromEvent();
    state.contextMenuPos = null;
    contextMenuInsertWorld.current = null;
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
      .filter((shape) => state.selectedIds.has(shape.id) && !shape.locked)
      .map((shape) => extensionManager.serialize(shape));
    const selStrokes = state.strokes
      .filter((stroke) => state.selectedIds.has(stroke.id) && !stroke.locked)
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

    setSelection(new Set([...pastedShapeIds, ...pastedStrokeIds]));
    state.activeTool = "select";
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

    setSelection(pastedShapeIds);
    state.activeTool = "select";
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

  // The canvas moves shapes by transforming the viewport, which fires no
  // scroll/resize event — so the fixed-position formatting toolbar won't follow
  // on its own. Re-anchor it after each transform is painted, so the editor DOM
  // reflects the new position when we read its coords.
  // Panning (middle/right-drag) shows the grabbing hand; otherwise the canvas uses
  // a local colored cursor that matches the color broadcast to collaborators.
  const viewportCursor = () => {
    if (state.isPanning) return "grabbing";
    return makeCanvasCursor(host.cursorColor);
  };

  function screenToWorld(point: { x: number; y: number }) {
    return viewportScreenToWorld(point.x, point.y, transform());
  }

  function worldToScreen(point: { x: number; y: number }) {
    return viewportWorldToScreen(point.x, point.y, transform());
  }

  // Cached CSS variable values — read once at mount and on theme change.
  // getComputedStyle().getPropertyValue() forces a style recalc so we must
  // not call it per-frame.
  let cssGridMajor = "rgba(15, 23, 42, 0.13)";
  let cssGridMinor = "rgba(15, 23, 42, 0.07)";
  let cssInkColor = FREEHAND_STYLE.color;
  let cssChromeText = "#1e3a8a";

  function refreshCssVars() {
    const theme = readCanvasTheme(dom.viewport, { ink: FREEHAND_STYLE.color });
    cssGridMajor = theme.gridMajor;
    cssGridMinor = theme.gridMinor;
    cssInkColor = theme.ink;
    cssChromeText = theme.chromeText;
  }

  function updateThemeMode() {
    state.isDarkMode = resolveDarkMode();
    invalidate();
    queueMicrotask(renderThemeChanged);
  }

  function renderThemeChanged() {
    refreshCssVars();
    renderInk();
  }

  function applyGridType(value: unknown) {
    const next: GridType =
      value === "clean" || value === "dots" || value === "grid" ? value : "dots";
    if (next === state.gridType) return;
    state.gridType = next;
    renderScene();
  }

  function defaultInkColor() {
    return cssInkColor;
  }

  /**
   * The strokes as the user currently sees them: stored geometry, with anything
   * under an in-flight gesture swapped for its preview. Everything that paints
   * or outlines ink reads this rather than `state.strokes`, so an outline can
   * never be drawn a frame behind the stroke it surrounds.
   */
  function renderedStrokes(): CanvasStroke[] {
    const preview = strokePreview;
    if (!preview) return state.strokes;
    const moved = preview.dx !== 0 || preview.dy !== 0;
    const replacements = new Map(
      preview.strokes.map((stroke) => [
        stroke.id,
        moved ? translateFreehandStroke(stroke, preview.dx, preview.dy) : stroke,
      ]),
    );
    return state.strokes.map((stroke) => replacements.get(stroke.id) ?? stroke);
  }

  const selectionSnapshot = () => ({
    strokes: renderedStrokes(),
    selectedStrokeIds: state.selectedIds,
    remoteSelectedStrokeIds: remoteCanvasStrokeSelections(),
    selectionBounds: selectedGroupBounds() ?? undefined,
    selectedShapeBounds: [...state.selectedIds]
      .map((id) => shapesById().get(id))
      .filter((shape) => shape != null)
      .map(shapeBounds),
    remoteSelectedShapeBounds: remoteCanvasSelections().map((selection) => ({
      x: selection.bounds.x,
      y: selection.bounds.y,
      width: selection.bounds.width,
      height: selection.bounds.height,
      rotation: selection.bounds.rotation,
      type: selection.bounds.type,
      color: selection.cursorColor,
    })),
  });

  // The camera changes every input frame. Keep the static world in one backing
  // store so a pan produces one compositor update instead of one per visual layer.
  function renderScene() {
    const canvas = dom.scene;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.setLineDash([]);
    context.clearRect(0, 0, state.screen.width, state.screen.height);
    context.save();
    renderGrid(context);
    context.restore();
    context.save();
    renderPaintedShapes(context);
    context.restore();
    context.save();
    renderRasterShapes(context);
    context.restore();
    context.save();
    renderTileShapes(context);
    context.restore();
    context.save();
    drawCanvasStrokes({
      context,
      screen: state.screen,
      transform: transform(),
      strokes: renderedStrokes(),
      defaultInkColor: defaultInkColor(),
    });
    context.restore();
  }

  /**
   * Shapes that paint from cached tiles. `refresh` decides for itself whether the
   * zoom moved far enough to re-rasterize; the engine cannot know.
   */
  function renderTileShapes(ctx: CanvasRenderingContext2D) {
    const t = transform();
    // Built once per frame, not per shape: the same for every tile source, and
    // computing it walks the camera maths.
    let view: CanvasTileView | null = null;
    let visible: Rect | null = null;
    for (const shape of state.shapes) {
      const source = extensionManager.get(shape.type).render.tiles;
      if (!source) continue;
      visible ??= worldViewportBounds(state.camera, state.screen, FIT_REFERENCE, 0);
      if (!rectsIntersect(visible, shapeAabb(shape))) continue;
      view ??= { scale: t.scale, dpr, visibleWorld: visible };
      source.refresh?.(shape, view, renderScene);
      const tiles = source.tiles(shape, view);
      if (!tiles?.length) continue;
      compositeTiles(ctx, shape.frame, tiles, t, source.clip?.(shape) ?? null);
    }
  }

  function renderGrid(context: CanvasRenderingContext2D) {
    if (state.gridType === "clean") return;

    if (state.gridType === "dots") {
      drawWorldDots(context, transform(), state.screen, {
        size: 40,
        color: cssGridMajor,
        radius: 1.2,
        minScreenSpacing: 8,
      });
      return;
    }

    drawWorldGrid(context, transform(), state.screen, {
      levels: [
        {
          size: 40,
          color: cssGridMinor,
          lineWidth: 1,
          minScreenSpacing: 8,
        },
        {
          size: 200,
          color: cssGridMajor,
          lineWidth: 1,
          minScreenSpacing: 24,
        },
      ],
    });
  }

  // Sections draw before raster elements and ink so their frames cannot overlap
  // cards, media, or strokes. The host owns their shared paint/hit-test geometry.
  function renderPaintedShapes(context: CanvasRenderingContext2D) {
    const helpers: CanvasPaintHelpers = {
      scale: transform().scale,
      dx: transform().dx,
      dy: transform().dy,
      t,
      chromeTextColor: cssChromeText,
      isEditingChrome: (id) => state.editingChromeId === id,
      chromePosition: elementChromePosition,
      chromeSize: elementChromeSize,
    };
    for (const shape of paintedShapes()) {
      extensionManager.paint(shape.type)?.(context, shape, helpers);
    }
  }

  function renderRasterShapes(ctx: CanvasRenderingContext2D) {
    for (const shape of visibleRasterShapes()) {
      extensionManager.get(shape.type).render.paintRaster?.(ctx, shape, {
        scale: transform().scale,
        dx: transform().dx,
        dy: transform().dy,
        dpr,
        invalidate: renderScene,
      });
    }
  }

  // Pointer events outrun frames; coalesce a gesture's repaints onto one.
  let inkRafId: number | null = null;
  function scheduleInkRender() {
    if (inkRafId !== null) return;
    inkRafId = requestAnimationFrame(() => {
      inkRafId = null;
      renderInk();
    });
  }

  let presenceRafId: number | null = null;
  function schedulePresenceUpdate() {
    if (presenceRafId !== null) return;
    presenceRafId = requestAnimationFrame(() => {
      presenceRafId = null;
      updatePresence();
    });
  }

  function renderInk() {
    renderScene();
    renderActiveInk();
    renderSelectionOverlay();
  }

  /**
   * Selection outlines, on their own surface because it is the only layer that
   * sits above the transformed DOM world — ink and shapes render below the
   * cards, an outline around a card must not.
   */
  function renderSelectionOverlay() {
    const canvas = dom.selection;
    const context = canvas?.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, state.screen.width, state.screen.height);
    drawCanvasSelections({ ...selectionSnapshot(), context, transform: transform() });
  }

  function renderActiveInk() {
    const canvas = dom.activeInk;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    renderCanvasInkOverlay({
      context,
      dpr,
      screen: state.screen,
      transform: transform(),
      activeStroke: activeFreehandStroke,
      snapGuides: activeSnapGuides,
      defaultInkColor: defaultInkColor(),
    });
  }

  function resize() {
    const rect = dom.viewport?.getBoundingClientRect() ?? null;
    cachedViewportRect = rect;
    state.screen = {
      width: Math.max(1, Math.round(rect?.width ?? 1)),
      height: Math.max(1, Math.round(rect?.height ?? 1)),
    };
    dpr = window.devicePixelRatio || 1;
    const scene = dom.scene;
    if (scene) {
      scene.width = Math.round(state.screen.width * dpr);
      scene.height = Math.round(state.screen.height * dpr);
      scene.style.width = `${state.screen.width}px`;
      scene.style.height = `${state.screen.height}px`;
    }
    const activeInk = dom.activeInk;
    if (activeInk) {
      activeInk.width = Math.round(state.screen.width * dpr);
      activeInk.height = Math.round(state.screen.height * dpr);
      activeInk.style.width = `${state.screen.width}px`;
      activeInk.style.height = `${state.screen.height}px`;
    }
    const selection = dom.selection;
    if (selection) {
      selection.width = Math.round(state.screen.width * dpr);
      selection.height = Math.round(state.screen.height * dpr);
      selection.style.width = `${state.screen.width}px`;
      selection.style.height = `${state.screen.height}px`;
    }
    renderInk();
  }

  function presenceState(): CanvasPresenceState {
    const cam = state.camera;
    const selectionIds = [...state.selectedIds];
    return {
      kind: "canvas",
      pointer: localPointer,
      cursorColor: host.cursorColor,
      view: { x: cam.centerX, y: cam.centerY, scale: cam.zoom },
      selectionIds,
      focusedNodeId: selectedShape()?.id ?? null,
      activeTool: state.activeTool,
    };
  }

  function updatePresence() {
    host.presenceChanged([presenceState()]);
  }

  function insertionPointFromEvent(event?: DragEvent | PointerEvent) {
    if (event) return screenToWorld(screenPoint(event));
    if (localPointer) return localPointer;
    return screenToWorld({
      x: state.screen.width / 2,
      y: state.screen.height / 2,
    });
  }

  function setActiveEditorRef(instance: unknown) {
    dom.activeEditorElement = (instance as HTMLElement | null) ?? null;
  }

  function stopActiveEdit() {
    const session = state.activeEditSession;
    if (!session) return;
    session.finish?.(dom.activeEditorElement);
    state.activeEditSession = null;
    dom.activeEditorElement = null;
  }

  // Insertion/engine services the tool extensions (draw/shape/create) drive.
  const canvasToolContext: CanvasToolContext = {
    penColor: () => state.penColor,
    property: <T extends CanvasToolPropertyValue>(id: string) =>
      toolPropertyValue(state.activeTool, id) as T,
    viewportScale: () => transform().scale,
    beginPointerGesture,
    clearSelection,
    setActiveStroke: (stroke) => {
      activeFreehandStroke = stroke;
      renderActiveInk();
    },
    insertStroke: insertCanvasStroke,
    selectStroke: selectOnly,
    createElement: (type, at) => addShape(type, at),
    setActiveTool: (tool) => {
      state.activeTool = tool;
    },
  };

  function insertCanvasStroke(stroke: CanvasStrokeSnapshot) {
    yStrokes.set(stroke.id, createStrokeMap(stroke));
  }

  function pointerGestureEvent(event: PointerEvent): CanvasPointerGestureEvent {
    return pointerGesture(event, cachedViewportRect, screenToWorld);
  }

  function releaseGesturePointer(gesture: ActiveToolPointerGesture) {
    releasePointerCapture(gesture.captureTarget, gesture.pointerId);
  }

  function cancelToolPointerGesture(reason: CanvasPointerGestureCancelReason) {
    const gesture = activeToolPointerGesture;
    if (!gesture) return false;
    activeToolPointerGesture = null;
    releaseGesturePointer(gesture);
    gesture.handlers.onCancel?.(reason, canvasToolContext);
    return true;
  }

  function beginPointerGesture(
    event: PointerEvent,
    handlers: CanvasPointerGestureHandlers,
  ) {
    cancelToolPointerGesture("superseded");
    const captureTarget =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : dom.viewport;
    const gesture: ActiveToolPointerGesture = {
      pointerId: event.pointerId,
      captureTarget,
      handlers,
    };
    activeToolPointerGesture = gesture;
    state.hoveredLockedElement = null;
    captureTarget?.setPointerCapture(event.pointerId);
    return {
      pointerId: event.pointerId,
      cancel: () => {
        if (activeToolPointerGesture === gesture) {
          cancelToolPointerGesture("cancelled");
        }
      },
    };
  }

  function moveToolPointerGesture(event: PointerEvent) {
    const gesture = activeToolPointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    gesture.handlers.onMove?.(pointerGestureEvent(event), canvasToolContext);
    return true;
  }

  function endToolPointerGesture(event: PointerEvent) {
    const gesture = activeToolPointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    activeToolPointerGesture = null;
    releaseGesturePointer(gesture);
    gesture.handlers.onEnd?.(pointerGestureEvent(event), canvasToolContext);
    return true;
  }

  function addShape(type: CanvasShapeType, at: { x: number; y: number }) {
    const extension = extensionManager.get(type);
    // The active swatch (if the type has a palette) feeds the factory; text has none.
    const shape = extension.creation?.create(at, { color: state.activeColors[type] });
    if (!shape) return;
    yShapes.set(shape.id, shapeToYMap(shape, extensionManager));
    selectOnly(shape.id);
    state.activeTool = "select";

    // Enter edit mode per the extension: a canvas-painted title overlay, or the
    // element's own rich-text editor.
    if (extension.creation?.editOnCreate === "chrome") {
      editElementChrome(shape);
    } else if (extension.creation?.editOnCreate === "element") {
      queueMicrotask(() => {
        document
          .querySelector<HTMLElement>(`.canvas-shape[data-shape-id="${shape.id}"] > *`)
          ?.focus();
      });
    }
  }

  function getContainerContents(container: CanvasShape, includeImmovable = false) {
    const extension = extensionManager.get(container.type);
    return {
      shapes: state.shapes
        .filter(
          (shape) =>
            shape.id !== container.id &&
            (includeImmovable || canMoveShape(shape)) &&
            extension.behavior.container?.containsBounds(container, shapeAabb(shape)),
        )
        .map((shape) => ({ id: shape.id, x: shape.frame.x, y: shape.frame.y })),
      strokes: state.strokes
        .filter(
          (stroke) =>
            (includeImmovable || canMoveStroke(stroke)) &&
            stroke.points.length > 0 &&
            stroke.points.every((point) =>
              extension.behavior.container?.containsPoint(container, point),
            ),
        )
        .map((stroke) => ({
          id: stroke.id,
          points: stroke.points.map(cloneFreehandPoint),
        })),
    };
  }

  function translateStroke(id: string, points: FreehandPoint[], dx: number, dy: number) {
    updateStrokePoints(
      id,
      points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
    );
  }

  function strokeFromTransformedPoints(
    stroke: CanvasStroke,
    points: FreehandPoint[],
    rotation = stroke.rotation,
  ) {
    return toCanvasStroke(stroke.id, {
      id: stroke.id,
      points,
      style: { ...stroke.style },
      kind: stroke.kind,
      rotation,
      authorId: stroke.authorId,
      locked: stroke.locked,
      updatedAt: stroke.updatedAt,
    });
  }

  function updateStrokePoints(id: string, points: FreehandPoint[], rotation?: number) {
    const stroke = yStrokes.get(id);
    if (!stroke) return;
    const currentStroke = strokesById().get(id);
    if (currentStroke && !canMoveStroke(currentStroke)) return;
    stroke.set("updatedAt", Date.now());
    stroke.set("points", points.map(cloneFreehandPoint));
    if (rotation !== undefined) stroke.set("rotation", rotation);
  }

  // Sets the swatch used by the active creation tool. This deliberately does not
  // affect a selected shape: tool defaults and selected-element properties are
  // rendered in separate toolbars.
  function setActiveElementColor(type: CanvasShapeType, color: string) {
    state.activeColors = { ...state.activeColors, [type]: color };
  }

  // Recolors only the selected shape. Creation defaults remain owned by the
  // active-tool toolbar.
  /** The shape a resize/rotate drag is acting on, if either is in progress. */
  function draggingShapeId(): string | undefined {
    return dragState && "shapeId" in dragState ? dragState.shapeId : undefined;
  }

  function setSelectedElementColor(type: CanvasShapeType, color: string) {
    const shape = selectedShape();
    if (shape?.type === type) updateShapeStyle(shape.id, { color });
  }

  function toolPropertyValue(tool: CanvasToolId, id: string): CanvasToolPropertyValue {
    const current = state.toolProperties[tool]?.[id];
    if (current !== undefined) return current;
    // A tool registered after state was seeded still answers with its default.
    const declared = extensionManager.toolProperties(tool).find((p) => p.id === id);
    return declared?.default ?? "";
  }

  /** Controls the active tool contributes to the properties bar. */
  const activeToolProperties = () => extensionManager.toolProperties(state.activeTool);

  function setToolProperty(id: string, value: CanvasToolPropertyValue) {
    const tool = state.activeTool;
    state.toolProperties = {
      ...state.toolProperties,
      [tool]: { ...state.toolProperties[tool], [id]: value },
    };
  }

  const activeToolColorPalettes = () =>
    colorPalettes.filter((entry) => state.activeTool === entry.type);

  const selectedShapeColorPalette = () =>
    colorPalettes.find((entry) => entry.type === selectedShape()?.type);

  const hasSelectedElementProperties = () =>
    selectedShapeColorPalette() !== undefined || selectedStrokeColor() !== null;

  const hasToolProperties = () =>
    activeToolProperties().length > 0 || activeToolColorPalettes().length > 0;

  function pickShapeLibraryItem(item: CanvasShapeLibraryItem) {
    setActiveShapeId(item.id);
    state.activeTool = "shape";
    dom.shapePopover?.hide();
  }

  function setActivePenColor(color: string) {
    state.penColor = color;
  }

  function setSelectedStrokeColor(color: string) {
    ydoc.transact(() => {
      for (const id of state.selectedIds) {
        const stroke = yStrokes.get(id);
        if (!stroke) continue;
        const style = strokeStyleFromUnknown(stroke.get("style"));
        stroke.set("style", { ...style, color });
        stroke.set("updatedAt", Date.now());
      }
    });
  }

  function updateShapeFrame(id: string, patch: Partial<CanvasFrame>) {
    const shape = yShapes.get(id);
    if (!shape) return;
    const currentShape = shapesById().get(id);
    if (currentShape && !canMoveShape(currentShape)) return;
    shape.set("updatedAt", Date.now());
    const persistsSize = extensionManager.persistsSize(
      shape.get("type") as CanvasShapeType,
    );
    const frame = shape.get("frame");
    if (!(frame instanceof Y.Map)) return;
    for (const [key, value] of Object.entries(patch)) {
      if (!persistsSize && (key === "width" || key === "height")) continue;
      frame.set(key, value);
    }
  }

  function updateShapeStyle(id: string, patch: Partial<CanvasShape["style"]>) {
    const shape = yShapes.get(id);
    const style = shape?.get("style");
    if (!shape || !(style instanceof Y.Map)) return;
    shape.set("updatedAt", Date.now());
    for (const [key, value] of Object.entries(patch)) style.set(key, value);
  }

  function updateShapeData(
    id: string,
    patch: Record<string, unknown>,
    options: { transform?: boolean } = {},
  ) {
    const shape = yShapes.get(id);
    const data = shape?.get("data");
    if (!shape || !(data instanceof Y.Map)) return;
    const currentShape = shapesById().get(id);
    if (options.transform && currentShape && !canMoveShape(currentShape)) return;
    shape.set("updatedAt", Date.now());
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    }
  }

  function setShapeLocked(id: string, locked: boolean) {
    const shape = yShapes.get(id);
    if (!shape) return;
    shape.set("updatedAt", Date.now());
    if (locked) shape.set("locked", true);
    else shape.delete("locked");
  }

  function setStrokeLocked(id: string, locked: boolean) {
    const stroke = yStrokes.get(id);
    if (!stroke) return;
    stroke.set("updatedAt", Date.now());
    if (locked) stroke.set("locked", true);
    else stroke.delete("locked");
  }

  function lockSelectedElements() {
    if (state.selectedIds.size === 0) return;
    const shapeIds = new Set<string>();
    const strokeIds = new Set<string>();
    for (const id of state.selectedIds) {
      if (shapesById().has(id)) shapeIds.add(id);
      else if (strokesById().has(id)) strokeIds.add(id);
    }

    // A container cascades locking to everything inside its bounds, including
    // elements already locked or user-scoped to someone else.
    for (const id of state.selectedIds) {
      const container = shapesById().get(id);
      if (!isContainerShape(container) || !container) continue;
      const contents = getContainerContents(container, true);
      for (const shape of contents.shapes) shapeIds.add(shape.id);
      for (const stroke of contents.strokes) strokeIds.add(stroke.id);
    }

    ydoc.transact(() => {
      for (const id of shapeIds) setShapeLocked(id, true);
      for (const id of strokeIds) setStrokeLocked(id, true);
    });
    clearSelection();
  }

  function unlockHoveredElement() {
    const element = state.hoveredLockedElement;
    if (!element) return;
    if (element.type === "shape") setShapeLocked(element.id, false);
    else setStrokeLocked(element.id, false);
    state.hoveredLockedElement = null;
  }

  function deleteSelectedShape() {
    if (state.selectedIds.size === 0) return;
    ydoc.transact(() => {
      for (const id of state.selectedIds) {
        if (isElementLocked(id)) continue;
        yShapes.delete(id);
        yStrokes.delete(id);
      }
    });
    clearSelection();
  }

  // Snapshots the start positions of everything that should move with a shape
  // drag: the whole current selection, plus the contents of any selected
  // section. Strokes are deduped against section contents so a stroke that is
  // both selected and inside a dragged section only moves once.
  function buildShapeDragState(
    event: PointerEvent,
  ): Extract<DragState, { type: "shape" }> {
    const moveShapes = new Map<string, { id: string; x: number; y: number }>();
    const moveStrokes = new Map<string, { id: string; points: FreehandPoint[] }>();

    for (const id of state.selectedIds) {
      const shape = shapesById().get(id);
      if (!shape || !canMoveShape(shape)) continue;
      moveShapes.set(shape.id, { id: shape.id, x: shape.frame.x, y: shape.frame.y });
      if (isContainerShape(shape)) {
        const contents = getContainerContents(shape);
        for (const s of contents.shapes)
          if (!moveShapes.has(s.id)) moveShapes.set(s.id, s);
        for (const s of contents.strokes)
          if (!moveStrokes.has(s.id)) moveStrokes.set(s.id, s);
      }
    }
    for (const id of state.selectedIds) {
      if (moveStrokes.has(id)) continue;
      const stroke = strokesById().get(id);
      if (stroke && canMoveStroke(stroke)) {
        moveStrokes.set(id, { id, points: stroke.points.map(cloneFreehandPoint) });
      }
    }

    return {
      type: "shape",
      pointerId: event.pointerId,
      startPointer: screenToWorld(screenPoint(event)),
      shapes: [...moveShapes.values()],
      strokes: [...moveStrokes.values()],
    };
  }

  function startStrokeTransformInteraction(strokesToMove: CanvasStroke[]) {
    if (strokesToMove.length === 0) return;
    strokePreview = { strokes: strokesToMove, dx: 0, dy: 0, changed: false };
    renderInk();
  }

  /** Replacement geometry, for the gestures that reshape a stroke. */
  function updateStrokeTransformInteraction(transformedStrokes: CanvasStroke[]) {
    if (!strokePreview) return;
    strokePreview = { strokes: transformedStrokes, dx: 0, dy: 0, changed: true };
    scheduleInkRender();
  }

  /** A plain move, which leaves the captured geometry alone. */
  function offsetStrokeTransformInteraction(dx: number, dy: number) {
    if (!strokePreview) return;
    strokePreview = { ...strokePreview, dx, dy, changed: true };
    scheduleInkRender();
  }

  function cancelStrokeTransformInteraction() {
    if (!strokePreview) return;
    strokePreview = null;
    renderInk();
  }

  function beginDragStrokeTransform(drag: Extract<DragState, { type: "shape" }>) {
    startStrokeTransformInteraction(
      drag.strokes.flatMap((item) => {
        const stroke = strokesById().get(item.id);
        return stroke ? [stroke] : [];
      }),
    );
  }

  function startShapeDrag(shape: CanvasShape, event: PointerEvent) {
    if (event.button !== 0) return;
    if (shape.locked) {
      event.preventDefault();
      return;
    }

    // Shift toggles membership and does not begin a drag.
    if (event.shiftKey) {
      toggleSelection(shape.id);
      if (suppressesNativePointer(shape)) event.preventDefault();
      return;
    }

    // Clicking a shape outside the current selection collapses to just it;
    // clicking one already inside keeps the selection so the whole group drags.
    if (!state.selectedIds.has(shape.id)) {
      selectOnly(shape.id);
    }

    if (!canMoveShape(shape)) {
      if (suppressesNativePointer(shape)) event.preventDefault();
      return;
    }

    dragMoved = false;
    dragState = buildShapeDragState(event);
    beginDragStrokeTransform(dragState);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (suppressesNativePointer(shape)) {
      event.preventDefault();
    }
  }

  function startShapeResize(shape: CanvasShape, event: PointerEvent) {
    if (event.button !== 0 || !canMoveShape(shape)) return;
    selectOnly(shape.id);
    // Text auto-sizes to its content, so drive off its measured box.
    const bounds = shapeBounds(shape);
    const resizeMode = extensionManager.get(shape.type).behavior.transform;
    const usesIntrinsicScale = resizeMode?.resize === "font";
    const keepAspect = Boolean(resizeMode?.aspectLocked) || usesIntrinsicScale;
    dragState = {
      type: "resize",
      pointerId: event.pointerId,
      shapeId: shape.id,
      fixedTopLeft: rotatedShapeCorners(bounds)[0],
      minSize: extensionManager.get(shape.type).defaults.minSize,
      aspect: keepAspect && bounds.height > 0 ? bounds.width / bounds.height : undefined,
      resizeMode: usesIntrinsicScale ? "font" : "box",
      initialScale: Number(shape.data.fontScale) || 1,
      initial: {
        x: shape.frame.x,
        y: shape.frame.y,
        width: bounds.width,
        height: bounds.height,
        rotation: shape.frame.rotation,
      },
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function startSelectionScale(selection: ScalableSelection, event: PointerEvent) {
    if (event.button !== 0) return;
    const { bounds } = selection;
    const shapes = selection.elements.flatMap((element) => {
      const shape = element.kind === "shape" ? shapesById().get(element.id) : undefined;
      return shape ? [shape] : [];
    });
    const strokes = selection.elements.flatMap((element) => {
      const stroke =
        element.kind === "stroke" ? strokesById().get(element.id) : undefined;
      return stroke ? [stroke] : [];
    });

    let minimumScale = 0.05;
    for (const shape of shapes) {
      const transform = extensionManager.get(shape.type).behavior.transform;
      if (transform.resize === "font") {
        minimumScale = Math.max(
          minimumScale,
          MIN_FONT_SCALE / (Number(shape.data.fontScale) || 1),
        );
        continue;
      }
      const minSize = extensionManager.get(shape.type).defaults.minSize;
      minimumScale = Math.max(
        minimumScale,
        minSize.width / Math.max(1, shape.frame.width),
        minSize.height / Math.max(1, shape.frame.height),
      );
    }
    dragState = {
      type: "selection-scale",
      pointerId: event.pointerId,
      origin: { x: bounds.x, y: bounds.y },
      startBounds: { ...bounds },
      // Keep every selected item above its own supported minimum size.
      minSize: {
        width: Math.max(1, bounds.width * minimumScale),
        height: Math.max(1, bounds.height * minimumScale),
      },
      shapes: shapes.map((shape) => ({
        id: shape.id,
        frame: { ...shape.frame },
        resizeMode: extensionManager.get(shape.type).behavior.transform.resize as
          | "box"
          | "font",
        fontScale: Number(shape.data.fontScale) || 1,
      })),
      strokes: strokes.map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map(cloneFreehandPoint),
      })),
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  /** Starts a rotate on whichever store the element lives in. */
  function startRotation(element: CanvasElementHandle, event: PointerEvent) {
    const stroke = strokesById().get(element.id);
    if (stroke) return startStrokeRotation(stroke, event);
    const shape = shapesById().get(element.id);
    if (shape) startShapeRotation(shape, event);
  }

  /** Starts a resize on whichever store the element lives in. */
  function startResize(element: CanvasElementHandle, event: PointerEvent) {
    const stroke = strokesById().get(element.id);
    if (stroke) return startStrokeResize(stroke, event);
    const shape = shapesById().get(element.id);
    if (shape) startShapeResize(shape, event);
  }

  function startShapeRotation(shape: CanvasShape, event: PointerEvent) {
    const canRotate = extensionManager.get(shape.type).behavior.transform.rotate;
    if (event.button !== 0 || !canRotate || !canMoveShape(shape)) return;
    selectOnly(shape.id);
    const bounds = shapeBounds(shape);
    dragState = {
      type: "rotate",
      pointerId: event.pointerId,
      shapeId: shape.id,
      center: {
        x: shape.frame.x + bounds.width / 2,
        y: shape.frame.y + bounds.height / 2,
      },
      initial: {
        x: shape.frame.x,
        y: shape.frame.y,
        width: bounds.width,
        height: bounds.height,
        rotation: shape.frame.rotation,
      },
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function startStrokeResize(stroke: CanvasStroke, event: PointerEvent) {
    if (event.button !== 0 || !canMoveStroke(stroke)) return;
    const bounds = strokeBounds(stroke);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    dragState = {
      type: "stroke-resize",
      pointerId: event.pointerId,
      strokeId: stroke.id,
      fixedTopLeft: { x: bounds.x, y: bounds.y },
      startBounds: bounds,
      initialPoints: stroke.points.map(cloneFreehandPoint),
    };
    startStrokeTransformInteraction([stroke]);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function startStrokeRotation(stroke: CanvasStroke, event: PointerEvent) {
    if (event.button !== 0 || !canMoveStroke(stroke)) return;
    const bounds = strokeBounds(stroke);
    if (!bounds) return;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    dragState = {
      type: "stroke-rotate",
      pointerId: event.pointerId,
      strokeId: stroke.id,
      center,
      startRotation: rotationFromPointer(center, screenToWorld(screenPoint(event))),
      initialRotation: stroke.rotation ?? 0,
      initialPoints: stroke.points.map(cloneFreehandPoint),
    };
    startStrokeTransformInteraction([stroke]);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function startPan(event: PointerEvent) {
    dragState = {
      type: "pan",
      pointerId: event.pointerId,
      startPointer: { x: event.clientX, y: event.clientY },
      startCamera: state.camera,
    };
    state.isPanning = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function startMarquee(event: PointerEvent, additive: boolean) {
    if (!additive) clearSelection();
    const start = screenPoint(event);
    dragState = {
      type: "marquee",
      pointerId: event.pointerId,
      additive,
      startScreen: start,
      baseIds: new Set(state.selectedIds),
    };
    state.marqueeRect = { x: start.x, y: start.y, width: 0, height: 0 };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  // Recomputes the selection from the marquee rectangle. Sections must be fully
  // enclosed to be picked up (a marquee inside a big section selects its
  // contents, not the section); every other shape selects on intersection.
  function applyMarqueeSelection(
    drag: Extract<DragState, { type: "marquee" }>,
    rect: Rect,
  ) {
    const topLeft = screenToWorld({ x: rect.x, y: rect.y });
    const bottomRight = screenToWorld({
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    });
    const worldRect: Rect = {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    };

    const ids = new Set(drag.additive ? drag.baseIds : []);
    for (const shape of state.shapes) {
      if (shape.locked) continue;
      const bounds = shapeAabb(shape);
      const hit = isContainerShape(shape)
        ? rectContains(worldRect, bounds)
        : rectsIntersect(worldRect, bounds);
      if (hit) ids.add(shape.id);
    }
    for (const stroke of state.strokes) {
      if (stroke.locked) continue;
      if (stroke.points.some((point) => isPointInRect(point, worldRect))) {
        ids.add(stroke.id);
      }
    }

    setSelection(ids);
  }

  // Shared geometry the canvas-painted extensions' hitTest hooks need. The host
  // keeps the z-order (below) and calls ext.hitTest per shape.
  const hitTestHelpers: CanvasHitTestHelpers = {
    worldToScreen: (point) => worldToScreen(point),
    chromePosition: elementChromePosition,
    chromeSize: elementChromeSize,
  };

  // Canvas-rasterized shapes (still images), topmost first, via each shape's own
  // hitTest hook. DOM shapes hit-test through native events, so they are skipped.
  function hitTestRasterShape(worldPoint: { x: number; y: number }): CanvasShape | null {
    for (let i = state.shapes.length - 1; i >= 0; i--) {
      const shape = state.shapes[i];
      if (!extensionManager.rasters(shape)) continue;
      if (
        extensionManager
          .get(shape.type)
          .render.hitTest?.(shape, worldPoint, hitTestHelpers)
      ) {
        return shape;
      }
    }
    return null;
  }

  // Canvas-painted shapes (sections), topmost first, via each shape's own hitTest
  // hook. Returns which region was hit (title = editable, border = grabbable;
  // interior click-through).
  function hitTestPaintedShape(worldPoint: {
    x: number;
    y: number;
  }): { shape: CanvasShape; region: "title" | "border" } | null {
    for (let i = paintedShapes().length - 1; i >= 0; i--) {
      const shape = paintedShapes()[i];
      const region = extensionManager
        .get(shape.type)
        .render.hitTest?.(shape, worldPoint, hitTestHelpers);
      if (region === "title" || region === "border") return { shape, region };
    }
    return null;
  }

  function editElementChrome(shape: CanvasShape) {
    if (shape.locked) return;
    selectOnly(shape.id);
    state.editingChromeId = shape.id;
    renderScene();
    void Promise.resolve().then(() => {
      dom.viewport
        ?.querySelector<HTMLElement>(`[data-editor-shape-id="${shape.id}"]`)
        ?.focus();
    });
  }

  function finishChromeEditing() {
    if (!state.editingChromeId) return;
    state.editingChromeId = null;
    renderScene();
  }

  function handleViewportPointerDown(event: PointerEvent) {
    if (event.pointerType === "touch" && !event.isPrimary) return;

    // Dismiss context menu on any tap outside of it (the menu itself stops
    // propagation with @pointerdown.stop so taps inside it don't reach here).
    if (state.contextMenuPos) {
      state.contextMenuPos = null;
      contextMenuInsertWorld.current = null;
      return;
    }

    // The handlers below call preventDefault(), which suppresses the browser's
    // default focus shift — so without this the canvas never holds focus and
    // copy/cut/paste events are never dispatched to it. Shape/text pointerdowns
    // use @pointerdown.stop, so this only fires for empty-canvas/stroke clicks
    // and won't pull focus out of a text shape being edited.
    dom.viewport?.focus({ preventScroll: true });

    const point = screenPoint(event);
    localPointer = screenToWorld(point);
    state.localPointerScreen = point;

    if (event.button === 1 || event.button === 2) {
      startPan(event);
      event.preventDefault();
      return;
    }

    if (state.activeTool === "select") {
      const additive = event.shiftKey;
      const worldPoint = screenToWorld(point);

      const hitImage = hitTestRasterShape(worldPoint);
      if (hitImage) {
        if (hitImage.locked) {
          event.preventDefault();
          return;
        }
        if (additive) {
          toggleSelection(hitImage.id);
        } else if (!state.selectedIds.has(hitImage.id)) {
          selectOnly(hitImage.id);
        }
        if (!canMoveShape(hitImage)) {
          event.preventDefault();
          return;
        }
        dragMoved = false;
        dragState = buildShapeDragState(event);
        beginDragStrokeTransform(dragState);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      const hitStroke = hitTestCanvasStroke(state.strokes, worldPoint, transform().scale);
      if (hitStroke) {
        if (isElementLocked(hitStroke)) {
          event.preventDefault();
          return;
        }
        // Match regular shapes: Shift only changes selection membership, while
        // a normal pointerdown selects the stroke and starts a drag for the
        // current stroke selection.
        if (additive) {
          toggleSelection(hitStroke);
          event.preventDefault();
          return;
        }
        // Grabbing a stroke that's already part of the selection keeps the whole
        // group (including any selected shapes/text) so it all drags together;
        // grabbing an unselected stroke collapses to just it.
        if (!state.selectedIds.has(hitStroke)) {
          selectOnly(hitStroke);
        }
        const stroke = strokesById().get(hitStroke);
        if (!stroke || !canMoveStroke(stroke)) {
          event.preventDefault();
          return;
        }
        dragMoved = false;
        dragState = buildShapeDragState(event);
        beginDragStrokeTransform(dragState);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      const paintedHit = hitTestPaintedShape(worldPoint);
      if (paintedHit) {
        startShapeDrag(paintedHit.shape, event);
        return;
      }

      // Empty space: touch leaves panning/zooming to the two-finger gesture
      // handler; mouse/pen drag-selects with a marquee.
      if (event.pointerType === "touch") {
        if (!additive) clearSelection();
        return;
      }
      startMarquee(event, additive);
      return;
    }

    // Non-select tools (draw / shape / note / text / section) dispatch to their
    // tool extension.
    extensionManager
      .tool(state.activeTool)
      ?.onPointerDown(screenToWorld(point), event, canvasToolContext);
    event.preventDefault();
  }

  function handleViewportDoubleClick(event: MouseEvent) {
    // A double-click is an empty-canvas shortcut for text. A section title is
    // the exception: it opens that title for editing.
    if (state.activeTool === "draw") return;

    const point = screenPoint(event);
    const worldPoint = screenToWorld(point);
    const paintedHit = hitTestPaintedShape(worldPoint);
    if (paintedHit?.region === "title") {
      event.preventDefault();
      editElementChrome(paintedHit.shape);
      return;
    }

    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".canvas-shape, .canvas-transform-controls, .canvas-context-menu")
    ) {
      return;
    }

    if (paintedHit?.region === "border") {
      return;
    }
    if (
      hitTestRasterShape(worldPoint) ||
      hitTestCanvasStroke(state.strokes, worldPoint, transform().scale)
    ) {
      return;
    }

    event.preventDefault();
    const type = extensionManager.doubleClickType();
    if (type) addShape(type, worldPoint);
  }

  // World-space bounding box of everything moving in a shape drag, at its
  // starting position. Stroke point extents are included so freehand selections
  // snap by their drawn bounds too.
  function movingGroupBounds(
    drag: Extract<DragState, { type: "shape" }>,
  ): WorldRect | null {
    const boxes: Rect[] = [];
    for (const moved of drag.shapes) {
      const shape = shapesById().get(moved.id);
      if (!shape) continue;
      boxes.push(
        shapeAabb({ ...shape, frame: { ...shape.frame, x: moved.x, y: moved.y } }),
      );
    }
    for (const stroke of drag.strokes) {
      const bounds = boundsOfPoints(stroke.points);
      if (bounds) boxes.push(bounds);
    }
    return unionBounds(boxes);
  }

  /** Binds the drag's moving group and the shapes it can snap against. */
  function snapDragOffset(
    drag: Extract<DragState, { type: "shape" }>,
    dx: number,
    dy: number,
    disabled: boolean,
  ): { dx: number; dy: number } {
    const movingIds = new Set(drag.shapes.map((moved) => moved.id));
    const snap = snapDrag({
      bounds: movingGroupBounds(drag),
      dx,
      dy,
      disabled,
      scale: transform().scale,
      camera: state.camera,
      screen: state.screen,
      fit: FIT_REFERENCE,
      candidates: state.shapes
        .filter((shape) => !movingIds.has(shape.id))
        .map((shape) => ({ id: shape.id, bounds: shapeAabb(shape) })),
    });
    activeSnapGuides = snap.guides;
    return { dx: snap.dx, dy: snap.dy };
  }

  function lockedElementAtPointer(event: PointerEvent): LockedCanvasElement | null {
    const target = event.target;
    if (target instanceof Element) {
      const shapeElement = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
      const shapeId = shapeElement?.dataset.shapeId;
      if (shapeId) {
        return isElementLocked(shapeId) ? { type: "shape", id: shapeId } : null;
      }
    }

    const rect = cachedViewportRect;
    if (
      !rect ||
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return null;
    }

    const worldPoint = screenToWorld(screenPoint(event));
    const image = hitTestRasterShape(worldPoint);
    if (image?.locked) return { type: "shape", id: image.id };

    if (hasLockedStrokes()) {
      const strokeId = hitTestCanvasStroke(state.strokes, worldPoint, transform().scale);
      if (strokeId && isElementLocked(strokeId)) return { type: "stroke", id: strokeId };
    }

    const paintedShape = hitTestPaintedShape(worldPoint)?.shape ?? null;
    if (paintedShape?.locked) return { type: "shape", id: paintedShape.id };
    return null;
  }

  function updateHoveredLockedElement(event: PointerEvent) {
    const target = event.target;
    if (target instanceof Element && target.closest(".canvas-unlock-button")) return;

    const next = lockedElementAtPointer(event);
    const current = state.hoveredLockedElement;
    if (current?.type === next?.type && current?.id === next?.id) return;
    state.hoveredLockedElement = next;
  }

  function handlePointerMove(event: PointerEvent) {
    const point = screenPoint(event);
    localPointer = screenToWorld(point);
    const viewportBounds = dom.viewport?.getBoundingClientRect();
    state.localPointerScreen =
      viewportBounds &&
      event.clientX >= viewportBounds.left &&
      event.clientX <= viewportBounds.right &&
      event.clientY >= viewportBounds.top &&
      event.clientY <= viewportBounds.bottom
        ? point
        : null;

    if (moveToolPointerGesture(event)) {
      schedulePresenceUpdate();
      event.preventDefault();
      return;
    }

    updateHoveredLockedElement(event);

    if (!dragState || dragState.pointerId !== event.pointerId) {
      schedulePresenceUpdate();
      return;
    }

    const drag = dragState;
    dragBehavior(drag).move(drag, {
      event,
      screen: point,
      world: screenToWorld(point),
    });
  }

  type DragMove = {
    event: PointerEvent;
    /** Pointer in viewport pixels. */
    screen: { x: number; y: number };
    /** The same point in world coordinates. */
    world: { x: number; y: number };
  };

  /**
   * What one kind of drag does, in one place.
   *
   * A drag used to be spelled out four times — in the `DragState` union, in its
   * `startX`, in a branch of `handlePointerMove`, and again in the commit and
   * cancel paths — several hundred lines apart, so adding a gesture meant
   * finding all four. Here a gesture is a `DragState` variant and one entry.
   */
  type DragBehavior<S> = {
    move: (drag: S, at: DragMove) => void;
    /** Applied when the pointer is released. */
    commit?: (drag: S) => void;
    /** Puts back what the gesture changed. Present only where Escape aborts it. */
    revert?: (drag: S) => void;
    /** Runs however the gesture ended, before `dragState` is cleared. */
    end?: (drag: S) => void;
  };

  const DRAG_BEHAVIORS: {
    [K in DragState["type"]]: DragBehavior<Extract<DragState, { type: K }>>;
  } = {
    pan: {
      move(drag, { event }) {
        state.camera = panCameraByScreenDelta({
          camera: drag.startCamera,
          screen: state.screen,
          fit: FIT_REFERENCE,
          dxPx: drag.startPointer.x - event.clientX,
          dyPx: drag.startPointer.y - event.clientY,
        });
        schedulePresenceUpdate();
      },
      end() {
        state.isPanning = false;
      },
    },

    marquee: {
      move(drag, { screen }) {
        const rect: Rect = {
          x: Math.min(drag.startScreen.x, screen.x),
          y: Math.min(drag.startScreen.y, screen.y),
          width: Math.abs(screen.x - drag.startScreen.x),
          height: Math.abs(screen.y - drag.startScreen.y),
        };
        state.marqueeRect = rect;
        applyMarqueeSelection(drag, rect);
        schedulePresenceUpdate();
      },
      end() {
        state.marqueeRect = null;
      },
    },

    shape: {
      move(drag, { event, world }) {
        // A few pixels of travel (in screen space) promotes this from a click to
        // a drag, so a click on a document card opens it instead of nudging it.
        if (
          !dragMoved &&
          Math.hypot(world.x - drag.startPointer.x, world.y - drag.startPointer.y) *
            transform().scale >
            3
        ) {
          dragMoved = true;
        }
        const { dx, dy } = snapDragOffset(
          drag,
          world.x - drag.startPointer.x,
          world.y - drag.startPointer.y,
          event.metaKey,
        );
        ydoc.transact(() => {
          for (const moved of drag.shapes) {
            const shape = shapesById().get(moved.id);
            if (!shape || !canMoveShape(shape)) continue;
            updateShapeFrame(moved.id, {
              x: Math.round(moved.x + dx),
              y: Math.round(moved.y + dy),
            });
          }
        });
        offsetStrokeTransformInteraction(dx, dy);
        // Yjs shape edits don't trigger an ink redraw, so guides won't appear
        // without this explicit render.
        scheduleInkRender();
      },
      commit(drag) {
        const preview = takeStrokePreview();
        if (!preview) return;
        // Only the strokes this drag captured move; `state.strokes` would sweep
        // up every stroke on the canvas.
        ydoc.transact(() => {
          for (const stroke of drag.strokes) {
            translateStroke(stroke.id, stroke.points, preview.dx, preview.dy);
          }
        });
      },
      end() {
        strokePreview = null;
      },
    },

    resize: {
      move(drag, { world }) {
        const shape = shapesById().get(drag.shapeId);
        if (!shape || !canMoveShape(shape)) return;
        const resized = resizeRotatedShapeFromBottomRight({
          fixedTopLeft: drag.fixedTopLeft,
          pointer: world,
          rotation: drag.initial.rotation,
          minSize: drag.minSize,
          aspect: drag.aspect,
        });
        if (drag.resizeMode === "font") {
          // Text has no stored box; translate the drag into a proportional font
          // scale and let the node re-measure its own width/height. Top-left
          // stays put, so it grows toward the corner being dragged.
          const ratio = drag.initial.width > 0 ? resized.width / drag.initial.width : 1;
          const nextScale = clampFontScale((drag.initialScale ?? 1) * ratio);
          updateShapeData(
            drag.shapeId,
            { fontScale: Math.round(nextScale * 1000) / 1000 },
            { transform: true },
          );
          return;
        }
        updateShapeFrame(drag.shapeId, {
          x: Math.round(resized.x),
          y: Math.round(resized.y),
          width: Math.round(resized.width),
          height: Math.round(resized.height),
        });
      },
      revert: revertShapeFrameDrag,
    },

    rotate: {
      move(drag, { event, world }) {
        const shape = shapesById().get(drag.shapeId);
        if (!shape || !canMoveShape(shape)) return;
        const rawRotation = rotationFromPointer(drag.center, world);
        const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
        updateShapeFrame(drag.shapeId, { rotation: Math.round(rotation * 10) / 10 });
      },
      revert: revertShapeFrameDrag,
    },

    "selection-scale": {
      move(drag, { world }) {
        const resized = resizeRotatedShapeFromBottomRight({
          fixedTopLeft: drag.origin,
          pointer: world,
          rotation: 0,
          minSize: drag.minSize,
          aspect: drag.startBounds.width / drag.startBounds.height,
        });
        const scale = resized.width / drag.startBounds.width;
        ydoc.transact(() => {
          for (const shape of drag.shapes) {
            const nextFrame = {
              x: drag.origin.x + (shape.frame.x - drag.origin.x) * scale,
              y: drag.origin.y + (shape.frame.y - drag.origin.y) * scale,
            };
            if (shape.resizeMode === "font") {
              updateShapeFrame(shape.id, nextFrame);
              updateShapeData(
                shape.id,
                {
                  fontScale:
                    Math.round(clampFontScale(shape.fontScale * scale) * 1000) / 1000,
                },
                { transform: true },
              );
              continue;
            }
            updateShapeFrame(shape.id, {
              ...nextFrame,
              width: Math.round(shape.frame.width * scale),
              height: Math.round(shape.frame.height * scale),
            });
          }
          for (const stroke of drag.strokes) {
            updateStrokePoints(
              stroke.id,
              stroke.points.map((point) => ({
                ...point,
                x: drag.origin.x + (point.x - drag.origin.x) * scale,
                y: drag.origin.y + (point.y - drag.origin.y) * scale,
              })),
            );
          }
        });
      },
      revert(drag) {
        ydoc.transact(() => {
          for (const shape of drag.shapes) {
            updateShapeFrame(shape.id, shape.frame);
            if (shape.resizeMode === "font") {
              updateShapeData(
                shape.id,
                { fontScale: shape.fontScale },
                { transform: true },
              );
            }
          }
          for (const stroke of drag.strokes) {
            updateStrokePoints(stroke.id, stroke.points);
          }
        });
      },
    },

    "stroke-resize": {
      move(drag, { world }) {
        const stroke = strokesById().get(drag.strokeId);
        if (!stroke || !canMoveStroke(stroke)) return;
        const resized = resizeRotatedShapeFromBottomRight({
          fixedTopLeft: drag.fixedTopLeft,
          pointer: world,
          rotation: 0,
          minSize: { width: 32, height: 32 },
        });
        const scaleX = resized.width / drag.startBounds.width;
        const scaleY = resized.height / drag.startBounds.height;
        updateStrokeTransformInteraction([
          strokeFromTransformedPoints(
            stroke,
            drag.initialPoints.map((point) => ({
              ...point,
              x: resized.x + (point.x - drag.startBounds.x) * scaleX,
              y: resized.y + (point.y - drag.startBounds.y) * scaleY,
            })),
          ),
        ]);
      },
      commit: commitStrokeShape,
      revert: cancelStrokeTransformInteraction,
      end() {
        strokePreview = null;
      },
    },

    "stroke-rotate": {
      move(drag, { event, world }) {
        const stroke = strokesById().get(drag.strokeId);
        if (!stroke || !canMoveStroke(stroke)) return;
        const rawRotation = rotationFromPointer(drag.center, world);
        const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
        const delta = ((rotation - drag.startRotation + 540) % 360) - 180;
        const normalizedRotation = normalizeRotation(drag.initialRotation + delta);
        updateStrokeTransformInteraction([
          strokeFromTransformedPoints(
            stroke,
            drag.initialPoints.map((point) => {
              const rotated = rotateVector(
                { x: point.x - drag.center.x, y: point.y - drag.center.y },
                delta,
              );
              return {
                ...point,
                x: drag.center.x + rotated.x,
                y: drag.center.y + rotated.y,
              };
            }),
            normalizedRotation,
          ),
        ]);
      },
      commit: commitStrokeShape,
      revert: cancelStrokeTransformInteraction,
      end() {
        strokePreview = null;
      },
    },
  };

  // One cast, so every call site below stays type-safe: the table is keyed by
  // the same discriminant the state carries, which TypeScript cannot follow
  // through an index on a union.
  function dragBehavior<S extends DragState>(drag: S): DragBehavior<S> {
    return DRAG_BEHAVIORS[drag.type] as DragBehavior<S>;
  }

  /** The pending preview, cleared, or null when the gesture changed nothing. */
  function takeStrokePreview() {
    const preview = strokePreview;
    strokePreview = null;
    return preview?.changed ? preview : null;
  }

  function commitStrokeShape(
    drag: Extract<DragState, { type: "stroke-resize" | "stroke-rotate" }>,
  ) {
    const stroke = takeStrokePreview()?.strokes[0];
    if (!stroke) return;
    ydoc.transact(() => {
      updateStrokePoints(
        drag.strokeId,
        stroke.points,
        drag.type === "stroke-rotate" ? stroke.rotation : undefined,
      );
    });
  }

  function revertShapeFrameDrag(drag: Extract<DragState, { type: "resize" | "rotate" }>) {
    const shape = shapesById().get(drag.shapeId);
    if (shape && canMoveShape(shape)) updateShapeFrame(drag.shapeId, drag.initial);
  }

  /** Ends the active drag, clearing the transient state every gesture leaves. */
  function endDrag(drag: DragState) {
    dragBehavior(drag).end?.(drag);
    dragState = null;
    if (activeSnapGuides.length > 0) {
      activeSnapGuides = [];
      renderInk();
    }
  }

  function handlePointerUp(event: PointerEvent) {
    if (endToolPointerGesture(event)) event.preventDefault();
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const drag = dragState;
    dragBehavior(drag).commit?.(drag);
    endDrag(drag);
  }

  /**
   * Aborts a drag that changed the document, putting it back. Reports whether
   * there was one, so Escape can fall through to whatever else it does.
   */
  function cancelTransformDrag() {
    const drag = dragState;
    const revert = drag && dragBehavior(drag).revert;
    if (!drag || !revert) return false;
    revert(drag);
    endDrag(drag);
    return true;
  }

  function handlePointerCancel(event: PointerEvent) {
    if (
      activeToolPointerGesture?.pointerId === event.pointerId &&
      cancelToolPointerGesture("pointercancel")
    ) {
      return;
    }
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (cancelTransformDrag()) return;
    endDrag(dragState);
  }

  function handlePointerLeave() {
    localPointer = null;
    state.localPointerScreen = null;
    state.hoveredLockedElement = null;
    updatePresence();
  }

  function handleDragOver(event: DragEvent) {
    routeExtensionInput(
      "drop",
      event,
      event.dataTransfer,
      insertionPointFromEvent(event),
      "preview",
    );
  }

  function handleDrop(event: DragEvent) {
    routeExtensionInput(
      "drop",
      event,
      event.dataTransfer,
      insertionPointFromEvent(event),
    );
  }

  function selectContextMenuTarget(event: MouseEvent) {
    const target = event.target;
    if (target instanceof Element) {
      const shapeElement = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
      const shapeId = shapeElement?.dataset.shapeId;
      if (shapeId) {
        if (isElementLocked(shapeId)) clearSelection();
        else if (!state.selectedIds.has(shapeId)) selectOnly(shapeId);
        return;
      }
    }

    const worldPoint = screenToWorld(screenPoint(event));
    const image = hitTestRasterShape(worldPoint);
    if (image) {
      if (image.locked) clearSelection();
      else if (!state.selectedIds.has(image.id)) selectOnly(image.id);
      return;
    }

    const strokeId = hitTestCanvasStroke(state.strokes, worldPoint, transform().scale);
    if (strokeId) {
      if (isElementLocked(strokeId)) clearSelection();
      else if (!state.selectedIds.has(strokeId)) selectOnly(strokeId);
      return;
    }

    const paintedShape = hitTestPaintedShape(worldPoint)?.shape ?? null;
    if (paintedShape) {
      if (paintedShape.locked) clearSelection();
      else if (!state.selectedIds.has(paintedShape.id)) selectOnly(paintedShape.id);
      return;
    }

    clearSelection();
  }

  function handleContextMenu(event: MouseEvent) {
    // Always prevent the native context menu / iOS callout.
    event.preventDefault();
    if (!dom.viewport) return;

    // Don't open the menu when the draw tool is active.
    if (state.activeTool === "draw") return;

    dragState = null;
    state.isPanning = false;
    selectContextMenuTarget(event);
    const rect = dom.viewport.getBoundingClientRect();
    const pos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    contextMenuInsertWorld.current = screenToWorld(pos);
    state.contextMenuPos = pos;
  }

  /**
   * Per-type context-menu entries contributed by the selected shape's extension.
   *
   * Only for a lone selected shape: an extension's action is about *its* shape,
   * and a mixed or multiple selection has no single type to ask.
   */
  function contextMenuEntries() {
    if (state.selectedIds.size !== 1) return [];
    const [id] = state.selectedIds;
    const shape = shapesById().get(id);
    if (!shape) return [];
    return extensionManager.get(shape.type).contextMenu?.(shape, extHost) ?? [];
  }

  function uploadFromContextMenu() {
    const insertAt = contextMenuInsertWorld.current ?? insertionPointFromEvent();
    state.contextMenuPos = null;
    contextMenuInsertWorld.current = null;

    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;

    input.onchange = () => {
      const files = input.files;
      if (!files?.length) return;

      const split = extensionRuntime.input.splitFiles(files);
      void extensionRuntime.input.addDroppedFiles(split.media, split.files, insertAt);
    };

    input.click();
  }

  // Centers the viewport on the document's content the first time it loads, so a
  // saved canvas opens framed instead of pinned to world origin. Fires at most
  // once: `isInitialContent` is false for the user's own first edit (Yjs origin
  // null), which only disarms the one-shot rather than recentering their view.

  function refreshUndoState() {
    state.canUndo = undoManager.canUndo();
    state.canRedo = undoManager.canRedo();
  }

  function undo() {
    if (undoManager.canUndo()) undoManager.undo();
  }

  function redo() {
    if (undoManager.canRedo()) undoManager.redo();
  }

  /**
   * Escape only; every other shortcut is a `canvas:*` action (`runtime/actions.ts`).
   * It cancels an in-flight gesture rather than selecting a command, so it has to
   * beat the global `escape` binding — hence handled locally.
   */
  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    const target = event.target as HTMLElement | null;
    // document-view hosts the embedded document editor; shadow-DOM events
    // retarget to the host element, so closest() must match the host itself.
    if (target?.closest("textarea, input, select, document-view")) return;
    if (cancelToolPointerGesture("escape") || cancelTransformDrag()) {
      event.preventDefault();
    }
  }

  // Moving a card changes updatedAt and refreshes the shapes array, so watch a
  // stable key of the actual preview inputs instead — visual edits then never
  // cause preview work. The loaders remain responsible for caching.
  const extensionPreparationKey = () =>
    state.shapes
      .map((shape) => {
        const extension = extensionManager.get(shape.type);
        const key = extension.events?.prepare?.key(shape, extHost);
        return key ? `${shape.id}\u001e${key}` : null;
      })
      .filter((key): key is string => Boolean(key))
      .sort()
      .join("\u001f");

  // --- reactions ---------------------------------------------------------
  /**
   * Each entry fires when the value it is handed differs from the previous
   * flush. The order they appear in is the order they run in — that is the
   * point of the single pass, rather than reactions declared far apart whose
   * relative order is an accident of where they sit in the file.
   */
  function runReactions(): void {
    watch("cursorColor", host.cursorColor, () => updatePresence());

    watch("camera", state.camera, () => {
      if (!state.isCameraMoving) state.isCameraMoving = true;
      if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
      cameraMoveTimer = setTimeout(() => {
        state.isCameraMoving = false;
        invalidate();
      }, 150);
    });

    watch("selection", state.selectedIds, (ids) => {
      if (state.editingChromeId && (ids.size !== 1 || !ids.has(state.editingChromeId))) {
        finishChromeEditing();
      }
      updatePresence();
    });

    watch("selection:edit", state.selectedIds, (ids) => {
      const editing = state.activeEditSession;
      if (editing && (ids.size !== 1 || !ids.has(editing.shapeId))) stopActiveEdit();
    });

    watch("activeTool", state.activeTool, (tool) => {
      if (tool !== "select") stopActiveEdit();
    });

    watch("shapes:edit", state.shapes, () => {
      const editing = state.activeEditSession;
      if (editing && !shapesById().has(editing.shapeId)) stopActiveEdit();
      if (state.editingChromeId && !shapesById().has(state.editingChromeId)) {
        finishChromeEditing();
      }
    });

    watch("gridType", host.gridType, (value) => applyGridType(value), {
      immediate: true,
    });

    watch(
      "extensionPreparation",
      extensionPreparationKey(),
      () => {
        for (const shape of state.shapes) {
          extensionManager.get(shape.type).events?.prepare?.run(shape, extHost);
        }
      },
      { immediate: true },
    );
  }

  /**
   * Reactions that need the DOM to already show the new state: the canvas
   * layers are drawn from measured element geometry, so running them before the
   * template is patched would paint against the previous frame's layout.
   */
  function runPostRenderReactions(): void {
    watchPost("transform", transform(), () => dom.canvasToolbar?.reposition());

    watchPost(
      "viewport",
      `${state.camera.centerX}:${state.camera.centerY}:${state.camera.zoom}:${state.screen.width}:${state.screen.height}`,
      () => updatePresence(),
    );

    // Painted every flush rather than watched. A flush only happens because
    // something asked for a frame, and the values a watch would compare here —
    // the selection snapshot, the visible stroke list — are rebuilt on each
    // read, so it would fire every flush anyway.
    renderInk();
  }

  // --- lifecycle ---------------------------------------------------------
  /**
   * Input handled on `window` rather than on the element: a drag has to keep
   * tracking once the pointer leaves the canvas, and the keyboard has no
   * position at all. The host's own input listener never sees these, so each
   * one asks for a frame itself.
   */
  const windowHandlers = (
    [
      ["keydown", handleKeydown],
      ["pointermove", handlePointerMove],
      ["pointerup", handlePointerUp],
      ["pointercancel", handlePointerCancel],
      ["copy", handleCopy],
      ["cut", handleCut],
      ["paste", handlePaste],
    ] as const
  ).map(([type, handler]) => {
    const draws = (event: Event) => {
      (handler as (event: never) => void)(event as never);
      invalidate();
    };
    return [type, draws] as const;
  });

  // --- canvas:* actions ------------------------------------------------------
  // Registered on mount so the command palette lists them and every shortcut has
  // one definition. Bindings are mapped here rather than in `shortcuts.json`:
  // tool keys come from whatever extensions are loaded, and `mod-z` is already
  // bound to `format:undo` — `getActionForShortcut` returns the *last* match, so
  // mapping on mount makes the canvas win while it is mounted and hands the
  // binding back on dispose. A focused document editor still wins, because its
  // Tiptap keymap calls preventDefault and `Actions.handleKey` honours that.
  const registeredActions: string[] = [];
  const mappedShortcuts = new Map<string, string[]>();

  function registerAction(
    id: string,
    title: string,
    description: string,
    run: () => void,
    shortcuts: string[] = [],
  ) {
    Actions.register(id, { title, description, group: "canvas", run: async () => run() });
    registeredActions.push(id);
    const keys = shortcuts.filter(Boolean).map((shortcut) => shortcut.toLowerCase());
    for (const shortcut of keys) Actions.mapShortcut(shortcut, id);
    if (keys.length > 0) mappedShortcuts.set(id, keys);
  }

  function registerCanvasActions() {
    registerAction(
      "canvas:save",
      t("Save"),
      t("Save the canvas"),
      () => void manualSave(),
      ["mod-s"],
    );
    registerAction("canvas:undo", t("Undo"), t("Undo the last change"), undo, ["mod-z"]);
    registerAction("canvas:redo", t("Redo"), t("Redo the last undone change"), redo, [
      "mod-shift-z",
      "mod-y",
    ]);
    registerAction(
      "canvas:delete",
      t("Delete selection"),
      t("Delete the selected elements"),
      deleteSelectedShape,
      ["delete", "backspace"],
    );
    registerAction(
      "canvas:lock",
      t("Lock selection"),
      t("Lock the selected elements"),
      lockSelectedElements,
    );
    registerAction("canvas:fit", t("Fit view"), t("Frame all content"), () => fitView(), [
      "f",
    ]);

    // Select is the engine's default rather than a registered tool, so its key is
    // contributed here alongside the ones extensions declare.
    const tools = [
      { id: "select" as CanvasToolId, shortcut: "V" },
      ...extensionManager.toolShortcuts(),
    ];
    for (const tool of tools) {
      registerAction(
        `canvas:tool:${tool.id}`,
        `${t("Tool")}: ${tool.id}`,
        `Activate the ${tool.id} tool`,
        () => {
          state.activeTool = tool.id;
          invalidate();
        },
        [tool.shortcut],
      );
    }
  }

  function disposeCanvasActions() {
    for (const [id, shortcuts] of mappedShortcuts) {
      for (const shortcut of shortcuts) Actions.unmapShortcut(shortcut, id);
    }
    mappedShortcuts.clear();
    for (const id of registeredActions) Actions.unregister(id);
    registeredActions.length = 0;
  }

  function mount(): void {
    void import("#editor/document.ts");
    refreshCssVars();

    const observe = (transaction: Y.Transaction, sync: () => void) => {
      sync();
      // Nobody touched the canvas — the document changed underneath it, whether
      // from a peer, an undo, or the room state arriving on load.
      invalidate();
      // Persist only this client's own edits (local edits have origin null; undo/
      // redo carry the UndoManager origin). Remote changes are persisted by their
      // originator — the peer that made them, or the server for agent edits — so
      // re-saving them here would mean every client rewrites the doc on every
      // change, including the initial room state that arrives as "remote" on load.
      if (transaction.origin !== "remote" && transaction.origin !== "seed")
        scheduleSave();
      refreshUndoState();
      fitInitialViewIfNeeded(transaction.origin !== null);
    };
    yShapes.observeDeep((_events, transaction) => observe(transaction, syncShapesFromY));
    yStrokes.observeDeep((_events, transaction) =>
      observe(transaction, syncStrokesFromY),
    );

    syncShapesFromY();
    syncStrokesFromY();
    resize();

    viewportControls = createViewportControls({
      target: dom.viewport ?? window,
      getCamera: () => state.camera,
      setCamera: (nextCamera) => {
        state.camera = nextCamera;
        // Must ask for the frame itself. The host's capture-phase input listener
        // already fired for the `wheel` event that scheduled this, and its
        // microtask drained before the rAF that runs `flushWheel` — so without
        // this the new camera is not painted until the *next* input event, which
        // trails every layer by a frame and drops the last step of a zoom.
        invalidate();
      },
      getScreen: () => state.screen,
      getFit: () => FIT_REFERENCE,
      onTouchGestureStart: () => {
        cancelToolPointerGesture("touch-gesture");
        dragState = null;
        state.isPanning = false;
        renderInk();
      },
      onTwoFingerTap: undo,
      minZoom: 0.15,
      maxZoom: 10,
    });

    // Neither the viewport resizing nor the theme flipping is an interaction,
    // so both say so themselves.
    resizeObserver = new ResizeObserver(() => {
      resize();
      invalidate();
    });
    if (dom.viewport) resizeObserver.observe(dom.viewport);

    updateThemeMode();
    themeObserver = new MutationObserver(updateThemeMode);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    colorSchemeMedia.addEventListener("change", updateThemeMode);

    updatePresence();
    registerCanvasActions();
    isReady = true;
    if (savePrunedInvalidShapesWhenReady) {
      savePrunedInvalidShapesWhenReady = false;
      saveImmediately();
    }
    // If the room state already arrived before mount, frame it now that the
    // screen has been measured; otherwise the Yjs observer frames it on first
    // sync. Either way the first content to land counts as initial.
    fitInitialViewIfNeeded(true);
    for (const [type, handler] of windowHandlers) {
      window.addEventListener(type, handler);
    }
  }

  function destroy(): void {
    cancelToolPointerGesture("unmount");
    viewportControls?.dispose();
    resizeObserver?.disconnect();
    themeObserver?.disconnect();
    colorSchemeMedia?.removeEventListener("change", updateThemeMode);
    host.presenceChanged([]);
    disposeCanvasActions();
    undoManager.destroy();
    for (const [type, handler] of windowHandlers) {
      window.removeEventListener(type, handler);
    }
    if (saveTimer) clearTimeout(saveTimer);
    if (saveStateTimer) clearTimeout(saveStateTimer);
    if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
    if (inkRafId !== null) cancelAnimationFrame(inkRafId);
    if (presenceRafId !== null) cancelAnimationFrame(presenceRafId);
  }

  // --- view --------------------------------------------------------------
  /**
   * Everything the template is allowed to touch — an explicit surface rather
   * than the whole closure, so this list is what rendering depends on, and the
   * template can live in its own module.
   */
  const view = {
    // state
    // Read wholesale: the proxy is already the live object, and a per-field
    // getter list has to be extended by hand every time state gains a field.
    get state(): Readonly<typeof state> {
      return state;
    },
    activeToolProperties,
    toolPropertyValue: (id: string) => toolPropertyValue(state.activeTool, id),
    get activeShapeId() {
      return activeShapeId.get();
    },

    // host-supplied
    get cursorColor() {
      return host.cursorColor;
    },
    get cursorCompanion() {
      return host.cursorCompanion;
    },
    tools: CANVAS_TOOLS,

    // derived
    transform,
    domShapes,
    uploadPlaceholders: () => uploadPlaceholders.get(),
    editingChromeShape,
    hasToolProperties,
    hasSelectedElementProperties,
    activeToolColorPalettes,
    selectedShapeColorPalette,
    selectedShape,
    selectedStrokeColor,
    selectedTransformElement,
    selectedResizeOnlyElement,
    selectedScalableSelection,
    hoveredLockedElementPosition,
    remoteCanvasPointerPresences,
    viewportCursor,
    hostContext: () => hostContext,

    // per-shape queries
    articleStyle,
    isBrowserFindTarget,
    elementTagForShape,
    elementDataForShape,
    editorTagForShape,
    elementChromePosition,
    transformControlPositions,
    selectionScaleControlPosition,
    worldToScreen,

    // commands
    setActiveTool: (tool: CanvasToolId) => {
      state.activeTool = tool;
    },
    setToolProperty,
    setActiveElementColor,
    setActivePenColor,
    setSelectedElementColor,
    setSelectedStrokeColor,
    pickShapeLibraryItem,
    contextMenuEntries,
    closeContextMenu: () => {
      state.contextMenuPos = null;
      contextMenuInsertWorld.current = null;
    },
    undo,
    redo,
    fitView: () => fitView(),
    lockSelectedElements,
    unlockHoveredElement,
    copySelectionToClipboard,
    cutSelectionToClipboard,
    pasteFromContextMenu,
    uploadFromContextMenu,
    deleteSelectedShape,
    stopActiveEdit,
    finishChromeEditing,
    setActiveEditorRef,

    // pointer / drag entry points
    startShapeDrag,
    startRotation,
    startResize,
    startSelectionScale,
    onElementActivate,
    onElementOpen,
    handleContextMenu,
    handleViewportPointerDown,
    handlePointerCancel,
    handlePointerLeave,
    handleViewportDoubleClick,
    handleDragOver,
    handleDrop,
    handleBrowserFindMatch,
  };

  // Page-level values live outside this host's revision counter, so the host
  // says once that it is on screen and wants repainting when any of them move.
  const unregister = registerCanvas(invalidate);

  return {
    /** The live view model the template reads. */
    view,
    mount,
    /** Marks the canvas dirty — host properties live outside the state proxy,
     * so writing one schedules nothing on its own. */
    invalidate,
    flush() {
      runReactions();
    },
    afterRender() {
      runPostRenderReactions();
    },
    destroy() {
      unregister();
      destroy();
    },
  };
}
