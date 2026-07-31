import * as Y from "yjs";
import { penToolIcon, selectToolIcon } from "#assets/icons.ts";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import type { DrawStrokeMode } from "./extensions/drawing.ts";
import {
  activeDrawStrokeMode,
  activeShapeId,
  type CanvasElementContext,
  type CanvasShapeLibraryItem,
  cloneFreehandPoint,
  createCanvasExtensionManager,
  createCanvasInkRenderer,
  createCanvasSelectionRenderer,
  createStrokeMap,
  FREEHAND_STYLE,
  hitTestCanvasStroke,
  PEN_COLORS,
  renderCanvasInkOverlay,
  setActiveShapeId,
  strokeStyleFromUnknown,
  toCanvasStroke,
} from "./extensions/registry.ts";
import type {
  CanvasEditSession,
  CanvasElementExtension,
  CanvasFrame,
  CanvasHitTestHelpers,
  CanvasInputKind,
  CanvasPaintHelpers,
  CanvasPoint,
  CanvasPointerGestureCancelReason,
  CanvasPointerGestureEvent,
  CanvasPointerGestureHandlers,
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasSnapshot,
  CanvasStroke,
  CanvasStrokeSnapshot,
  CanvasTool,
  CanvasToolContext,
  CanvasToolExtension,
} from "./extensions/types.ts";
import {
  type ScalableSelection,
  type SelectionContext,
  selectedGroupBounds as selectionGroupBounds,
  selectedResizeOnlyShape as selectionResizeOnlyShape,
  selectedScalableSelection as selectionScalable,
  selectedShape as selectionShape,
  selectedTransformShape as selectionTransformShape,
} from "./selectionModel.ts";
import {
  isBrowserFindTarget,
  articleStyle as shapeArticleStyle,
  editorTagForShape as shapeEditorTag,
  isContainerShape as shapeIsContainer,
  suppressesNativePointer as shapeSuppressesNativePointer,
} from "./shapeQueries.ts";
import { shapeFromSource, shapeToYMap } from "./shapeSerialization.ts";
import {
  axisAlignedHandles,
  strokeBounds as boundsOfPoints,
  clampFontScale,
  handleOffsets,
  isPointInRect,
  MIN_FONT_SCALE,
  type Rect,
  rectContains,
  rectsIntersect,
  scaleHandle,
  unionBounds,
} from "./viewport/bounds.ts";
import { makeCanvasCursor } from "./viewport/cursor.ts";
import {
  normalizeRotation,
  pointOnRotatedShape,
  resizeRotatedShapeFromBottomRight,
  rotatedShapeBounds,
  rotatedShapeCorners,
  rotateVector,
  rotationFromPointer,
  snapRotation,
} from "./viewport/geometry.ts";
import {
  pointerGesture,
  releasePointerCapture,
  screenPoint as screenPointIn,
} from "./viewport/pointer.ts";
import { readCanvasTheme, isDarkMode as resolveDarkMode } from "./viewport/theme.ts";
import "#editor/elements/rich-text-editor.ts";
import "#editor/elements/toolbar.ts";
import "@atrium-ui/elements/popover";
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
import { type TranslationKey, t } from "#utils/lang.ts";
import {
  buildTransform,
  createViewportControls,
  drawWorldDots,
  drawWorldGrid,
  type FitReference,
  type FreehandPoint,
  type FreehandStroke,
  panCameraByScreenDelta,
  type ScreenSize,
  type SnapGuide,
  snapDragOffset as snapDrag,
  type ViewportCamera,
  type ViewportControls,
  screenToWorld as viewportScreenToWorld,
  worldToScreen as viewportWorldToScreen,
  type WorldRect,
  worldViewportBounds,
} from "./viewport/index.ts";
import "./CanvasPresenceCursorElement.ts";
import "./css/canvas.css";
import type { CanvasDomRefs, CanvasToolDef } from "./CanvasView.ts";
import type { CanvasCollaborationFactory } from "./collaboration.ts";
import type { DocumentPreviewSource } from "./extensions/documentLink.ts";
import type { CanvasUploader } from "./extensions/media.ts";
import { createWatchers, indexById, registerCanvas } from "./state.ts";

/**
 * Everything the canvas needs from the page around it.
 *
 * The canvas is framework-free, so it cannot call `useSpace`, `useUserProfile`
 * or any other composable. Their resolved
 * values arrive here instead, set as properties on `<vektor-canvas>` by whatever
 * shell is hosting it. That keeps the dependency pointing one way — the shell
 * knows about the canvas, never the reverse — which is what lets the canvas
 * outlive the app's framework.
 */
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
  /** The user's chosen cursor companion, or null for none. */
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
  /** Called when the controller wants the host to re-render its template. */
  requestRender(): void;
}

/**
 * Both public types are read off the factory rather than declared beside it.
 *
 * `CanvasView` in particular listed every member the template reads — a second
 * copy of the view object below, in the same order, that had to be edited twice
 * for every change and whose only failure mode was drifting silently.
 */
export type CanvasController = ReturnType<typeof createCanvasController>;
export type CanvasView = CanvasController["view"];

export function createCanvasController(host: CanvasHost, dom: CanvasDomRefs) {
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
        baseShapeIds: Set<string>;
        baseStrokeIds: Set<string>;
      };

  type LockedCanvasElement = { type: "shape" | "stroke"; id: string };

  const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
  type ToolDef = CanvasToolDef & {
    id: CanvasTool;
    label: TranslationKey;
    shortcut: string;
    icon: string;
  };

  const extensionManager = createCanvasExtensionManager({
    elements: host.extensions,
    tools: host.tools,
  });

  // Built-in engine tools plus element-contributed tools
  // collected from the registry, so adding an element type surfaces its tool
  // without editing the host.
  const CANVAS_TOOLS: ToolDef[] = [
    { id: "select", label: "Select", shortcut: "V", icon: selectToolIcon },
    { id: "draw", label: "Draw", shortcut: "D", icon: penToolIcon },
    ...extensionManager.elementTools(),
  ];

  // Locked elements are intentionally excluded from normal hit testing. Keep a
  // separate hover target so their small unlock control remains reachable.

  // Section chrome is painted on the canvas. This transient input only appears
  // while its title is actively being edited.

  // Live screen-space rectangle while drag-selecting; null when not marqueeing.

  // Alignment guides shown while dragging shapes; empty when no edge/center of
  // the dragged group is snapped to another shape. Drawn on the ink overlay.
  let activeSnapGuides: SnapGuide[] = [];
  // True only while a pan drag is in progress, so the viewport shows the grabbing
  // hand during panning and a resting cursor otherwise.

  // Active swatch per color-capable element type (used when creating new shapes),
  // seeded from each extension's palette. Recoloring a selected shape writes here
  // too. Data-driven from the registry — no per-type refs.
  const colorPalettes = extensionManager.colorPalettes();

  // --- state -------------------------------------------------------------
  // Everything a render reads. Values are replaced rather than mutated, so the
  // store can compare by identity; see `state.ts` for why invalidation is coarse.
  /**
   * Plain state. Writing a field does nothing on its own — exactly like
   * writing a local — and the entry points that change it ask for a frame
   * when they are done.
   */
  const state = {
    shapes: [] as CanvasShape[],
    strokes: [] as CanvasStroke[],
    selectedShapeIds: new Set<string>(),
    selectedStrokeIds: new Set<string>(),
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
    activeTool: "select" as CanvasTool,
    // Active swatch per color-capable element type (used when creating new
    // shapes), seeded from each extension's palette. Recoloring a selected shape
    // writes here too. Data-driven from the registry — no per-type fields.
    activeColors: Object.fromEntries(
      colorPalettes.map((entry) => [entry.type, entry.palette[0]]),
    ) as Record<string, string>,
    penColor: PEN_COLORS[0] as string,
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

  // Backdrop grid style, driven by the document's "gridtype" property. "grid"
  // draws ruled lines, "dots" a dot grid, and "clean" leaves the backdrop empty.
  type GridType = "grid" | "clean" | "dots";

  let localPointer: { x: number; y: number } | null = null;

  // The explicit cursor-color preference overrides the automatic avatar color.
  // `null` means "automatic", so the presence color matches the user's avatar.
  // Singleton extension-owned editor session. The host only mounts the supplied
  // tag/props and invokes its finish callback.

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
    selectOnlyShape(shape.id);
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
  // Screen-space position of the long-press context menu, null when hidden.

  // World-space insertion point captured when the context menu was opened.
  let contextMenuInsertWorld: { x: number; y: number } | null = null;
  let isReady = false;
  let savePrunedInvalidShapesWhenReady = false;
  let viewportControls: ViewportControls | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let themeObserver: MutationObserver | null = null;
  let colorSchemeMedia: MediaQueryList | null = null;
  let dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  let selectionLayerHidden = false;
  let selectionDragActive = false;

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
    selectShape: selectOnlyShape,
    selectShapes: (ids) => {
      state.selectedShapeIds = new Set(ids);
    },
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

  // Remote pointers arrive as discrete presence updates; a CSS transition on the
  // cursor smooths the jumps. While the local camera moves, the transition is
  // suspended so cursors stay locked to the canvas instead of lagging behind the
  // pan/zoom.

  let cameraMoveTimer: ReturnType<typeof setTimeout> | null = null;

  // Presence carries the cursor color, so re-announce when the preference changes.
  // Everything the selection model needs to answer a question. Rebuilt per read
  // so it always reflects the current maps and ids; the computeds below cache the
  // answers, not this.
  function selectionContext(): SelectionContext {
    return {
      shapesById: shapesById(),
      strokesById: strokesById(),
      selectedShapeIds: state.selectedShapeIds,
      selectedStrokeIds: state.selectedStrokeIds,
      extensions: extensionManager,
      canMoveShape,
      canMoveStroke,
      shapeAabb,
      strokeBounds,
    };
  }

  const selectedShape = () => selectionShape(selectionContext());
  const selectedTransformShape = () => selectionTransformShape(selectionContext());
  const selectedResizeOnlyShape = () => selectionResizeOnlyShape(selectionContext());
  const selectedGroupBounds = () => selectionGroupBounds(selectionContext());
  const selectedScalableSelection = () => selectionScalable(selectionContext());

  function transformControlPositions(shape: CanvasShape) {
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
    selectOnlyShape(session.shapeId);
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
      if (state.selectedShapeIds.has(id)) {
        state.selectedShapeIds.delete(id);
        state.selectedShapeIds = new Set(state.selectedShapeIds);
      }
    },
    selectShape: (id) => selectOnlyShape(id),
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
        renderSelections();
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
    if (state.selectedStrokeIds.size === 0) return null;
    let color: string | null = null;
    for (const id of state.selectedStrokeIds) {
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

  function isShapeLocked(id: string): boolean {
    return shapesById().get(id)?.locked === true;
  }

  function isStrokeLocked(id: string): boolean {
    return strokesById().get(id)?.locked === true;
  }

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

  const selectedBasicShapeStroke = () => {
    if (state.selectedShapeIds.size > 0 || state.selectedStrokeIds.size !== 1)
      return null;
    const [id] = state.selectedStrokeIds;
    const stroke = strokesById().get(id);
    return stroke?.kind === "shape" && canMoveStroke(stroke) ? stroke : null;
  };

  const selectedBasicShapeStrokeControls = () => {
    const stroke = selectedBasicShapeStroke();
    return stroke ? strokeTransformControlPositions(stroke) : null;
  };

  function selectOnlyShape(id: string) {
    if (isShapeLocked(id)) return;
    state.selectedShapeIds = new Set([id]);
    if (state.selectedStrokeIds.size > 0) {
      state.selectedStrokeIds = new Set();
      renderInk();
    }
  }

  function selectStroke(id: string, additive: boolean) {
    if (isStrokeLocked(id)) return;
    if (additive) {
      const next = new Set(state.selectedStrokeIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      state.selectedStrokeIds = next;
    } else {
      state.selectedShapeIds = new Set();
      state.selectedStrokeIds = new Set([id]);
    }
    renderInk();
  }

  function toggleShapeSelection(id: string) {
    if (isShapeLocked(id)) return;
    const next = new Set(state.selectedShapeIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    state.selectedShapeIds = next;
  }

  function clearSelection() {
    if (state.selectedShapeIds.size > 0) state.selectedShapeIds = new Set();
    if (state.selectedStrokeIds.size > 0) {
      state.selectedStrokeIds = new Set();
      renderInk();
    }
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

  function strokeTransformControlPositions(stroke: CanvasStroke) {
    const bounds = strokeBounds(stroke);
    if (!bounds) return null;
    return axisAlignedHandles(bounds, transform().scale, worldToScreen);
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

    let pruned = false;
    for (const id of state.selectedShapeIds) {
      const source = yShapes.get(id);
      const shape = source ? toShape(id, source) : null;
      if (!shape || shape.locked) {
        state.selectedShapeIds.delete(id);
        pruned = true;
      }
    }
    if (pruned) state.selectedShapeIds = new Set(state.selectedShapeIds);
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
    const addedStrokes: CanvasStroke[] = [];
    let hasContentChange = false;
    const next = [...yStrokes.entries()]
      .map(([id, value]) => {
        const existing = previous.get(id);
        const updatedAt = value.get("updatedAt");
        if (existing && existing.updatedAt === updatedAt) return existing;
        const stroke = toStroke(id, value);
        if (existing) hasContentChange = true;
        else addedStrokes.push(stroke);
        return stroke;
      })
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));

    // Purely additive when no existing stroke changed and none were removed — the
    // common collaboration case of a peer drawing new strokes. Edits, moves and
    // deletions fall through to a full raster rebuild.
    const additiveOnly =
      !hasContentChange && next.length === previous.size + addedStrokes.length;

    let pruned = false;
    for (const id of state.selectedStrokeIds) {
      const source = yStrokes.get(id);
      if (!source || source.get("locked") === true) {
        state.selectedStrokeIds.delete(id);
        pruned = true;
      }
    }
    if (pruned) state.selectedStrokeIds = new Set(state.selectedStrokeIds);

    // A local draw already patched the cache with its stroke via
    // commitAddedStroke, so re-patching here would double-paint it. Remote
    // additions arrive with no commit in flight — patch the cache incrementally
    // instead of rebuilding the whole ink raster from every stroke (which made
    // each incoming stroke O(total strokes), collapsing sync on dense canvases).
    if (additiveOnly && addedStrokes.length > 0 && !inkRenderer.isCommittingCacheUpdate) {
      inkRenderer.commitAddedStrokes(addedStrokes, () => {
        state.strokes = next;
        renderInk();
      });
      return;
    }

    state.strokes = next;
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

  const inkRenderer = createCanvasInkRenderer({
    getDpr: () => dpr,
    getScreen: () => state.screen,
    getTransform: () => transform(),
    getStrokes: () => state.strokes,
    getDefaultInkColor: defaultInkColor,
    invalidateScene: renderScene,
  });
  const selectionRenderer = createCanvasSelectionRenderer();

  // This snapshot deliberately excludes camera state. Its identity therefore
  // stays stable through pan/zoom frames and changes only when the selection
  // geometry itself needs to be rebuilt.
  const selectionSnapshot = () => ({
    strokes: state.strokes,
    selectedStrokeIds: state.selectedStrokeIds,
    remoteSelectedStrokeIds: remoteCanvasStrokeSelections(),
    selectionBounds: selectedGroupBounds() ?? undefined,
    selectedShapeBounds: [...state.selectedShapeIds]
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
    inkRenderer.renderStaticInk(context);
    context.restore();
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

  let inkRafId: number | null = null;
  function scheduleInkRender() {
    if (inkRafId !== null) return;
    inkRafId = requestAnimationFrame(() => {
      inkRafId = null;
      inkRenderer.renderStrokeTransformCache();
      renderActiveInk();
      if (selectionDragActive) renderSelections();
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
    renderSelections();
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

  function renderSelections(refresh = false) {
    const canvas = dom.selection;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    if (inkRenderer.isTransformingStroke && !selectionDragActive) {
      hideSelectionLayer();
      return;
    }

    if (selectionLayerHidden) {
      canvas.style.visibility = "";
      selectionLayerHidden = false;
    }

    selectionRenderer.render({
      context,
      dpr,
      screen: state.screen,
      transform: transform(),
      selection: selectionSnapshot(),
      refresh,
      deferRefresh: state.marqueeRect !== null,
    });
  }

  // Stroke transforms hide the selection outline while the selected ink is being
  // replaced inside the raster cache. Camera movement keeps this layer visible
  // and redraws it through renderInk with the current viewport transform.
  function hideSelectionLayer() {
    const canvas = dom.selection;
    if (!canvas || selectionLayerHidden) return;
    canvas.style.visibility = "hidden";
    selectionLayerHidden = true;
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
    // Use toRaw on reactive Sets/Maps to bypass per-element proxy overhead
    // when iterating — these are snapshot reads, not reactive dependencies.
    const rawIds = state.selectedShapeIds;
    const rawStrokeIds = state.selectedStrokeIds;
    const selectionIds: string[] = [];
    for (const id of rawIds) selectionIds.push(id);
    for (const id of rawStrokeIds) selectionIds.push(id);
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
    viewportScale: () => transform().scale,
    beginPointerGesture,
    clearSelection,
    setActiveStroke: (stroke) => {
      activeFreehandStroke = stroke;
      renderActiveInk();
    },
    insertStroke: insertCanvasStroke,
    selectStroke: (id) => selectStroke(id, false),
    createElement: (type, at) => addShape(type, at),
    setActiveTool: (tool) => {
      state.activeTool = tool;
    },
  };

  function insertCanvasStroke(stroke: CanvasStrokeSnapshot) {
    const completedStroke = toCanvasStroke(stroke.id, stroke);
    inkRenderer.commitAddedStroke(completedStroke, () => {
      yStrokes.set(stroke.id, createStrokeMap(stroke));
    });
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
    selectOnlyShape(shape.id);
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

  const activeToolColorPalettes = () =>
    colorPalettes.filter((entry) => state.activeTool === entry.type);

  const selectedShapeColorPalette = () =>
    colorPalettes.find((entry) => entry.type === selectedShape()?.type);

  const hasSelectedElementProperties = () =>
    selectedShapeColorPalette() !== undefined || state.selectedStrokeIds.size > 0;

  const hasToolProperties = () =>
    state.activeTool === "draw" || activeToolColorPalettes().length > 0;

  function pickShapeLibraryItem(item: CanvasShapeLibraryItem) {
    setActiveShapeId(item.id);
    state.activeTool = "shape";
    dom.shapePopover?.hide();
  }

  function setActivePenColor(color: string) {
    state.penColor = color;
  }

  function setSelectedStrokeColor(color: string) {
    if (state.selectedStrokeIds.size === 0) return;

    ydoc.transact(() => {
      for (const id of state.selectedStrokeIds) {
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
    if (state.selectedShapeIds.size === 0 && state.selectedStrokeIds.size === 0) return;
    const shapeIds = new Set(state.selectedShapeIds);
    const strokeIds = new Set(state.selectedStrokeIds);

    // A container cascades locking to every element currently
    // inside its bounds becomes locked with it. Include all contents, including
    // elements that are already locked or user-scoped to someone else.
    for (const id of state.selectedShapeIds) {
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
    if (state.selectedShapeIds.size === 0 && state.selectedStrokeIds.size === 0) return;
    ydoc.transact(() => {
      for (const id of state.selectedShapeIds) {
        if (!isShapeLocked(id)) yShapes.delete(id);
      }
      for (const id of state.selectedStrokeIds) {
        if (!isStrokeLocked(id)) yStrokes.delete(id);
      }
    });
    state.selectedShapeIds = new Set();
    state.selectedStrokeIds = new Set();
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

    for (const id of state.selectedShapeIds) {
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
    for (const id of state.selectedStrokeIds) {
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

  function startStrokeTransformInteraction(
    strokesToMove: CanvasStroke[],
    hideSelection = true,
  ) {
    if (!inkRenderer.beginStrokeTransform(strokesToMove)) return;
    if (hideSelection) hideSelectionLayer();
    renderScene();
    renderActiveInk();
  }

  function updateStrokeTransformInteraction(
    transformedStrokes: CanvasStroke[],
    dx = 0,
    dy = 0,
  ) {
    if (!inkRenderer.setStrokeTransform(transformedStrokes, dx, dy)) return;
    scheduleInkRender();
  }

  function cancelStrokeTransformInteraction() {
    const canceledStrokeTransform = inkRenderer.cancelStrokeTransform();
    if (!canceledStrokeTransform && !selectionDragActive) return;
    selectionDragActive = false;
    selectionRenderer.setInteractionOffset(null);
    renderActiveInk();
    renderSelections();
    if (canceledStrokeTransform) renderScene();
  }

  function beginDragStrokeTransform(drag: Extract<DragState, { type: "shape" }>) {
    // Capture the current selection once, then move its raster cache with the
    // pointer instead of rebuilding or hiding it during the drag.
    renderSelections();
    selectionDragActive = true;
    selectionRenderer.setInteractionOffset({ x: 0, y: 0 });
    startStrokeTransformInteraction(
      drag.strokes.flatMap((item) => {
        const stroke = strokesById().get(item.id);
        return stroke ? [stroke] : [];
      }),
      false,
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
      toggleShapeSelection(shape.id);
      if (suppressesNativePointer(shape)) event.preventDefault();
      return;
    }

    // Clicking a shape outside the current selection collapses to just it;
    // clicking one already inside keeps the selection so the whole group drags.
    if (!state.selectedShapeIds.has(shape.id)) {
      selectOnlyShape(shape.id);
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
    selectOnlyShape(shape.id);
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
    let minimumScale = 0.05;
    for (const shape of selection.shapes) {
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
      shapes: selection.shapes.map((shape) => ({
        id: shape.id,
        frame: { ...shape.frame },
        resizeMode: extensionManager.get(shape.type).behavior.transform.resize as
          | "box"
          | "font",
        fontScale: Number(shape.data.fontScale) || 1,
      })),
      strokes: selection.strokes.map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map(cloneFreehandPoint),
      })),
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function startShapeRotation(shape: CanvasShape, event: PointerEvent) {
    const canRotate = extensionManager.get(shape.type).behavior.transform.rotate;
    if (event.button !== 0 || !canRotate || !canMoveShape(shape)) return;
    selectOnlyShape(shape.id);
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
      baseShapeIds: new Set(state.selectedShapeIds),
      baseStrokeIds: new Set(state.selectedStrokeIds),
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

    const shapeIds = new Set(drag.additive ? drag.baseShapeIds : []);
    for (const shape of state.shapes) {
      if (shape.locked) continue;
      const bounds = shapeAabb(shape);
      const hit = isContainerShape(shape)
        ? rectContains(worldRect, bounds)
        : rectsIntersect(worldRect, bounds);
      if (hit) shapeIds.add(shape.id);
    }

    const strokeIds = new Set(drag.additive ? drag.baseStrokeIds : []);
    for (const stroke of state.strokes) {
      if (stroke.locked) continue;
      if (stroke.points.some((point) => isPointInRect(point, worldRect))) {
        strokeIds.add(stroke.id);
      }
    }

    state.selectedShapeIds = shapeIds;
    state.selectedStrokeIds = strokeIds;
    renderInk();
  }

  // Hit-tests canvas-rendered (non-GIF) image shapes in reverse paint order.
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
    selectOnlyShape(shape.id);
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
      contextMenuInsertWorld = null;
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
          toggleShapeSelection(hitImage.id);
        } else if (!state.selectedShapeIds.has(hitImage.id)) {
          selectOnlyShape(hitImage.id);
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
        if (isStrokeLocked(hitStroke)) {
          event.preventDefault();
          return;
        }
        // Match regular shapes: Shift only changes selection membership, while
        // a normal pointerdown selects the stroke and starts a drag for the
        // current stroke selection.
        if (additive) {
          selectStroke(hitStroke, true);
          event.preventDefault();
          return;
        }
        // Grabbing a stroke that's already part of the selection keeps the whole
        // group (including any selected shapes/text) so it all drags together;
        // grabbing an unselected stroke collapses to just it.
        if (!state.selectedStrokeIds.has(hitStroke)) {
          selectStroke(hitStroke, false);
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
        return isShapeLocked(shapeId) ? { type: "shape", id: shapeId } : null;
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
      if (strokeId && isStrokeLocked(strokeId)) return { type: "stroke", id: strokeId };
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

    if (dragState.type === "pan") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
      state.camera = panCameraByScreenDelta({
        camera: drag.startCamera,
        screen: state.screen,
        fit: FIT_REFERENCE,
        dxPx: drag.startPointer.x - event.clientX,
        dyPx: drag.startPointer.y - event.clientY,
      });
      schedulePresenceUpdate();
      return;
    }

    if (dragState.type === "marquee") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
      const rect: Rect = {
        x: Math.min(drag.startScreen.x, point.x),
        y: Math.min(drag.startScreen.y, point.y),
        width: Math.abs(point.x - drag.startScreen.x),
        height: Math.abs(point.y - drag.startScreen.y),
      };
      state.marqueeRect = rect;
      applyMarqueeSelection(dragState, rect);
      schedulePresenceUpdate();
      return;
    }

    const world = screenToWorld(point);
    if (dragState.type === "resize") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
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
        // scale and let the node re-measure its own width/height. Top-left stays
        // put, so it grows toward the corner being dragged.
        const ratio = drag.initial.width > 0 ? resized.width / drag.initial.width : 1;
        const nextScale = clampFontScale((drag.initialScale ?? 1) * ratio);
        updateShapeData(
          drag.shapeId,
          {
            fontScale: Math.round(nextScale * 1000) / 1000,
          },
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
      return;
    }

    if (dragState.type === "selection-scale") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
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
      return;
    }

    if (dragState.type === "rotate") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
      const shape = shapesById().get(drag.shapeId);
      if (!shape || !canMoveShape(shape)) return;
      const rawRotation = rotationFromPointer(drag.center, world);
      const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
      updateShapeFrame(drag.shapeId, { rotation: Math.round(rotation * 10) / 10 });
      return;
    }

    if (dragState.type === "stroke-resize") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
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
      return;
    }

    if (dragState.type === "stroke-rotate") {
      // Captured so the narrowing survives the closures below.
      const drag = dragState;
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
      return;
    }

    const drag = dragState;
    // A few pixels of travel (in screen space) promotes this from a click to a
    // drag, so a click on a document card opens it instead of nudging it.
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
    selectionRenderer.setInteractionOffset({ x: dx, y: dy });
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
    const strokeTransform = inkRenderer.strokeTransform;
    if (strokeTransform) {
      updateStrokeTransformInteraction(strokeTransform.originalStrokes, dx, dy);
    }
    // Yjs shape edits don't trigger an ink redraw, so guides won't appear without
    // this explicit render.
    scheduleInkRender();
  }

  function commitStrokeTransformInteraction(drag: DragState) {
    const transformState = inkRenderer.strokeTransform;
    if (!transformState) {
      if (selectionDragActive) {
        selectionDragActive = false;
        selectionRenderer.setInteractionOffset(null);
        renderSelections();
      }
      return;
    }

    const hasChange =
      drag.type === "shape"
        ? transformState.dx !== 0 || transformState.dy !== 0
        : transformState.strokes.some(
            (stroke, index) => stroke !== transformState.originalStrokes[index],
          );
    if (!hasChange) {
      cancelStrokeTransformInteraction();
      return;
    }

    inkRenderer.commitStrokeTransform((committedTransform) => {
      ydoc.transact(() => {
        if (drag.type === "shape") {
          for (const stroke of state.strokes) {
            translateStroke(
              stroke.id,
              stroke.points,
              committedTransform.dx,
              committedTransform.dy,
            );
          }
          return;
        }
        if (drag.type !== "stroke-resize" && drag.type !== "stroke-rotate") return;
        const stroke = committedTransform.strokes[0];
        if (!stroke) return;
        updateStrokePoints(
          drag.strokeId,
          stroke.points,
          drag.type === "stroke-rotate" ? stroke.rotation : undefined,
        );
      });
    });
    selectionDragActive = false;
    selectionRenderer.setInteractionOffset(null);
    renderActiveInk();
    renderSelections();
  }

  function handlePointerUp(event: PointerEvent) {
    if (endToolPointerGesture(event)) event.preventDefault();
    if (dragState?.pointerId === event.pointerId) {
      commitStrokeTransformInteraction(dragState);
      if (dragState.type === "marquee") {
        state.marqueeRect = null;
        renderSelections();
      }
      if (dragState.type === "pan") state.isPanning = false;
      if (activeSnapGuides.length > 0) {
        activeSnapGuides = [];
        renderInk();
      }
      dragState = null;
    }
  }

  function cancelTransformDrag() {
    if (dragState?.type === "resize" || dragState?.type === "rotate") {
      const shape = shapesById().get(dragState.shapeId);
      if (shape && canMoveShape(shape)) {
        updateShapeFrame(dragState.shapeId, dragState.initial);
      }
    } else if (dragState?.type === "selection-scale") {
      // Captured so the narrowing survives the transaction closure.
      const drag = dragState;
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
    } else if (
      dragState?.type === "stroke-resize" ||
      dragState?.type === "stroke-rotate"
    ) {
      cancelStrokeTransformInteraction();
    } else {
      return false;
    }
    dragState = null;
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
    if (dragState.type === "marquee") {
      state.marqueeRect = null;
      renderSelections();
    }
    if (dragState.type === "pan") state.isPanning = false;
    cancelStrokeTransformInteraction();
    dragState = null;
    if (activeSnapGuides.length > 0) {
      activeSnapGuides = [];
      renderInk();
    }
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
        if (isShapeLocked(shapeId)) clearSelection();
        else if (!state.selectedShapeIds.has(shapeId)) selectOnlyShape(shapeId);
        return;
      }
    }

    const worldPoint = screenToWorld(screenPoint(event));
    const image = hitTestRasterShape(worldPoint);
    if (image) {
      if (image.locked) clearSelection();
      else if (!state.selectedShapeIds.has(image.id)) selectOnlyShape(image.id);
      return;
    }

    const strokeId = hitTestCanvasStroke(state.strokes, worldPoint, transform().scale);
    if (strokeId) {
      if (isStrokeLocked(strokeId)) clearSelection();
      else if (!state.selectedStrokeIds.has(strokeId)) selectStroke(strokeId, false);
      return;
    }

    const paintedShape = hitTestPaintedShape(worldPoint)?.shape ?? null;
    if (paintedShape) {
      if (paintedShape.locked) clearSelection();
      else if (!state.selectedShapeIds.has(paintedShape.id))
        selectOnlyShape(paintedShape.id);
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
    contextMenuInsertWorld = screenToWorld(pos);
    state.contextMenuPos = pos;
  }

  async function pasteFromContextMenu() {
    const insertAt = contextMenuInsertWorld ?? insertionPointFromEvent();
    state.contextMenuPos = null;
    contextMenuInsertWorld = null;
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

  function uploadFromContextMenu() {
    const insertAt = contextMenuInsertWorld ?? insertionPointFromEvent();
    state.contextMenuPos = null;
    contextMenuInsertWorld = null;

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

  // The canvas renders full-bleed behind the fixed navigation sidebar, so the
  // left `inset` px of the viewport are occluded by the nav. Fit-to-view must
  // frame content within the *visible* region instead of the full viewport.
  function reservedSidebarWidth(): number {
    if (typeof window === "undefined") return 0;
    // Below the md breakpoint the sidebar is an overlay drawer and reserves no space.
    if (!window.matchMedia("(min-width: 768px)").matches) return 0;
    const rect = document.querySelector(".sidebar")?.getBoundingClientRect();
    return Math.max(0, rect?.right ?? 0);
  }

  function moveCameraToShape(shape: CanvasShape) {
    const bounds = shapeAabb(shape);
    const inset = reservedSidebarWidth();
    const scale = transform().scale;
    state.camera = {
      ...state.camera,
      // Center within the unobscured part of the canvas, not behind the sidebar.
      centerX: bounds.x + bounds.width / 2 - inset / (2 * scale),
      centerY: bounds.y + bounds.height / 2,
    };
  }

  function handleBrowserFindMatch(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const article = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
    const shapeId = article?.dataset.shapeId;
    const shape = shapeId ? shapesById().get(shapeId) : null;
    if (!article || !shape || !isBrowserFindTarget(shape)) return;

    moveCameraToShape(shape);

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
  }

  // Centers the viewport on the document's content the first time it loads, so a
  // saved canvas opens framed instead of pinned to world origin. Fires at most
  // once: `isInitialContent` is false for the user's own first edit (Yjs origin
  // null), which only disarms the one-shot rather than recentering their view.
  let hasFitInitialView = false;
  function fitInitialViewIfNeeded(isInitialContent: boolean) {
    if (hasFitInitialView || !isReady) return;
    if (state.shapes.length === 0 && state.strokes.length === 0) return;
    hasFitInitialView = true;
    // Frame the content but never magnify past 100% on load.
    if (isInitialContent) fitView(1);
  }

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

  function handleKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    // document-view hosts the embedded document editor; shadow-DOM events
    // retarget to the host element, so closest() must match the host itself.
    if (target?.closest("textarea, input, select, document-view")) return;

    if (event.key === "Escape") {
      if (cancelToolPointerGesture("escape") || cancelTransformDrag()) {
        event.preventDefault();
        return;
      }
    }

    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "s") {
      event.preventDefault();
      void manualSave();
      return;
    }

    // Undo / redo: Cmd/Ctrl+Z, redo via Cmd/Ctrl+Shift+Z or Ctrl+Y.
    if ((event.metaKey || event.ctrlKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "y") {
      event.preventDefault();
      redo();
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      deleteSelectedShape();
      return;
    }

    const shortcutTool = CANVAS_TOOLS.find((tool) => tool.shortcut.toLowerCase() === key);
    if (shortcutTool) state.activeTool = shortcutTool.id;
    if (key === "r") state.activeTool = "shape";
    if (key === "f") fitView();
  }

  // Inline document editing ends as soon as the card leaves the (single)
  // selection — clicking the canvas, selecting another shape, or deleting the
  // card all funnel through here and tear the editor (and its presence) down.
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

  // Moving a card changes updatedAt and refreshes the shapes array. Watch a
  // stable key of the actual preview inputs instead, so those visual edits never
  // cause preview work. The loaders themselves remain responsible for caching.
  // --- reactions ---------------------------------------------------------
  /**
   * What used to be sixteen `watch` calls, as one ordered pass.
   *
   * Each entry fires when the value it is handed differs from the previous flush.
   * Reading them top to bottom is the whole point: with `watch` the order between
   * two reactions on the same value was an artefact of declaration order buried
   * three thousand lines apart, and here it is the list.
   */
  function runReactions(): void {
    watch("cursorColor", host.cursorColor, () => updatePresence());

    watch("camera", state.camera, () => {
      if (!state.isCameraMoving) state.isCameraMoving = true;
      if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
      cameraMoveTimer = setTimeout(() => {
        state.isCameraMoving = false;
        renderSelections(true);
        invalidate();
      }, 150);
    });

    watch("selection", state.selectedShapeIds, (ids) => {
      if (state.editingChromeId && (ids.size !== 1 || !ids.has(state.editingChromeId))) {
        finishChromeEditing();
      }
      updatePresence();
    });

    watch("selection:edit", state.selectedShapeIds, (ids) => {
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

    watch("strokeSelection", state.selectedStrokeIds, () => updatePresence());

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

    // Drawn every frame rather than watched. The selection overlay is part of
    // painting, and four reactions used to exist only to ask for it — two of
    // which fired on every frame anyway, because the arrays they compared were
    // freshly built on each read.
    renderSelections();
  }

  /**
   * Reactions that need the DOM to already show the new state.
   *
   * The canvas layers are drawn from measured element geometry, so running
   * them before the template is patched would paint against the previous
   * frame's layout.
   */
  function runPostRenderReactions(): void {
    watchPost("transform", transform(), () => dom.canvasToolbar?.reposition());

    watchPost("shapes", state.shapes, () => {
      renderScene();
      renderSelections();
    });

    watchPost(
      "viewport",
      `${state.camera.centerX}:${state.camera.centerY}:${state.camera.zoom}:${state.screen.width}:${state.screen.height}`,
      () => {
        renderInk();
        updatePresence();
      },
    );
  }

  // --- lifecycle ---------------------------------------------------------
  /**
   * Input handled on `window` rather than on the element.
   *
   * A drag has to keep tracking once the pointer leaves the canvas, and the
   * keyboard has no position at all. These sit outside the host, so the host's
   * own input listener never sees them and each one asks for a frame itself.
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
    undoManager.destroy();
    for (const [type, handler] of windowHandlers) {
      window.removeEventListener(type, handler);
    }
    if (saveTimer) clearTimeout(saveTimer);
    if (saveStateTimer) clearTimeout(saveStateTimer);
    if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
    if (inkRafId !== null) cancelAnimationFrame(inkRafId);
    if (presenceRafId !== null) cancelAnimationFrame(presenceRafId);
    inkRenderer.dispose();
    selectionRenderer.dispose();
  }

  // --- view --------------------------------------------------------------
  /**
   * Everything the template is allowed to touch.
   *
   * An explicit surface rather than handing the template the closure: it is the
   * only place that lists what rendering actually depends on, and it is what
   * makes the template a module instead of three thousand lines of the same file.
   */
  const view = {
    // state
    /**
     * Read wholesale rather than through one forwarding getter per field. The
     * proxy is already the live object, and a getter list has to be extended
     * by hand every time the state gains a field.
     */
    get state(): Readonly<typeof state> {
      return state;
    },
    get activeDrawStrokeMode() {
      return activeDrawStrokeMode.get();
    },
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
    selectedTransformShape,
    selectedResizeOnlyShape,
    selectedScalableSelection,
    selectedBasicShapeStroke,
    selectedBasicShapeStrokeControls,
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
    setActiveTool: (tool: CanvasTool) => {
      state.activeTool = tool;
    },
    setActiveDrawStrokeMode: (mode: DrawStrokeMode) => activeDrawStrokeMode.set(mode),
    setActiveElementColor,
    setActivePenColor,
    setSelectedElementColor,
    setSelectedStrokeColor,
    pickShapeLibraryItem,
    closeContextMenu: () => {
      state.contextMenuPos = null;
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
    startShapeRotation,
    startShapeResize,
    startSelectionScale,
    startStrokeRotation,
    startStrokeResize,
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
    /**
     * Marks the canvas dirty.
     *
     * For host properties: they live on the element rather than in the state
     * proxy, so writing one schedules nothing on its own.
     */
    invalidate,
    /** Runs the reactions that must observe the pre-render state, then renders. */
    flush() {
      runReactions();
    },
    /** Runs the reactions that need the DOM to already reflect the new state. */
    afterRender() {
      runPostRenderReactions();
    },
    destroy() {
      unregister();
      destroy();
    },
  };
}
