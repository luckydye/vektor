<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  shallowRef,
  toRaw,
  watch,
} from "vue";
import * as Y from "yjs";
import { api } from "#api/client.ts";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import { useDocument } from "#composeables/useDocument.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import {
  canvasFitViewIcon,
  canvasSelectIcon,
  canvasShapeIcon,
  clipboardDocumentIcon,
  copyIcon,
  lockIcon,
  pencilIcon,
  redoArrowIcon,
  scissorsIcon,
  trashIcon,
  undoArrowIcon,
  unlockIcon,
  uploadIcon,
} from "~/src/assets/icons.ts";
import {
  activeDrawStrokeMode,
  activeShapeId,
  type CanvasElementContext,
  type CanvasShapeLibraryItem,
  type CanvasSelectionSnapshot,
  cloneFreehandPoint,
  createCanvasInkRenderer,
  createCanvasSelectionRenderer,
  createCanvasExtensionManager,
  createStrokeMap,
  DRAW_STROKE_MODES,
  FREEHAND_STYLE,
  hitTestCanvasStroke,
  PEN_COLORS,
  renderCanvasInkOverlay,
  SHAPE_LIBRARY,
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
  normalizeRotation,
  pointOnRotatedShape,
  resizeRotatedShapeFromBottomRight,
  rotatedShapeBounds,
  rotatedShapeCorners,
  rotateVector,
  rotationFromPointer,
  snapRotation,
} from "./viewport/geometry.ts";
import "#editor/elements/rich-text-editor.ts";
import "#editor/elements/toolbar.ts";
import "@atrium-ui/elements/popover";
import { useToast } from "#composeables/useToast.ts";
import {
  CANVAS_CLIPBOARD_MIME,
  type CanvasClipboard,
  canvasClipboardToDocumentHtml,
  canvasClipboardToPlainText,
  createCanvasClipboard,
  documentClipboardToCanvasShapes,
  serializeCanvasClipboard,
} from "#utils/clipboard.ts";
import { type TranslationKey, t } from "#utils/lang.ts";
import {
  CANVAS_CURSOR_COLOR_CHANGE_EVENT,
  CANVAS_CURSOR_COLOR_STORAGE_KEY,
  readCanvasCursorColor,
} from "#utils/userPreferences.ts";
import {
  buildTransform,
  computeSnapGuides,
  createViewportControls,
  drawWorldDots,
  drawWorldGrid,
  type FitReference,
  type FreehandPoint,
  type FreehandStroke,
  panCameraByScreenDelta,
  type ScreenSize,
  type SnapGuide,
  type SnapTarget,
  snapRectToGuides,
  type ViewportCamera,
  type ViewportControls,
  screenToWorld as viewportScreenToWorld,
  worldToScreen as viewportWorldToScreen,
  type WorldRect,
  type WorldTransform,
  worldViewportBounds,
} from "./viewport/index.ts";

const props = defineProps<{
  spaceId: string;
  documentId?: string;
  ydoc: Y.Doc;
  presenceProfiles?: CollaborationPresenceProfile<CanvasPresenceState>[];
  extensions?: readonly CanvasElementExtension[];
  tools?: readonly CanvasToolExtension[];
}>();

const emit = defineEmits<{
  presence: [states: CanvasPresenceState[]];
}>();

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

type Rect = { x: number; y: number; width: number; height: number };
type LockedCanvasElement = { type: "shape" | "stroke"; id: string };

const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
type ToolDef = {
  id: CanvasTool;
  label: TranslationKey;
  shortcut: string;
  icon: string;
};

const extensionManager = createCanvasExtensionManager({
  elements: props.extensions,
  tools: props.tools,
});

// Built-in engine tools plus element-contributed tools
// collected from the registry, so adding an element type surfaces its tool
// without editing the host.
const CANVAS_TOOLS: ToolDef[] = [
  { id: "select", label: "Select", shortcut: "V", icon: canvasSelectIcon },
  { id: "draw", label: "Draw", shortcut: "D", icon: pencilIcon },
  ...extensionManager.elementTools(),
];
const viewportRef = ref<HTMLElement | null>(null);
const sceneRef = ref<HTMLCanvasElement | null>(null);
const activeInkRef = ref<HTMLCanvasElement | null>(null);
const selectionRef = ref<HTMLCanvasElement | null>(null);
const shapes = shallowRef<CanvasShape[]>([]);
const strokes = shallowRef<CanvasStroke[]>([]);
const selectedShapeIds = ref<Set<string>>(new Set());
const selectedStrokeIds = ref<Set<string>>(new Set());
// Locked elements are intentionally excluded from normal hit testing. Keep a
// separate hover target so their small unlock control remains reachable.
const hoveredLockedElement = ref<LockedCanvasElement | null>(null);
// Section chrome is painted on the canvas. This transient input only appears
// while its title is actively being edited.
const editingChromeId = ref<string | null>(null);
// Live screen-space rectangle while drag-selecting; null when not marqueeing.
const marqueeRect = ref<Rect | null>(null);
// Alignment guides shown while dragging shapes; empty when no edge/center of
// the dragged group is snapped to another shape. Drawn on the ink overlay.
let activeSnapGuides: SnapGuide[] = [];
// How close (in screen px) a dragged edge/center must come to another shape's
// edge/center before it snaps to it.
const SNAP_THRESHOLD_PX = 6;
// Only shapes within this screen-space margin of the dragged group are
// considered as snap targets, so a canvas with hundreds of elements stays fast.
const SNAP_PROXIMITY_PX = 320;
// True only while a pan drag is in progress, so the viewport shows the grabbing
// hand during panning and a resting cursor otherwise.
const isPanning = ref(false);
const activeTool = ref<CanvasTool>("select");
const shapePopoverRef = ref<(HTMLElement & { hide: () => void }) | null>(null);
// Shared inline-formatting toolbar (<document-toolbar variant="canvas">),
// retargeted to whichever text shape's editor is focused.
type CanvasFormatToolbarEl = HTMLElement & {
  editor: unknown;
  dismiss: () => void;
  reposition: () => void;
};
const canvasToolbarRef = ref<CanvasFormatToolbarEl | null>(null);
// Active swatch per color-capable element type (used when creating new shapes),
// seeded from each extension's palette. Recoloring a selected shape writes here
// too. Data-driven from the registry — no per-type refs.
const colorPalettes = extensionManager.colorPalettes();
const activeColors = reactive<Record<string, string>>(
  Object.fromEntries(colorPalettes.map((entry) => [entry.type, entry.palette[0]])),
);
const penColor = ref<string>(PEN_COLORS[0]);
const cursorColor = ref<string>(readCanvasCursorColor());
// Backdrop grid style, driven by the document's "gridtype" property. "grid"
// draws ruled lines, "dots" a dot grid, and "clean" leaves the backdrop empty.
type GridType = "grid" | "clean" | "dots";
const gridType = ref<GridType>("dots");
const saveState = ref<"idle" | "saving" | "saved">("idle");
const toast = useToast();
const isDarkMode = ref(false);
let localPointer: { x: number; y: number } | null = null;

const camera = ref<ViewportCamera>({ centerX: 0, centerY: 0, zoom: 1 });
const screen = ref<ScreenSize>({ width: 1, height: 1 });
const { document: documentData, saveDocument } = useDocument(props.documentId, "canvas");
const { currentSpace } = useSpace();
const currentUser = useUserProfile();
const currentUserId = computed(() => currentUser.value?.id);
const userCanEditCanvas = computed(() => canEdit(currentSpace.value?.userRole));
// Singleton extension-owned editor session. The host only mounts the supplied
// tag/props and invokes its finish callback.
const activeEditSession = ref<CanvasEditSession | null>(null);
const activeEditorElement = shallowRef<HTMLElement | null>(null);

const ydoc = props.ydoc;
const yShapes = ydoc.getMap<Y.Map<unknown>>("canvas.shapes");
const yStrokes = ydoc.getMap<Y.Map<unknown>>("canvas.strokes");

const currentOrigin =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

// Tracks only local edits (default trackedOrigins = {null}); remote/agent
// updates arrive with origin "remote" and are excluded, so undo/redo only
// reverts this user's own changes.
const undoManager = new Y.UndoManager([yShapes, yStrokes]);

function insertNewShape(shape: CanvasShape) {
  yShapes.set(shape.id, createShapeMap(shape));
  selectOnlyShape(shape.id);
  activeTool.value = "select";
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
const contextMenuPos = ref<{ x: number; y: number } | null>(null);
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
const intrinsicShapeSizes = shallowRef(
  new Map<string, { width: number; height: number }>(),
);

const extensionRuntime = extensionManager.createRuntime({
  spaceId: props.spaceId,
  documentId: props.documentId,
  currentOrigin,
  persistShape: (shape) => yShapes.set(shape.id, createShapeMap(shape)),
  insertNewShape,
  selectShape: selectOnlyShape,
  selectShapes: (ids) => {
    selectedShapeIds.value = new Set(ids);
  },
  setActiveTool: (tool) => {
    activeTool.value = tool;
  },
  setBusy: (busy) => {
    saveState.value = busy ? "saving" : "idle";
    dispatchSaveStatus();
  },
  commitInsertion: saveImmediately,
  canEdit: () => userCanEditCanvas.value,
  wasDragged: () => dragMoved,
  beginEdit,
  reportError: (error) =>
    toast.error(error instanceof Error ? error.message : String(error)),
});
const uploadPlaceholders = extensionRuntime.uploadPlaceholders;

const remoteCanvasPresences = computed(() => props.presenceProfiles ?? []);

const remoteCanvasPointerPresences = computed(() =>
  remoteCanvasPresences.value.filter((presence) => presence.state?.pointer),
);

const remoteCanvasSelections = computed(() =>
  remoteCanvasPresences.value.flatMap((presence) => {
    const state = presence.state;
    if (!state?.selectionIds.length) return [];

    return state.selectionIds.flatMap((itemId) => {
      const shape = shapesById.value.get(itemId);
      if (!shape) return [];
      return [
        {
          clientId: presence.clientId,
          user: presence.user,
          cursorColor:
            state.cursorColor ||
            presence.user.color ||
            getPresenceColor(presence.user.id),
          itemId,
          bounds: shapeBounds(shape),
        },
      ];
    });
  }),
);

const remoteCanvasStrokeSelections = computed(() =>
  remoteCanvasPresences.value.map((presence) => ({
    ids: new Set(
      presence.state?.selectionIds.filter((id) => strokesById.value.has(id)) ?? [],
    ),
    color:
      presence.state?.cursorColor ||
      presence.user.color ||
      getPresenceColor(presence.user.id),
  })),
);

// Remote pointers arrive as discrete presence updates; a CSS transition on the
// cursor smooths the jumps. While the local camera moves, the transition is
// suspended so cursors stay locked to the canvas instead of lagging behind the
// pan/zoom.
const isCameraMoving = ref(false);
let cameraMoveTimer: ReturnType<typeof setTimeout> | null = null;

watch(camera, () => {
  if (!isCameraMoving.value) {
    isCameraMoving.value = true;
  }
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
  cameraMoveTimer = setTimeout(() => {
    isCameraMoving.value = false;
    renderSelections(true);
  }, 150);
});
// The single selected shape, or null when nothing or multiple things are
// selected. Drives the per-shape affordances (note color, resize handle) that
// only make sense for one shape at a time.
const selectedShape = computed(() => {
  if (selectedShapeIds.value.size !== 1 || selectedStrokeIds.value.size > 0) {
    return null;
  }
  const [id] = selectedShapeIds.value;
  return shapesById.value.get(id) ?? null;
});

// Transform affordances are declared per type on the extension. Types that can
// rotate get the full rotate+resize controls (note/text/media); sections and
// embedded documents declare resize without rotate, so they expose resize only.
// Everything else stays move-only.
const selectedTransformShape = computed(() => {
  const shape = selectedShape.value;
  if (!shape || !canMoveShape(shape)) return null;
  return extensionManager.get(shape.type).behavior.transform.rotate ? shape : null;
});

// Types that resize but don't rotate get a lone resize handle.
const selectedResizeOnlyShape = computed(() => {
  const shape = selectedShape.value;
  if (!shape || !canMoveShape(shape)) return null;
  const transform = extensionManager.get(shape.type).behavior.transform;
  return transform && transform.resize !== "none" && !transform.rotate ? shape : null;
});

function transformControlPositions(shape: CanvasShape) {
  // Text auto-sizes, so anchor the handles to its measured box.
  const bounds = shapeBounds(shape);
  // Handles stay a comfortable fixed size in screen space. Convert their
  // offset back to world units before placing them around the rotated shape.
  const offset = 24 / transform.value.scale;
  const resizeOffset = 18 / transform.value.scale / Math.SQRT2;
  return {
    rotation: worldToScreen(
      pointOnRotatedShape(bounds, { x: bounds.width / 2, y: -offset }),
    ),
    resize: worldToScreen(
      pointOnRotatedShape(bounds, {
        x: bounds.width + resizeOffset,
        y: bounds.height + resizeOffset,
      }),
    ),
  };
}

// Custom-element tag registered by an extension for its DOM body.
function elementTagForShape(shape: CanvasShape): string | null {
  const tag = extensionManager.get(shape.type).render.tag;
  if (!tag || typeof customElements === "undefined" || !customElements.get(tag)) {
    return null;
  }
  // While an extension edits inline, the host swaps in the editor supplied by
  // that extension's active edit session.
  if (activeEditSession.value?.shapeId === shape.id) {
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
  const extension = extensionManager.get(shape.type);
  const frame = shape.frame;
  const style: Record<string, string> = {
    left: `${frame.x}px`,
    top: `${frame.y}px`,
    transform: `rotate(${frame.rotation}deg)`,
  };
  if (extension.behavior.transform.resize !== "font") {
    style.width = `${frame.width}px`;
    style.height = `${frame.height}px`;
  }
  if (extension.render.article?.background !== false)
    style.background = shape.style.color;
  return { ...style, ...extension.render.article?.style?.(shape) };
}

// Sets the host-owned singleton slot for an extension-supplied editor.
function beginEdit(session: CanvasEditSession) {
  if (activeEditSession.value?.shapeId === session.shapeId) return;
  stopActiveEdit();
  selectOnlyShape(session.shapeId);
  activeEditSession.value = session;
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
  spaceId: props.spaceId,
  wasDragged: () => dragMoved,
  updateData: (id, patch) => {
    const shape = shapesById.value.get(id);
    if (!shape || shape.locked) return;
    updateShapeData(id, patch);
  },
  removeShape: (id) => {
    if (shapesById.value.get(id)?.locked) return;
    yShapes.delete(id);
    if (selectedShapeIds.value.has(id)) {
      selectedShapeIds.value.delete(id);
      selectedShapeIds.value = new Set(selectedShapeIds.value);
    }
  },
  selectShape: (id) => selectOnlyShape(id),
  setFormattingEditor: (editor) => {
    const toolbar = canvasToolbarRef.value;
    if (toolbar) toolbar.editor = editor;
  },
  reportSize: (id, size) => {
    const shape = shapesById.value.get(id);
    if (!shape || !yShapes.has(id)) return;
    const extension = extensionManager.get(shape.type);
    const minimum = extension.defaults.minSize;
    if (extension.behavior.transform.resize === "font") {
      if (size.width === undefined || size.height === undefined) return;
      const measured = {
        width: Math.max(minimum.width, size.width),
        height: Math.max(minimum.height, size.height),
      };
      const current = intrinsicShapeSizes.value.get(id);
      if (current?.width === measured.width && current?.height === measured.height)
        return;
      const next = new Map(intrinsicShapeSizes.value);
      next.set(id, measured);
      intrinsicShapeSizes.value = next;
      renderSelections();
      return;
    }
    if (!userCanEditCanvas.value || dragState?.shapeId === id || !canMoveShape(shape)) {
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
const domShapes = computed(() =>
  shapes.value.filter((shape) => extensionManager.rendersInDom(shape)),
);

// Shapes painted via a canvas-2d extension hook, drawn behind the DOM.
const paintedShapes = computed(() =>
  shapes.value.filter((shape) => extensionManager.paint(shape.type)),
);

const editingChromeShape = computed(() => {
  const id = editingChromeId.value;
  if (!id) return null;
  const shape = shapesById.value.get(id);
  return shape && extensionManager.get(shape.type).render.chrome ? shape : null;
});

function editorTagForShape(shape: CanvasShape) {
  return extensionManager.get(shape.type).render.chrome?.editorTag;
}

function elementChromePosition(shape: CanvasShape) {
  return (
    extensionManager.get(shape.type).render.chrome?.position(shape, {
      scale: transform.value.scale,
      worldToScreen,
    }) ?? worldToScreen({ x: shape.frame.x, y: shape.frame.y })
  );
}

function elementChromeSize(shape: CanvasShape) {
  return (
    extensionManager.get(shape.type).render.chrome?.size(shape, {
      scale: transform.value.scale,
      t,
    }) ?? { width: 1, height: 1 }
  );
}

// Canvas-rasterized shapes within the current viewport. Used only by
// raster rendering to avoid paint calls for off-screen elements.
const visibleRasterShapes = computed(() => {
  const vr = worldViewportBounds(camera.value, screen.value, FIT_REFERENCE, 400);
  return shapes.value.filter(
    (shape) => extensionManager.rasters(shape) && rectsIntersect(vr, shapeAabb(shape)),
  );
});

const selectedStrokeColor = computed(() => {
  if (selectedStrokeIds.value.size === 0) return null;
  let color: string | null = null;
  for (const id of selectedStrokeIds.value) {
    const stroke = strokesById.value.get(id);
    if (!stroke) continue;
    if (color === null) color = stroke.style.color;
    else if (stroke.style.color !== color) return null;
  }
  return color;
});

const shapesById = computed(() => new Map(shapes.value.map((s) => [s.id, s])));
const strokesById = computed(() => new Map(strokes.value.map((s) => [s.id, s])));
const hasLockedStrokes = computed(() => strokes.value.some((stroke) => stroke.locked));

function isShapeLocked(id: string): boolean {
  return shapesById.value.get(id)?.locked === true;
}

function isStrokeLocked(id: string): boolean {
  return strokesById.value.get(id)?.locked === true;
}

function canMoveUserScopedElement(authorId: string | undefined): boolean {
  // `authorId` is an internal creation-time capability, not a user-facing
  // canvas setting. Future cosmetic/sticker creators set it to the active
  // user's id; every movement path below then honors that ownership.
  return !authorId || authorId === currentUserId.value;
}

function canMoveShape(shape: CanvasShape): boolean {
  return !shape.locked && canMoveUserScopedElement(shape.authorId);
}

function canMoveStroke(stroke: CanvasStroke): boolean {
  return !stroke.locked && canMoveUserScopedElement(stroke.authorId);
}

const hoveredLockedElementPosition = computed(() => {
  const element = hoveredLockedElement.value;
  if (!element) return null;

  if (element.type === "shape") {
    const shape = shapesById.value.get(element.id);
    if (!shape?.locked) return null;
    const bounds = shapeBounds(shape);
    return worldToScreen(pointOnRotatedShape(bounds, { x: bounds.width, y: 0 }));
  }

  const stroke = strokesById.value.get(element.id);
  const bounds = stroke ? strokeBounds(stroke) : null;
  if (!stroke?.locked || !bounds) return null;
  return worldToScreen({ x: bounds.x + bounds.width, y: bounds.y });
});

const selectedBasicShapeStroke = computed(() => {
  if (selectedShapeIds.value.size > 0 || selectedStrokeIds.value.size !== 1) return null;
  const [id] = selectedStrokeIds.value;
  const stroke = strokesById.value.get(id);
  return stroke?.kind === "shape" && canMoveStroke(stroke) ? stroke : null;
});

const selectedBasicShapeStrokeControls = computed(() => {
  const stroke = selectedBasicShapeStroke.value;
  return stroke ? strokeTransformControlPositions(stroke) : null;
});

function selectOnlyShape(id: string) {
  if (isShapeLocked(id)) return;
  selectedShapeIds.value = new Set([id]);
  if (selectedStrokeIds.value.size > 0) {
    selectedStrokeIds.value = new Set();
    renderInk();
  }
}

function selectStroke(id: string, additive: boolean) {
  if (isStrokeLocked(id)) return;
  if (additive) {
    const next = new Set(selectedStrokeIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedStrokeIds.value = next;
  } else {
    selectedShapeIds.value = new Set();
    selectedStrokeIds.value = new Set([id]);
  }
  renderInk();
}

function toggleShapeSelection(id: string) {
  if (isShapeLocked(id)) return;
  const next = new Set(selectedShapeIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedShapeIds.value = next;
}

function clearSelection() {
  if (selectedShapeIds.value.size > 0) selectedShapeIds.value = new Set();
  if (selectedStrokeIds.value.size > 0) {
    selectedStrokeIds.value = new Set();
    renderInk();
  }
}

function rectsIntersect(a: Rect, b: Rect) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function rectContains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function getPresenceColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

function toNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const MIN_FONT_SCALE = 0.3;
const MAX_FONT_SCALE = 10;

function clampFontScale(value: number) {
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

function intrinsicShapeSize(shape: CanvasShape) {
  return (
    intrinsicShapeSizes.value.get(shape.id) ??
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
  return Boolean(shape && extensionManager.get(shape.type).behavior.container);
}

// Whether the host should preventDefault a shape's pointer interaction. Types
// whose whole body is a live editor (text) opt out so native focus/caret works.
function suppressesNativePointer(shape: CanvasShape): boolean {
  return !extensionManager.get(shape.type).behavior.editableBody;
}

function shapeAabb(shape: CanvasShape): Rect {
  return rotatedShapeBounds(shapeBounds(shape));
}

function strokeBounds(stroke: Pick<CanvasStroke, "points">): Rect | null {
  if (stroke.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function strokeTransformControlPositions(stroke: CanvasStroke) {
  const bounds = strokeBounds(stroke);
  if (!bounds) return null;
  const offset = 24 / transform.value.scale;
  const resizeOffset = 18 / transform.value.scale / Math.SQRT2;
  return {
    rotation: worldToScreen({ x: bounds.x + bounds.width / 2, y: bounds.y - offset }),
    resize: worldToScreen({
      x: bounds.x + bounds.width + resizeOffset,
      y: bounds.y + bounds.height + resizeOffset,
    }),
  };
}

function toShape(
  id: string,
  source: Y.Map<unknown> | CanvasSerializedShape,
): CanvasShape | null {
  const read = (key: string) => (source instanceof Y.Map ? source.get(key) : source[key]);

  const typeValue = read("type");
  if (!extensionManager.has(typeValue)) return null;
  const type = typeValue;
  const extension = extensionManager.get(type);
  const defaultSize = extension.defaults.size;
  const minSize = extension.defaults.minSize;
  const frameValue = read("frame");
  const styleValue = read("style");
  const dataValue = read("data");
  const readNested = (value: unknown, key: string) => {
    if (value instanceof Y.Map) return value.get(key);
    if (value && typeof value === "object") {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  };
  const storedData =
    dataValue instanceof Y.Map
      ? Object.fromEntries(dataValue.entries())
      : dataValue && typeof dataValue === "object"
        ? { ...(dataValue as Record<string, unknown>) }
        : {};
  const rawData = { ...extension.defaults.data, ...storedData };
  const base: CanvasShape = {
    id,
    type,
    frame: {
      x: toNumber(readNested(frameValue, "x"), 0),
      y: toNumber(readNested(frameValue, "y"), 0),
      width: Math.max(
        minSize.width,
        toNumber(readNested(frameValue, "width"), defaultSize.width),
      ),
      height: Math.max(
        minSize.height,
        toNumber(readNested(frameValue, "height"), defaultSize.height),
      ),
      rotation: normalizeRotation(toNumber(readNested(frameValue, "rotation"), 0)),
    },
    style: {
      color:
        typeof readNested(styleValue, "color") === "string"
          ? String(readNested(styleValue, "color"))
          : extension.defaults.style.color,
    },
    data:
      extension.storage?.parseData?.(rawData, {
        currentOrigin,
        defaultSpaceId: props.spaceId,
      }) ?? rawData,
    authorId: typeof read("authorId") === "string" ? String(read("authorId")) : undefined,
    locked: read("locked") === true || undefined,
    updatedAt: toNumber(read("updatedAt"), Date.now()),
  };
  return base;
}

function toStroke(
  id: string,
  source: Y.Map<unknown> | CanvasStrokeSnapshot,
): CanvasStroke {
  return toCanvasStroke(id, source, transform.value.scale);
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

  shapes.value = [...yShapes.entries()]
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
  for (const id of selectedShapeIds.value) {
    const source = yShapes.get(id);
    const shape = source ? toShape(id, source) : null;
    if (!shape || shape.locked) {
      selectedShapeIds.value.delete(id);
      pruned = true;
    }
  }
  if (pruned) selectedShapeIds.value = new Set(selectedShapeIds.value);
  if (removedInvalid) {
    if (isReady) scheduleSave();
    else savePrunedInvalidShapesWhenReady = true;
  }

  // Drop cached measured sizes for shapes that no longer exist (text elements
  // report their intrinsic size via reportSize; the element can't clean up
  // after itself once it's gone).
  if (intrinsicShapeSizes.value.size > 0) {
    const live = new Set(shapes.value.map((shape) => shape.id));
    let changed = false;
    const next = new Map(intrinsicShapeSizes.value);
    for (const id of next.keys()) {
      if (!live.has(id)) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) intrinsicShapeSizes.value = next;
  }
}

function syncStrokesFromY() {
  const previous = new Map(strokes.value.map((stroke) => [stroke.id, stroke]));
  strokes.value = [...yStrokes.entries()]
    .map(([id, value]) => {
      const existing = previous.get(id);
      const updatedAt = value.get("updatedAt");
      return existing && existing.updatedAt === updatedAt
        ? existing
        : toStroke(id, value);
    })
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  let pruned = false;
  for (const id of selectedStrokeIds.value) {
    const source = yStrokes.get(id);
    if (!source || source.get("locked") === true) {
      selectedStrokeIds.value.delete(id);
      pruned = true;
    }
  }
  if (pruned) selectedStrokeIds.value = new Set(selectedStrokeIds.value);
  renderInk();
}

function createShapeMap(shape: CanvasSerializedShape) {
  const map = new Y.Map<unknown>();
  map.set("type", shape.type);
  const frame = new Y.Map<unknown>();
  frame.set("x", shape.frame.x);
  frame.set("y", shape.frame.y);
  if (extensionManager.persistsSize(shape.type)) {
    frame.set("width", shape.frame.width);
    frame.set("height", shape.frame.height);
  }
  frame.set("rotation", shape.frame.rotation);
  map.set("frame", frame);
  const style = new Y.Map<unknown>();
  style.set("color", shape.style.color);
  map.set("style", style);
  const data = new Y.Map<unknown>();
  const serializedData =
    extensionManager.get(shape.type).storage?.serializeData?.(shape.data) ?? shape.data;
  for (const [key, value] of Object.entries(serializedData)) {
    if (value !== undefined) data.set(key, value);
  }
  map.set("data", data);
  if (shape.authorId) map.set("authorId", shape.authorId);
  if (shape.locked) map.set("locked", true);
  map.set("updatedAt", shape.updatedAt);
  return map;
}

function serializeShape(shape: CanvasShape): CanvasSerializedShape {
  return extensionManager.serialize(shape);
}

function serializeSnapshot(): string {
  const snapshot: CanvasSnapshot = {
    version: 1,
    shapes: shapes.value.map(serializeShape),
    strokes: strokes.value.map((stroke) => ({
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
      detail: { status: saveState.value },
    }),
  );
}

async function manualSave() {
  if (!isReady) return;
  saveState.value = "saving";
  dispatchSaveStatus();

  try {
    const content = serializeSnapshot();
    if (props.documentId) {
      const response = await fetch(
        `/api/v1/spaces/${props.spaceId}/documents/${props.documentId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
    } else {
      await saveDocument(content);
    }

    saveState.value = "saved";
    dispatchSaveStatus();
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      if (saveState.value === "saved") {
        saveState.value = "idle";
        dispatchSaveStatus();
      }
    }, 1600);
  } catch (err) {
    saveState.value = "idle";
    toast.error(err instanceof Error ? err.message : String(err));
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
  const rect = cachedViewportRect;
  return {
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0),
  };
}

const transform = computed(() =>
  buildTransform(camera.value, screen.value, FIT_REFERENCE),
);

// The canvas moves shapes by transforming the viewport, which fires no
// scroll/resize event — so the fixed-position formatting toolbar won't follow
// on its own. Re-anchor it after each transform is painted (flush: "post" so
// the editor DOM reflects the new position when we read its coords).
watch(transform, () => canvasToolbarRef.value?.reposition(), { flush: "post" });

const canvasCursorCache = new Map<string, string>();
function makeCanvasCursor(color: string): string {
  if (typeof document === "undefined") return "default";
  const cached = canvasCursorCache.get(color);
  if (cached) return cached;

  const size = 18;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "default";
  ctx.scale(0.56, 0.56);

  const path = new Path2D(
    "M5.1 4.8a1.2 1.2 0 0 1 1.53-1.54l20.4 8.28a1.2 1.2 0 0 1-.14 2.26l-7.81 2.01a2.4 2.4 0 0 0-1.72 1.72l-2.01 7.81a1.2 1.2 0 0 1-2.26.14z",
  );

  ctx.shadowColor = "rgba(15, 23, 42, 0.25)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "white";
  ctx.lineJoin = "round";
  ctx.stroke(path);

  const result = `url("${canvas.toDataURL()}") 3 3, default`;
  canvasCursorCache.set(color, result);
  return result;
}

// Panning (middle/right-drag) shows the grabbing hand; otherwise the canvas uses
// a local colored cursor that matches the color broadcast to collaborators.
const viewportCursor = computed(() => {
  if (isPanning.value) return "grabbing";
  return makeCanvasCursor(cursorColor.value);
});

function screenToWorld(point: { x: number; y: number }) {
  return viewportScreenToWorld(point.x, point.y, transform.value);
}

function worldToScreen(point: { x: number; y: number }) {
  return viewportWorldToScreen(point.x, point.y, transform.value);
}

// Cached CSS variable values — read once at mount and on theme change.
// getComputedStyle().getPropertyValue() forces a style recalc so we must
// not call it per-frame.
let cssGridMajor = "rgba(15, 23, 42, 0.13)";
let cssGridMinor = "rgba(15, 23, 42, 0.07)";
let cssInkColor = FREEHAND_STYLE.color;
let cssChromeText = "#1e3a8a";

function canvasCssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const source = viewportRef.value ?? document.documentElement;
  return getComputedStyle(source).getPropertyValue(name).trim() || fallback;
}

function refreshCssVars() {
  cssGridMajor = canvasCssVar("--canvas-grid-major", "rgba(15, 23, 42, 0.13)");
  cssGridMinor = canvasCssVar("--canvas-grid-minor", "rgba(15, 23, 42, 0.07)");
  cssInkColor = canvasCssVar("--canvas-ink-color", FREEHAND_STYLE.color);
  cssChromeText = canvasCssVar("--canvas-section-title-text", "#1e3a8a");
}

function resolveDarkMode() {
  if (typeof window === "undefined") return false;
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function updateThemeMode() {
  isDarkMode.value = resolveDarkMode();
  void nextTick(renderThemeChanged);
}

function renderThemeChanged() {
  refreshCssVars();
  renderInk();
}

function applyGridType(value: unknown) {
  const next: GridType =
    value === "clean" || value === "dots" || value === "grid" ? value : "dots";
  if (next === gridType.value) return;
  gridType.value = next;
  renderScene();
}

function defaultInkColor() {
  return cssInkColor;
}

const inkRenderer = createCanvasInkRenderer({
  getDpr: () => dpr,
  getScreen: () => screen.value,
  getTransform: () => transform.value,
  getStrokes: () => strokes.value,
  getDefaultInkColor: defaultInkColor,
  invalidateScene: renderScene,
});
const selectionRenderer = createCanvasSelectionRenderer();

// This snapshot deliberately excludes camera state. Its identity therefore
// stays stable through pan/zoom frames and changes only when the selection
// geometry itself needs to be rebuilt.
const selectionSnapshot = computed<CanvasSelectionSnapshot>(() => ({
  strokes: strokes.value,
  selectedStrokeIds: selectedStrokeIds.value,
  remoteSelectedStrokeIds: remoteCanvasStrokeSelections.value,
  selectedShapeBounds: [...selectedShapeIds.value]
    .map((id) => shapesById.value.get(id))
    .filter((shape) => shape != null)
    .map(shapeBounds),
  remoteSelectedShapeBounds: remoteCanvasSelections.value.map((selection) => ({
    x: selection.bounds.x,
    y: selection.bounds.y,
    width: selection.bounds.width,
    height: selection.bounds.height,
    rotation: selection.bounds.rotation,
    type: selection.bounds.type,
    color: selection.cursorColor,
  })),
}));

// The camera changes every input frame. Keep the static world in one backing
// store so a pan produces one compositor update instead of one per visual layer.
function renderScene() {
  const canvas = sceneRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.setLineDash([]);
  context.clearRect(0, 0, screen.value.width, screen.value.height);
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
  if (gridType.value === "clean") return;

  if (gridType.value === "dots") {
    drawWorldDots(context, transform.value, screen.value, {
      size: 40,
      color: cssGridMajor,
      radius: 1.2,
      minScreenSpacing: 8,
    });
    return;
  }

  drawWorldGrid(context, transform.value, screen.value, {
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
    scale: transform.value.scale,
    dx: transform.value.dx,
    dy: transform.value.dy,
    t,
    chromeTextColor: cssChromeText,
    isEditingChrome: (id) => editingChromeId.value === id,
    chromePosition: elementChromePosition,
    chromeSize: elementChromeSize,
  };
  for (const shape of paintedShapes.value) {
    extensionManager.paint(shape.type)?.(context, shape, helpers);
  }
}

function renderRasterShapes(ctx: CanvasRenderingContext2D) {
  for (const shape of visibleRasterShapes.value) {
    extensionManager.get(shape.type).render.paintRaster?.(ctx, shape, {
      scale: transform.value.scale,
      dx: transform.value.dx,
      dy: transform.value.dy,
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
  const canvas = activeInkRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  renderCanvasInkOverlay({
    context,
    dpr,
    screen: screen.value,
    transform: transform.value,
    activeStroke: activeFreehandStroke,
    snapGuides: activeSnapGuides,
    defaultInkColor: defaultInkColor(),
  });
}

function renderSelections(refresh = false) {
  const canvas = selectionRef.value;
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
    screen: screen.value,
    transform: transform.value,
    selection: selectionSnapshot.value,
    refresh,
    deferRefresh: marqueeRect.value !== null,
  });
}

// Stroke transforms hide the selection outline while the selected ink is being
// replaced inside the raster cache. Camera movement keeps this layer visible
// and redraws it through renderInk with the current viewport transform.
function hideSelectionLayer() {
  const canvas = selectionRef.value;
  if (!canvas || selectionLayerHidden) return;
  canvas.style.visibility = "hidden";
  selectionLayerHidden = true;
}

function resize() {
  const rect = viewportRef.value?.getBoundingClientRect() ?? null;
  cachedViewportRect = rect;
  screen.value = {
    width: Math.max(1, Math.round(rect?.width ?? 1)),
    height: Math.max(1, Math.round(rect?.height ?? 1)),
  };
  dpr = window.devicePixelRatio || 1;
  const scene = sceneRef.value;
  if (scene) {
    scene.width = Math.round(screen.value.width * dpr);
    scene.height = Math.round(screen.value.height * dpr);
    scene.style.width = `${screen.value.width}px`;
    scene.style.height = `${screen.value.height}px`;
  }
  const activeInk = activeInkRef.value;
  if (activeInk) {
    activeInk.width = Math.round(screen.value.width * dpr);
    activeInk.height = Math.round(screen.value.height * dpr);
    activeInk.style.width = `${screen.value.width}px`;
    activeInk.style.height = `${screen.value.height}px`;
  }
  const selection = selectionRef.value;
  if (selection) {
    selection.width = Math.round(screen.value.width * dpr);
    selection.height = Math.round(screen.value.height * dpr);
    selection.style.width = `${screen.value.width}px`;
    selection.style.height = `${screen.value.height}px`;
  }
  renderInk();
}

function presenceState(): CanvasPresenceState {
  const cam = camera.value;
  // Use toRaw on reactive Sets/Maps to bypass per-element proxy overhead
  // when iterating — these are snapshot reads, not reactive dependencies.
  const rawIds = toRaw(selectedShapeIds.value);
  const rawStrokeIds = toRaw(selectedStrokeIds.value);
  const selectionIds: string[] = [];
  for (const id of rawIds) selectionIds.push(id);
  for (const id of rawStrokeIds) selectionIds.push(id);
  return {
    kind: "canvas",
    pointer: localPointer,
    cursorColor: cursorColor.value,
    view: { x: cam.centerX, y: cam.centerY, scale: cam.zoom },
    selectionIds,
    focusedNodeId: selectedShape.value?.id ?? null,
    activeTool: activeTool.value,
  };
}

function updatePresence() {
  emit("presence", [presenceState()]);
}

function insertionPointFromEvent(event?: DragEvent | PointerEvent) {
  if (event) return screenToWorld(screenPoint(event));
  if (localPointer) return localPointer;
  return screenToWorld({
    x: screen.value.width / 2,
    y: screen.value.height / 2,
  });
}

function setActiveEditorRef(instance: unknown) {
  activeEditorElement.value = (instance as HTMLElement | null) ?? null;
}

function stopActiveEdit() {
  const session = activeEditSession.value;
  if (!session) return;
  session.finish?.(activeEditorElement.value);
  activeEditSession.value = null;
  activeEditorElement.value = null;
}

// Insertion/engine services the tool extensions (draw/shape/create) drive.
const canvasToolContext: CanvasToolContext = {
  penColor: () => penColor.value,
  viewportScale: () => transform.value.scale,
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
    activeTool.value = tool;
  },
};

function insertCanvasStroke(stroke: CanvasStrokeSnapshot) {
  const completedStroke = toCanvasStroke(stroke.id, stroke);
  inkRenderer.commitAddedStroke(completedStroke, () => {
    yStrokes.set(stroke.id, createStrokeMap(stroke));
  });
}

function pointerGestureSample(event: PointerEvent) {
  const screen = screenPoint(event);
  return { event, screen, world: screenToWorld(screen) };
}

function pointerGestureEvent(event: PointerEvent): CanvasPointerGestureEvent {
  const coalesced = event.getCoalescedEvents?.() ?? [];
  return {
    ...pointerGestureSample(event),
    samples: (coalesced.length > 0 ? coalesced : [event]).map(pointerGestureSample),
  };
}

function releaseGesturePointer(gesture: ActiveToolPointerGesture) {
  const target = gesture.captureTarget;
  if (target?.hasPointerCapture(gesture.pointerId)) {
    target.releasePointerCapture(gesture.pointerId);
  }
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
    event.currentTarget instanceof HTMLElement ? event.currentTarget : viewportRef.value;
  const gesture: ActiveToolPointerGesture = {
    pointerId: event.pointerId,
    captureTarget,
    handlers,
  };
  activeToolPointerGesture = gesture;
  hoveredLockedElement.value = null;
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
  const shape = extension.creation?.create(at, { color: activeColors[type] });
  if (!shape) return;
  yShapes.set(shape.id, createShapeMap(shape));
  selectOnlyShape(shape.id);
  activeTool.value = "select";

  // Enter edit mode per the extension: a canvas-painted title overlay, or the
  // element's own rich-text editor.
  if (extension.creation?.editOnCreate === "chrome") {
    editElementChrome(shape);
  } else if (extension.creation?.editOnCreate === "element") {
    nextTick(() => {
      document
        .querySelector<HTMLElement>(`.canvas-shape[data-shape-id="${shape.id}"] > *`)
        ?.focus();
    });
  }
}

function getContainerContents(container: CanvasShape, includeImmovable = false) {
  const extension = extensionManager.get(container.type);
  return {
    shapes: shapes.value
      .filter(
        (shape) =>
          shape.id !== container.id &&
          (includeImmovable || canMoveShape(shape)) &&
          extension.behavior.container?.containsBounds(container, shapeAabb(shape)),
      )
      .map((shape) => ({ id: shape.id, x: shape.frame.x, y: shape.frame.y })),
    strokes: strokes.value
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
  const currentStroke = strokesById.value.get(id);
  if (currentStroke && !canMoveStroke(currentStroke)) return;
  stroke.set("updatedAt", Date.now());
  stroke.set("points", points.map(cloneFreehandPoint));
  if (rotation !== undefined) stroke.set("rotation", rotation);
}

// Sets the active swatch for a type and recolors the selected shape if it is
// that type. Generic over the registry's color-capable extensions.
function setElementColor(type: CanvasShapeType, color: string) {
  activeColors[type] = color;
  if (selectedShape.value?.type === type) {
    updateShapeStyle(selectedShape.value.id, { color });
  }
}

// The swatch to highlight: the selected shape's color when one of that type is
// selected, otherwise the active swatch for new shapes.
function activeElementColor(type: CanvasShapeType): string | undefined {
  return selectedShape.value?.type === type
    ? selectedShape.value.style.color
    : activeColors[type];
}

// Color pickers to show: the active tool's type, or the selected shape's type.
const visibleColorPalettes = computed(() =>
  colorPalettes.filter(
    (entry) =>
      activeTool.value === entry.type || selectedShape.value?.type === entry.type,
  ),
);

function pickShapeLibraryItem(item: CanvasShapeLibraryItem) {
  setActiveShapeId(item.id);
  activeTool.value = "shape";
  shapePopoverRef.value?.hide();
}

function setPenColor(color: string) {
  penColor.value = color;
  if (selectedStrokeIds.value.size === 0) return;

  ydoc.transact(() => {
    for (const id of selectedStrokeIds.value) {
      const stroke = yStrokes.get(id);
      if (!stroke) continue;
      const style = strokeStyleFromUnknown(stroke.get("style"));
      stroke.set("style", { ...style, color });
      stroke.set("updatedAt", Date.now());
    }
  });
}

function syncCursorColor(color = readCanvasCursorColor()) {
  cursorColor.value = color;
  updatePresence();
}

function handleCursorColorPreferenceChange(event: Event) {
  const color =
    event instanceof CustomEvent && typeof event.detail?.color === "string"
      ? event.detail.color
      : readCanvasCursorColor();
  syncCursorColor(color);
}

function handleStorageChange(event: StorageEvent) {
  if (event.key === CANVAS_CURSOR_COLOR_STORAGE_KEY) {
    syncCursorColor();
  }
}

function updateShapeFrame(id: string, patch: Partial<CanvasFrame>) {
  const shape = yShapes.get(id);
  if (!shape) return;
  const currentShape = shapesById.value.get(id);
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
  const currentShape = shapesById.value.get(id);
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
  if (selectedShapeIds.value.size === 0 && selectedStrokeIds.value.size === 0) return;
  const shapeIds = new Set(selectedShapeIds.value);
  const strokeIds = new Set(selectedStrokeIds.value);

  // A container cascades locking to every element currently
  // inside its bounds becomes locked with it. Include all contents, including
  // elements that are already locked or user-scoped to someone else.
  for (const id of selectedShapeIds.value) {
    const container = shapesById.value.get(id);
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
  const element = hoveredLockedElement.value;
  if (!element) return;
  if (element.type === "shape") setShapeLocked(element.id, false);
  else setStrokeLocked(element.id, false);
  hoveredLockedElement.value = null;
}

function deleteSelectedShape() {
  if (selectedShapeIds.value.size === 0 && selectedStrokeIds.value.size === 0) return;
  ydoc.transact(() => {
    for (const id of selectedShapeIds.value) {
      if (!isShapeLocked(id)) yShapes.delete(id);
    }
    for (const id of selectedStrokeIds.value) {
      if (!isStrokeLocked(id)) yStrokes.delete(id);
    }
  });
  selectedShapeIds.value = new Set();
  selectedStrokeIds.value = new Set();
}

// Snapshots the start positions of everything that should move with a shape
// drag: the whole current selection, plus the contents of any selected
// section. Strokes are deduped against section contents so a stroke that is
// both selected and inside a dragged section only moves once.
function buildShapeDragState(event: PointerEvent): Extract<DragState, { type: "shape" }> {
  const moveShapes = new Map<string, { id: string; x: number; y: number }>();
  const moveStrokes = new Map<string, { id: string; points: FreehandPoint[] }>();

  for (const id of selectedShapeIds.value) {
    const shape = shapesById.value.get(id);
    if (!shape || !canMoveShape(shape)) continue;
    moveShapes.set(shape.id, { id: shape.id, x: shape.frame.x, y: shape.frame.y });
    if (isContainerShape(shape)) {
      const contents = getContainerContents(shape);
      for (const s of contents.shapes) if (!moveShapes.has(s.id)) moveShapes.set(s.id, s);
      for (const s of contents.strokes)
        if (!moveStrokes.has(s.id)) moveStrokes.set(s.id, s);
    }
  }
  for (const id of selectedStrokeIds.value) {
    if (moveStrokes.has(id)) continue;
    const stroke = strokesById.value.get(id);
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
      const stroke = strokesById.value.get(item.id);
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
  if (!selectedShapeIds.value.has(shape.id)) {
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
    startCamera: camera.value,
  };
  isPanning.value = true;
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
    baseShapeIds: new Set(selectedShapeIds.value),
    baseStrokeIds: new Set(selectedStrokeIds.value),
  };
  marqueeRect.value = { x: start.x, y: start.y, width: 0, height: 0 };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

// Recomputes the selection from the marquee rectangle. Sections must be fully
// enclosed to be picked up (a marquee inside a big section selects its
// contents, not the section); every other shape selects on intersection.
function applyMarqueeSelection(
  state: Extract<DragState, { type: "marquee" }>,
  rect: Rect,
) {
  const topLeft = screenToWorld({ x: rect.x, y: rect.y });
  const bottomRight = screenToWorld({ x: rect.x + rect.width, y: rect.y + rect.height });
  const worldRect: Rect = {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };

  const shapeIds = new Set(state.additive ? state.baseShapeIds : []);
  for (const shape of shapes.value) {
    if (shape.locked) continue;
    const bounds = shapeAabb(shape);
    const hit = isContainerShape(shape)
      ? rectContains(worldRect, bounds)
      : rectsIntersect(worldRect, bounds);
    if (hit) shapeIds.add(shape.id);
  }

  const strokeIds = new Set(state.additive ? state.baseStrokeIds : []);
  for (const stroke of strokes.value) {
    if (stroke.locked) continue;
    if (stroke.points.some((point) => isPointInRect(point, worldRect))) {
      strokeIds.add(stroke.id);
    }
  }

  selectedShapeIds.value = shapeIds;
  selectedStrokeIds.value = strokeIds;
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
  for (let i = shapes.value.length - 1; i >= 0; i--) {
    const shape = shapes.value[i];
    if (!extensionManager.rasters(shape)) continue;
    if (
      extensionManager.get(shape.type).render.hitTest?.(shape, worldPoint, hitTestHelpers)
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
  for (let i = paintedShapes.value.length - 1; i >= 0; i--) {
    const shape = paintedShapes.value[i];
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
  editingChromeId.value = shape.id;
  renderScene();
  void nextTick(() => {
    viewportRef.value
      ?.querySelector<HTMLElement>(`[data-editor-shape-id="${shape.id}"]`)
      ?.focus();
  });
}

function finishChromeEditing() {
  if (!editingChromeId.value) return;
  editingChromeId.value = null;
  renderScene();
}

function isPointInRect(point: { x: number; y: number }, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function handleViewportPointerDown(event: PointerEvent) {
  if (event.pointerType === "touch" && !event.isPrimary) return;

  // Dismiss context menu on any tap outside of it (the menu itself stops
  // propagation with @pointerdown.stop so taps inside it don't reach here).
  if (contextMenuPos.value) {
    contextMenuPos.value = null;
    contextMenuInsertWorld = null;
    return;
  }

  // The handlers below call preventDefault(), which suppresses the browser's
  // default focus shift — so without this the canvas never holds focus and
  // copy/cut/paste events are never dispatched to it. Shape/text pointerdowns
  // use @pointerdown.stop, so this only fires for empty-canvas/stroke clicks
  // and won't pull focus out of a text shape being edited.
  viewportRef.value?.focus({ preventScroll: true });

  const point = screenPoint(event);
  localPointer = screenToWorld(point);

  if (event.button === 1 || event.button === 2) {
    startPan(event);
    event.preventDefault();
    return;
  }

  if (activeTool.value === "select") {
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
      } else if (!selectedShapeIds.value.has(hitImage.id)) {
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

    const hitStroke = hitTestCanvasStroke(
      strokes.value,
      worldPoint,
      transform.value.scale,
    );
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
      if (!selectedStrokeIds.value.has(hitStroke)) {
        selectStroke(hitStroke, false);
      }
      const stroke = strokesById.value.get(hitStroke);
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
    .tool(activeTool.value)
    ?.onPointerDown(screenToWorld(point), event, canvasToolContext);
  event.preventDefault();
}

function handleViewportDoubleClick(event: MouseEvent) {
  // A double-click is an empty-canvas shortcut for text. A section title is
  // the exception: it opens that title for editing.
  if (activeTool.value === "draw") return;

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
    hitTestCanvasStroke(strokes.value, worldPoint, transform.value.scale)
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
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const moved of drag.shapes) {
    const shape = shapesById.value.get(moved.id);
    if (!shape) continue;
    const bounds = shapeAabb({
      ...shape,
      frame: { ...shape.frame, x: moved.x, y: moved.y },
    });
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  for (const stroke of drag.strokes) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Nudges the raw drag offset so the dragged group's edges/centers snap to the
// edges/centers of the shapes it isn't moving, and records the active guides
// for rendering. Returns the (possibly adjusted) offset. Holding Cmd bypasses
// snapping entirely.
function snapDragOffset(
  drag: Extract<DragState, { type: "shape" }>,
  dx: number,
  dy: number,
  disabled: boolean,
): { dx: number; dy: number } {
  const startBounds = movingGroupBounds(drag);
  if (disabled || !startBounds) {
    activeSnapGuides = [];
    return { dx, dy };
  }

  // Only snap to shapes near the dragged group. A canvas can hold hundreds of
  // elements, so building guides for all of them (and matching against each)
  // every pointermove gets expensive — restrict to a proximity window around
  // the group's current position with a cheap rect test first.
  const margin = SNAP_PROXIMITY_PX / transform.value.scale;
  const near: Rect = {
    x: startBounds.x + dx - margin,
    y: startBounds.y + dy - margin,
    width: startBounds.width + margin * 2,
    height: startBounds.height + margin * 2,
  };
  const movingIds = new Set(drag.shapes.map((moved) => moved.id));
  const targets: SnapTarget[] = shapes.value
    .filter((shape) => !movingIds.has(shape.id) && rectsIntersect(near, shapeAabb(shape)))
    .map((shape) => ({ id: shape.id, bounds: shapeAabb(shape) }));

  const guides = computeSnapGuides({
    camera: camera.value,
    screen: screen.value,
    fit: FIT_REFERENCE,
    targets,
  });

  const snap = snapRectToGuides({
    guides,
    bounds: { ...startBounds, x: startBounds.x + dx, y: startBounds.y + dy },
    threshold: SNAP_THRESHOLD_PX / transform.value.scale,
  });

  activeSnapGuides = snap.guides;
  return { dx: dx + snap.dx, dy: dy + snap.dy };
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

  if (hasLockedStrokes.value) {
    const strokeId = hitTestCanvasStroke(
      strokes.value,
      worldPoint,
      transform.value.scale,
    );
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
  const current = hoveredLockedElement.value;
  if (current?.type === next?.type && current?.id === next?.id) return;
  hoveredLockedElement.value = next;
}

function handlePointerMove(event: PointerEvent) {
  const point = screenPoint(event);
  localPointer = screenToWorld(point);

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
    camera.value = panCameraByScreenDelta({
      camera: dragState.startCamera,
      screen: screen.value,
      fit: FIT_REFERENCE,
      dxPx: dragState.startPointer.x - event.clientX,
      dyPx: dragState.startPointer.y - event.clientY,
    });
    schedulePresenceUpdate();
    return;
  }

  if (dragState.type === "marquee") {
    const rect: Rect = {
      x: Math.min(dragState.startScreen.x, point.x),
      y: Math.min(dragState.startScreen.y, point.y),
      width: Math.abs(point.x - dragState.startScreen.x),
      height: Math.abs(point.y - dragState.startScreen.y),
    };
    marqueeRect.value = rect;
    applyMarqueeSelection(dragState, rect);
    schedulePresenceUpdate();
    return;
  }

  const world = screenToWorld(point);
  if (dragState.type === "resize") {
    const shape = shapesById.value.get(dragState.shapeId);
    if (!shape || !canMoveShape(shape)) return;
    const resized = resizeRotatedShapeFromBottomRight({
      fixedTopLeft: dragState.fixedTopLeft,
      pointer: world,
      rotation: dragState.initial.rotation,
      minSize: dragState.minSize,
      aspect: dragState.aspect,
    });
    if (dragState.resizeMode === "font") {
      // Text has no stored box; translate the drag into a proportional font
      // scale and let the node re-measure its own width/height. Top-left stays
      // put, so it grows toward the corner being dragged.
      const ratio =
        dragState.initial.width > 0 ? resized.width / dragState.initial.width : 1;
      const nextScale = clampFontScale((dragState.initialScale ?? 1) * ratio);
      updateShapeData(
        dragState.shapeId,
        {
          fontScale: Math.round(nextScale * 1000) / 1000,
        },
        { transform: true },
      );
      return;
    }
    updateShapeFrame(dragState.shapeId, {
      x: Math.round(resized.x),
      y: Math.round(resized.y),
      width: Math.round(resized.width),
      height: Math.round(resized.height),
    });
    return;
  }

  if (dragState.type === "rotate") {
    const shape = shapesById.value.get(dragState.shapeId);
    if (!shape || !canMoveShape(shape)) return;
    const rawRotation = rotationFromPointer(dragState.center, world);
    const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
    updateShapeFrame(dragState.shapeId, { rotation: Math.round(rotation * 10) / 10 });
    return;
  }

  if (dragState.type === "stroke-resize") {
    const stroke = strokesById.value.get(dragState.strokeId);
    if (!stroke || !canMoveStroke(stroke)) return;
    const resized = resizeRotatedShapeFromBottomRight({
      fixedTopLeft: dragState.fixedTopLeft,
      pointer: world,
      rotation: 0,
      minSize: { width: 32, height: 32 },
    });
    const scaleX = resized.width / dragState.startBounds.width;
    const scaleY = resized.height / dragState.startBounds.height;
    updateStrokeTransformInteraction([
      strokeFromTransformedPoints(
        stroke,
        dragState.initialPoints.map((point) => ({
          ...point,
          x: resized.x + (point.x - dragState.startBounds.x) * scaleX,
          y: resized.y + (point.y - dragState.startBounds.y) * scaleY,
        })),
      ),
    ]);
    return;
  }

  if (dragState.type === "stroke-rotate") {
    const stroke = strokesById.value.get(dragState.strokeId);
    if (!stroke || !canMoveStroke(stroke)) return;
    const rawRotation = rotationFromPointer(dragState.center, world);
    const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
    const delta = ((rotation - dragState.startRotation + 540) % 360) - 180;
    const normalizedRotation = normalizeRotation(dragState.initialRotation + delta);
    updateStrokeTransformInteraction([
      strokeFromTransformedPoints(
        stroke,
        dragState.initialPoints.map((point) => {
          const rotated = rotateVector(
            { x: point.x - dragState.center.x, y: point.y - dragState.center.y },
            delta,
          );
          return {
            ...point,
            x: dragState.center.x + rotated.x,
            y: dragState.center.y + rotated.y,
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
      transform.value.scale >
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
      const shape = shapesById.value.get(moved.id);
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

function commitStrokeTransformInteraction(state: DragState) {
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
    state.type === "shape"
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
      if (state.type === "shape") {
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
      if (state.type !== "stroke-resize" && state.type !== "stroke-rotate") return;
      const stroke = committedTransform.strokes[0];
      if (!stroke) return;
      updateStrokePoints(
        state.strokeId,
        stroke.points,
        state.type === "stroke-rotate" ? stroke.rotation : undefined,
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
      marqueeRect.value = null;
      renderSelections();
    }
    if (dragState.type === "pan") isPanning.value = false;
    if (activeSnapGuides.length > 0) {
      activeSnapGuides = [];
      renderInk();
    }
    dragState = null;
  }
}

function cancelTransformDrag() {
  if (dragState?.type === "resize" || dragState?.type === "rotate") {
    const shape = shapesById.value.get(dragState.shapeId);
    if (shape && canMoveShape(shape)) {
      updateShapeFrame(dragState.shapeId, dragState.initial);
    }
  } else if (dragState?.type === "stroke-resize" || dragState?.type === "stroke-rotate") {
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
    marqueeRect.value = null;
    renderSelections();
  }
  if (dragState.type === "pan") isPanning.value = false;
  cancelStrokeTransformInteraction();
  dragState = null;
  if (activeSnapGuides.length > 0) {
    activeSnapGuides = [];
    renderInk();
  }
}

function handlePointerLeave() {
  localPointer = null;
  hoveredLockedElement.value = null;
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
  routeExtensionInput("drop", event, event.dataTransfer, insertionPointFromEvent(event));
}

function selectContextMenuTarget(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Element) {
    const shapeElement = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
    const shapeId = shapeElement?.dataset.shapeId;
    if (shapeId) {
      if (isShapeLocked(shapeId)) clearSelection();
      else if (!selectedShapeIds.value.has(shapeId)) selectOnlyShape(shapeId);
      return;
    }
  }

  const worldPoint = screenToWorld(screenPoint(event));
  const image = hitTestRasterShape(worldPoint);
  if (image) {
    if (image.locked) clearSelection();
    else if (!selectedShapeIds.value.has(image.id)) selectOnlyShape(image.id);
    return;
  }

  const strokeId = hitTestCanvasStroke(strokes.value, worldPoint, transform.value.scale);
  if (strokeId) {
    if (isStrokeLocked(strokeId)) clearSelection();
    else if (!selectedStrokeIds.value.has(strokeId)) selectStroke(strokeId, false);
    return;
  }

  const paintedShape = hitTestPaintedShape(worldPoint)?.shape ?? null;
  if (paintedShape) {
    if (paintedShape.locked) clearSelection();
    else if (!selectedShapeIds.value.has(paintedShape.id))
      selectOnlyShape(paintedShape.id);
    return;
  }

  clearSelection();
}

function handleContextMenu(event: MouseEvent) {
  // Always prevent the native context menu / iOS callout.
  event.preventDefault();
  if (!viewportRef.value) return;

  // Don't open the menu when the draw tool is active.
  if (activeTool.value === "draw") return;

  dragState = null;
  isPanning.value = false;
  selectContextMenuTarget(event);
  const rect = viewportRef.value.getBoundingClientRect();
  const pos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  contextMenuInsertWorld = screenToWorld(pos);
  contextMenuPos.value = pos;
}

async function pasteFromContextMenu() {
  const insertAt = contextMenuInsertWorld ?? insertionPointFromEvent();
  contextMenuPos.value = null;
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
  } as DataTransfer;
  routeExtensionInput(
    "paste",
    { preventDefault: () => {} } as ClipboardEvent,
    data,
    insertAt,
  );
}

function uploadFromContextMenu() {
  const insertAt = contextMenuInsertWorld ?? insertionPointFromEvent();
  contextMenuPos.value = null;
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

async function readSystemClipboard() {
  const result = { canvasJson: "", html: "", text: "" };

  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read().catch(() => []);
    for (const item of items) {
      for (const type of item.types) {
        if (type === CANVAS_CLIPBOARD_MIME && !result.canvasJson) {
          result.canvasJson = await item
            .getType(type)
            .then((blob) => blob.text())
            .catch(() => "");
        }
        if (type === "text/html" && !result.html) {
          result.html = await item
            .getType(type)
            .then((blob) => blob.text())
            .catch(() => "");
        }
        if (type === "text/plain" && !result.text) {
          result.text = await item
            .getType(type)
            .then((blob) => blob.text())
            .catch(() => "");
        }
      }
    }
  }

  if (!result.text) {
    result.text = (await navigator.clipboard?.readText().catch(() => "")) ?? "";
  }

  return result;
}

function collectSelection(): {
  shapes: CanvasSerializedShape[];
  strokes: CanvasStrokeSnapshot[];
} {
  const selShapes = shapes.value
    .filter((shape) => selectedShapeIds.value.has(shape.id) && !shape.locked)
    .map(serializeShape);
  const selStrokes = strokes.value
    .filter((stroke) => selectedStrokeIds.value.has(stroke.id) && !stroke.locked)
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
function hasActiveTextSelection(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.closest("textarea, input, select, document-view")) return true;
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

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
        createShapeMap({
          ...shape,
          id,
          frame: {
            ...shape.frame,
            x: Math.round(shape.frame.x + dx),
            y: Math.round(shape.frame.y + dy),
          },
          // A pasted personal element belongs to the person who pasted it,
          // never the author of the source clipboard item.
          authorId: shape.authorId ? currentUserId.value : undefined,
          updatedAt: now,
        }),
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
          authorId: stroke.authorId ? currentUserId.value : undefined,
          updatedAt: now,
        }),
      );
    }
  });

  selectedShapeIds.value = pastedShapeIds;
  selectedStrokeIds.value = pastedStrokeIds;
  activeTool.value = "select";
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
        createShapeMap({
          ...shape,
          updatedAt: Date.now(),
        }),
      );
    }
  });

  selectedShapeIds.value = pastedShapeIds;
  selectedStrokeIds.value = new Set();
  activeTool.value = "select";
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
        pasteCanvasClipboard(value?.payload as CanvasClipboard, value?.at as CanvasPoint);
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

function isBrowserFindTarget(shape: CanvasShape): boolean {
  return shape.type === "text" || shape.type === "note";
}

function moveCameraToShape(shape: CanvasShape) {
  const bounds = shapeAabb(shape);
  const inset = reservedSidebarWidth();
  const scale = transform.value.scale;
  camera.value = {
    ...camera.value,
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
  const shape = shapeId ? shapesById.value.get(shapeId) : null;
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
    viewportRef.value?.scrollTo(0, 0);
  });
}

function fitView(maxZoom = 5) {
  const xs = [
    ...shapes.value.flatMap((shape) => {
      const bounds = shapeAabb(shape);
      return [bounds.x, bounds.x + bounds.width];
    }),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...shapes.value.flatMap((shape) => {
      const bounds = shapeAabb(shape);
      return [bounds.y, bounds.y + bounds.height];
    }),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.y)),
  ];

  const inset = reservedSidebarWidth();
  const baseScale = Math.min(
    screen.value.width / FIT_REFERENCE.width,
    screen.value.height / FIT_REFERENCE.height,
  );

  if (xs.length === 0 || ys.length === 0) {
    // Center the world origin within the visible region (right of the nav).
    camera.value = { centerX: -inset / (2 * baseScale), centerY: 0, zoom: 1 };
    return;
  }

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX + 160);
  const height = Math.max(1, maxY - minY + 160);
  // Fit the content into the visible width, not the full (occluded) viewport.
  const availableWidth = Math.max(1, screen.value.width - inset);
  const fitScale = Math.min(availableWidth / width, screen.value.height / height);
  const zoom = Math.max(0.25, Math.min(maxZoom, fitScale / baseScale));
  const appliedScale = baseScale * zoom;

  camera.value = {
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
  if (shapes.value.length === 0 && strokes.value.length === 0) return;
  hasFitInitialView = true;
  // Frame the content but never magnify past 100% on load.
  if (isInitialContent) fitView(1);
}

const canUndo = ref(false);
const canRedo = ref(false);
function refreshUndoState() {
  canUndo.value = undoManager.canUndo();
  canRedo.value = undoManager.canRedo();
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
  if (shortcutTool) activeTool.value = shortcutTool.id;
  if (key === "r") activeTool.value = "shape";
  if (key === "f") fitView();
}

watch(
  shapes,
  () => {
    renderScene();
    renderSelections();
  },
  { flush: "post" },
);

watch(selectedShapeIds, (ids) => {
  if (editingChromeId.value && (ids.size !== 1 || !ids.has(editingChromeId.value))) {
    finishChromeEditing();
  }
  renderSelections();
  updatePresence();
});

// Inline document editing ends as soon as the card leaves the (single)
// selection — clicking the canvas, selecting another shape, or deleting the
// card all funnel through here and tear the editor (and its presence) down.
watch(selectedShapeIds, (ids) => {
  const editing = activeEditSession.value;
  if (!editing) return;
  if (ids.size !== 1 || !ids.has(editing.shapeId)) {
    stopActiveEdit();
  }
});

watch(activeTool, (tool) => {
  if (tool !== "select") stopActiveEdit();
});

watch(shapes, () => {
  const editing = activeEditSession.value;
  if (editing && !shapesById.value.has(editing.shapeId)) {
    stopActiveEdit();
  }
  if (editingChromeId.value && !shapesById.value.has(editingChromeId.value)) {
    finishChromeEditing();
  }
});

watch(selectedStrokeIds, () => {
  renderSelections();
  updatePresence();
});

watch(remoteCanvasStrokeSelections, () => {
  renderSelections();
});

watch(remoteCanvasSelections, () => {
  renderSelections();
});

watch(
  () => documentData.value?.properties?.gridtype,
  (value) => applyGridType(value),
  { immediate: true },
);

const extensionPreparationKey = computed(() =>
  shapes.value
    .map((shape) => {
      const extension = extensionManager.get(shape.type);
      const key = extension.events?.prepare?.key(shape, extHost);
      return key ? `${shape.id}\u001e${key}` : null;
    })
    .filter((key): key is string => Boolean(key))
    .sort()
    .join("\u001f"),
);

// Moving a card changes updatedAt and refreshes the shapes array. Watch a
// stable key of the actual preview inputs instead, so those visual edits never
// cause preview work. The loaders themselves remain responsible for caching.
watch(
  extensionPreparationKey,
  () => {
    for (const shape of shapes.value) {
      extensionManager.get(shape.type).events?.prepare?.run(shape, extHost);
    }
  },
  { immediate: true },
);

watch(
  () => [
    camera.value.centerX,
    camera.value.centerY,
    camera.value.zoom,
    screen.value.width,
    screen.value.height,
  ],
  () => {
    renderInk();
    updatePresence();
  },
  { flush: "post" },
);

onMounted(() => {
  void import("#editor/document.ts");
  refreshCssVars();
  yShapes.observeDeep((_events, transaction) => {
    syncShapesFromY();
    // Persist only this client's own edits (local edits have origin null; undo/
    // redo carry the UndoManager origin). Remote changes are persisted by their
    // originator — the peer that made them, or the server for agent edits — so
    // re-saving them here would mean every client rewrites the doc on every
    // change, including the initial room state that arrives as "remote" on load.
    if (transaction.origin !== "remote" && transaction.origin !== "seed") scheduleSave();
    refreshUndoState();
    fitInitialViewIfNeeded(transaction.origin !== null);
  });
  yStrokes.observeDeep((_events, transaction) => {
    syncStrokesFromY();
    // Persist only this client's own edits (local edits have origin null; undo/
    // redo carry the UndoManager origin). Remote changes are persisted by their
    // originator — the peer that made them, or the server for agent edits — so
    // re-saving them here would mean every client rewrites the doc on every
    // change, including the initial room state that arrives as "remote" on load.
    if (transaction.origin !== "remote" && transaction.origin !== "seed") scheduleSave();
    refreshUndoState();
    fitInitialViewIfNeeded(transaction.origin !== null);
  });
  syncShapesFromY();
  syncStrokesFromY();
  resize();

  viewportControls = createViewportControls({
    target: viewportRef.value ?? window,
    getCamera: () => camera.value,
    setCamera: (nextCamera) => {
      camera.value = nextCamera;
    },
    getScreen: () => screen.value,
    getFit: () => FIT_REFERENCE,
    onTouchGestureStart: () => {
      cancelToolPointerGesture("touch-gesture");
      dragState = null;
      isPanning.value = false;
      renderInk();
    },
    onTwoFingerTap: undo,
    minZoom: 0.15,
    maxZoom: 10,
  });

  resizeObserver = new ResizeObserver(resize);
  if (viewportRef.value) resizeObserver.observe(viewportRef.value);

  updateThemeMode();
  themeObserver = new MutationObserver(updateThemeMode);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  colorSchemeMedia.addEventListener("change", updateThemeMode);

  syncCursorColor();
  window.addEventListener(
    CANVAS_CURSOR_COLOR_CHANGE_EVENT,
    handleCursorColorPreferenceChange,
  );
  window.addEventListener("storage", handleStorageChange);

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
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("copy", handleCopy);
  window.addEventListener("cut", handleCut);
  window.addEventListener("paste", handlePaste);
});

onUnmounted(() => {
  cancelToolPointerGesture("unmount");
  viewportControls?.dispose();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  colorSchemeMedia?.removeEventListener("change", updateThemeMode);
  emit("presence", []);
  undoManager.destroy();
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerCancel);
  window.removeEventListener("copy", handleCopy);
  window.removeEventListener("cut", handleCut);
  window.removeEventListener("paste", handlePaste);
  window.removeEventListener(
    CANVAS_CURSOR_COLOR_CHANGE_EVENT,
    handleCursorColorPreferenceChange,
  );
  window.removeEventListener("storage", handleStorageChange);
  if (saveTimer) clearTimeout(saveTimer);
  if (saveStateTimer) clearTimeout(saveStateTimer);
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
  if (inkRafId !== null) cancelAnimationFrame(inkRafId);
  if (presenceRafId !== null) cancelAnimationFrame(presenceRafId);
  inkRenderer.dispose();
  selectionRenderer.dispose();
});
</script>

<template>
  <div class="canvas-root" :class="{ 'is-dark': isDarkMode }">
    <div
      v-if="
        activeTool === 'draw' ||
        activeTool === 'note' ||
        activeTool === 'section' ||
        activeTool === 'shape' ||
        selectedStrokeIds.size > 0 ||
        selectedShape?.type === 'note' ||
        selectedShape?.type === 'section'
      "
      class="canvas-sub-toolbar"
      @pointerdown.stop
    >
      <span
        v-if="activeTool === 'draw'"
        class="canvas-draw-modes"
        :aria-label="t('Draw mode')"
      >
        <button
          v-for="mode in DRAW_STROKE_MODES"
          :key="mode.id"
          type="button"
          class="canvas-draw-mode"
          :class="{ active: activeDrawStrokeMode === mode.id }"
          :aria-label="t(mode.label)"
          :aria-pressed="activeDrawStrokeMode === mode.id"
          :title="t(mode.label)"
          @click="activeDrawStrokeMode = mode.id"
        >
          <div
            class="svg-icon canvas-draw-mode-icon"
            aria-hidden="true"
            v-html="mode.icon"
          />
        </button>
      </span>
      <span v-if="activeTool === 'draw'" class="canvas-divider"></span>
      <span
        v-for="cp in visibleColorPalettes"
        :key="cp.type"
        class="canvas-note-colors"
        :aria-label="`${t(cp.label)} color`"
      >
        <button
          v-for="color in cp.palette"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: activeElementColor(cp.type) === color }"
          :style="{ background: color }"
          :aria-label="`${t(cp.label)} color ${color}`"
          @click="setElementColor(cp.type, color)"
        ></button>
      </span>
      <span
        v-if="
          (activeTool === 'draw' || activeTool === 'shape' || selectedStrokeIds.size > 0) &&
          visibleColorPalettes.length > 0
        "
        class="canvas-divider"
      ></span>
      <span
        v-if="activeTool === 'draw' || activeTool === 'shape' || selectedStrokeIds.size > 0"
        class="canvas-note-colors"
        :aria-label="t('Pen color')"
      >
        <button
          v-for="color in PEN_COLORS"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: (selectedStrokeIds.size > 0 ? selectedStrokeColor : penColor) === color }"
          :style="{ background: color }"
          :aria-label="`${t('Set pen color')} ${color}`"
          @click="setPenColor(color)"
        ></button>
      </span>
    </div>
    <div class="canvas-toolbar" @pointerdown.stop>
      <button
        v-for="tool in CANVAS_TOOLS"
        :key="tool.id"
        type="button"
        class="canvas-tool"
        :class="{ active: activeTool === tool.id }"
        :aria-label="t(tool.label)"
        :aria-pressed="activeTool === tool.id"
        :data-tooltip="`${t(tool.label)} · ${tool.shortcut}`"
        @click="activeTool = tool.id"
      >
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="tool.icon" />
      </button>
      <a-popover-trigger ref="shapePopoverRef" class="canvas-shape-trigger">
        <button
          slot="trigger"
          type="button"
          class="canvas-tool"
          :class="{ active: activeTool === 'shape' }"
          :aria-label="t('Shape')"
          :aria-pressed="activeTool === 'shape'"
          :data-tooltip="`${t('Shape')} · R`"
        >
          <div
            class="svg-icon canvas-tool-icon"
            aria-hidden="true"
            v-html="canvasShapeIcon"
          />
        </button>
        <a-popover placements="top">
          <div class="canvas-shape-popover" @pointerdown.stop>
            <div class="canvas-shape-popover-panel">
              <button
                v-for="item in SHAPE_LIBRARY"
                :key="item.id"
                type="button"
                class="canvas-shape-option"
                :class="{ active: activeTool === 'shape' && activeShapeId === item.id }"
                :aria-label="t(item.label)"
                @click="pickShapeLibraryItem(item)"
              >
                <div
                  class="svg-icon canvas-shape-option-icon"
                  aria-hidden="true"
                  v-html="item.icon"
                />
                <span class="canvas-shape-option-label">{{ t(item.label) }}</span>
              </button>
            </div>
          </div>
        </a-popover>
      </a-popover-trigger>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Undo')"
        :data-tooltip="`${t('Undo')} · ⌘Z`"
        :disabled="!canUndo"
        @click="undo"
      >
        <div
          class="svg-icon canvas-tool-icon"
          aria-hidden="true"
          v-html="undoArrowIcon"
        />
      </button>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Redo')"
        :data-tooltip="`${t('Redo')} · ⌘⇧Z`"
        :disabled="!canRedo"
        @click="redo"
      >
        <div
          class="svg-icon canvas-tool-icon"
          aria-hidden="true"
          v-html="redoArrowIcon"
        />
      </button>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Fit to view')"
        :data-tooltip="`${t('Fit to view')} · F`"
        @click="fitView()"
      >
        <div
          class="svg-icon canvas-tool-icon"
          aria-hidden="true"
          v-html="canvasFitViewIcon"
        />
      </button>
    </div>

    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <div
      ref="viewportRef"
      class="canvas-viewport"
      tabindex="-1"
      :style="{ cursor: viewportCursor }"
      @contextmenu="handleContextMenu"
      @pointerdown="handleViewportPointerDown"
      @pointercancel="handlePointerCancel"
      @pointerleave="handlePointerLeave"
      @dblclick="handleViewportDoubleClick"
      @dragover="handleDragOver"
      @drop="handleDrop"
    >
      <canvas ref="sceneRef" class="canvas-scene"></canvas>
      <canvas ref="activeInkRef" class="canvas-active-ink"></canvas>
      <canvas ref="selectionRef" class="canvas-selection"></canvas>
      <div
        class="canvas-world"
        :style="{
          transform: `translate(${transform.dx}px, ${transform.dy}px) scale(${transform.scale})`,
        }"
        @beforematch="handleBrowserFindMatch"
      >
        <article
          v-for="shape in domShapes"
          :key="shape.id"
          class="canvas-shape"
          :class="[
            shape.type,
            { selected: selectedShapeIds.has(shape.id) },
          ]"
          :style="articleStyle(shape)"
          :data-shape-id="shape.id"
          :hidden.attr="isBrowserFindTarget(shape) ? 'until-found' : undefined"
        >
          <!-- Extension-owned custom element (note, text, …). Falls back to the
               inline branches below for types not yet migrated. -->
          <component
            :is="elementTagForShape(shape)"
            v-if="elementTagForShape(shape)"
            :shape.prop="shape"
            :context.prop="hostContext"
            :data.prop="elementDataForShape(shape)"
            @request-drag="startShapeDrag(shape, ($event as CustomEvent).detail)"
            @document-click="onElementActivate(shape, ($event as CustomEvent).detail)"
            @open-document="onElementOpen(shape, $event)"
          />
          <!-- elementTagForShape returns null only while a card is being edited
               inline: the host swaps in its own inline editor, which depends on
               host editing state (save/exit orchestration) the element can't
               carry. The editing slot is keyed by shape id and only ever set for
               a document, so no type check is needed here. -->
          <component
            :is="activeEditSession?.tag"
            v-else-if="activeEditSession?.shapeId === shape.id"
            :ref="setActiveEditorRef"
            :class="activeEditSession?.className"
            v-bind="activeEditSession.props"
            @drag-start="startShapeDrag(shape, ($event as CustomEvent).detail[0])"
            @exit-edit="stopActiveEdit"
          />
        </article>

        <!-- Local upload placeholders shown until each dropped/pasted file finishes uploading. -->
        <div
          v-for="placeholder in uploadPlaceholders"
          :key="placeholder.id"
          class="canvas-upload-placeholder"
          :style="{
            left: `${placeholder.x}px`,
            top: `${placeholder.y}px`,
            width: `${placeholder.width}px`,
            height: `${placeholder.height}px`,
          }"
        >
          <div class="canvas-upload-spinner" aria-hidden="true"></div>
          <div class="canvas-upload-name">{{ placeholder.filename }}</div>
        </div>
      </div>

      <div
        v-if="editingChromeShape"
        class="canvas-section-title-overlay"
        :style="{
          left: `${elementChromePosition(editingChromeShape).x}px`,
          top: `${elementChromePosition(editingChromeShape).y}px`,
          width: `${Math.max(1, editingChromeShape.frame.width * transform.scale)}px`,
          transform: `rotate(${editingChromeShape.frame.rotation}deg)`,
          '--canvas-section-color': editingChromeShape.style.color,
        }"
        @pointerdown.stop
      >
        <component
          :is="editorTagForShape(editingChromeShape)"
          :data-editor-shape-id="editingChromeShape.id"
          :shape.prop="editingChromeShape"
          :context.prop="hostContext"
          @finish-edit="finishChromeEditing"
        />
      </div>

      <div v-if="selectedTransformShape" class="canvas-transform-controls">
        <button
          type="button"
          class="canvas-transform-handle canvas-rotate-handle"
          :aria-label="`${t('Rotate')} ${selectedTransformShape.type}`"
          :style="{
            left: `${transformControlPositions(selectedTransformShape).rotation.x}px`,
            top: `${transformControlPositions(selectedTransformShape).rotation.y}px`,
          }"
          @pointerdown.stop="startShapeRotation(selectedTransformShape, $event)"
        >
          ↻
        </button>
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} ${selectedTransformShape.type}`"
          :style="{
            left: `${transformControlPositions(selectedTransformShape).resize.x}px`,
            top: `${transformControlPositions(selectedTransformShape).resize.y}px`,
            transform: `translate(-50%, -50%) rotate(${selectedTransformShape.frame.rotation}deg)`,
          }"
          @pointerdown.stop="startShapeResize(selectedTransformShape, $event)"
        ></button>
      </div>
      <div v-if="selectedResizeOnlyShape" class="canvas-transform-controls">
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} ${selectedResizeOnlyShape.type}`"
          :style="{
            left: `${transformControlPositions(selectedResizeOnlyShape).resize.x}px`,
            top: `${transformControlPositions(selectedResizeOnlyShape).resize.y}px`,
            transform: `translate(-50%, -50%) rotate(${selectedResizeOnlyShape.frame.rotation}deg)`,
          }"
          @pointerdown.stop="startShapeResize(selectedResizeOnlyShape, $event)"
        ></button>
      </div>
      <div
        v-if="selectedBasicShapeStroke && selectedBasicShapeStrokeControls"
        class="canvas-transform-controls"
      >
        <button
          type="button"
          class="canvas-transform-handle canvas-rotate-handle"
          :aria-label="`${t('Rotate')} ${t('Shape')}`"
          :style="{
            left: `${selectedBasicShapeStrokeControls.rotation.x}px`,
            top: `${selectedBasicShapeStrokeControls.rotation.y}px`,
          }"
          @pointerdown.stop="startStrokeRotation(selectedBasicShapeStroke, $event)"
        >
          ↻
        </button>
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} ${t('Shape')}`"
          :style="{
            left: `${selectedBasicShapeStrokeControls.resize.x}px`,
            top: `${selectedBasicShapeStrokeControls.resize.y}px`,
            transform: `translate(-50%, -50%) rotate(${selectedBasicShapeStroke.rotation || 0}deg)`,
          }"
          @pointerdown.stop="startStrokeResize(selectedBasicShapeStroke, $event)"
        ></button>
      </div>

      <button
        v-if="hoveredLockedElementPosition"
        type="button"
        class="canvas-unlock-button"
        :aria-label="t('Unlock')"
        :data-tooltip="t('Unlock')"
        :style="{
          transform: `translate(${hoveredLockedElementPosition.x}px, ${hoveredLockedElementPosition.y}px) translate(-50%, -50%)`,
        }"
        @pointerdown.stop
        @click.stop="unlockHoveredElement"
      >
        <div class="svg-icon" aria-hidden="true" v-html="unlockIcon" />
      </button>

      <div
        v-for="presence in remoteCanvasPointerPresences"
        :key="presence.clientId"
        class="canvas-presence"
        :class="{ 'is-instant': isCameraMoving }"
        :style="{
          transform: `translate(${worldToScreen(presence.state!.pointer!).x}px, ${worldToScreen(presence.state!.pointer!).y}px)`,
          '--presence-color':
            presence.state!.cursorColor ||
            presence.user.color ||
            getPresenceColor(presence.user.id),
        }"
      >
        <svg
          class="canvas-presence-cursor"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4.5 4.2a.6.6 0 0 1 .77-.77l13.2 5.36a.6.6 0 0 1-.07 1.13l-5.05 1.3a1.6 1.6 0 0 0-1.15 1.15l-1.3 5.05a.6.6 0 0 1-1.13.07z"
            fill="var(--presence-color)"
            stroke="#fff"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
        <span class="canvas-presence-label">{{ presence.user.name }}</span>
      </div>

      <div
        v-if="marqueeRect"
        class="canvas-marquee"
        :style="{
          left: `${marqueeRect.x}px`,
          top: `${marqueeRect.y}px`,
          width: `${marqueeRect.width}px`,
          height: `${marqueeRect.height}px`,
        }"
      ></div>

      <div
        v-if="contextMenuPos"
        class="canvas-context-menu"
        :style="{
          transform: `translate(${contextMenuPos.x}px, ${contextMenuPos.y}px)`,
        }"
        @pointerdown.stop
      >
        <template v-if="selectedShapeIds.size > 0 || selectedStrokeIds.size > 0">
          <button
            type="button"
            class="canvas-tool"
            :aria-label="t('Lock')"
            @click="lockSelectedElements(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="lockIcon" />
          </button>
          <span class="canvas-divider"></span>
          <button
            type="button"
            class="canvas-tool"
            :aria-label="t('Copy')"
            @click="copySelectionToClipboard(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="copyIcon" />
          </button>
          <button
            type="button"
            class="canvas-tool"
            :aria-label="t('Cut')"
            @click="cutSelectionToClipboard(); contextMenuPos = null"
          >
            <div
              class="svg-icon canvas-tool-icon"
              aria-hidden="true"
              v-html="scissorsIcon"
            />
          </button>
          <span class="canvas-divider"></span>
        </template>
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Paste')"
          @click="pasteFromContextMenu"
        >
          <div
            class="svg-icon canvas-tool-icon"
            aria-hidden="true"
            v-html="clipboardDocumentIcon"
          />
        </button>
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Upload file')"
          @click="uploadFromContextMenu"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="uploadIcon" />
        </button>
        <template v-if="selectedShapeIds.size > 0 || selectedStrokeIds.size > 0">
          <span class="canvas-divider"></span>
          <button
            type="button"
            class="canvas-tool danger"
            :aria-label="t('Delete')"
            @click="deleteSelectedShape(); contextMenuPos = null"
          >
            <div
              class="svg-icon canvas-tool-icon"
              aria-hidden="true"
              v-html="trashIcon"
            />
          </button>
        </template>
      </div>
    </div>

    <document-toolbar ref="canvasToolbarRef" variant="canvas" standalone />
  </div>
</template>

<!--
  Not scoped: element bodies (note handle, audio grip, link/pdf/document cards,
  …) are built imperatively inside the canvas-* custom elements, so they don't
  carry Vue's scope attribute and scoped rules would never match them. Every
  selector here is .canvas-* prefixed and canvas-specific, so global scope is
  safe. (Future cleanup: extract the element-body rules to a stylesheet
  co-located with the element modules.)
-->
<style>
.canvas-root {
  --canvas-bg: var(--color-neutral-50);
  --canvas-text: var(--color-neutral-900);
  --canvas-muted: #6b7280;
  --canvas-strong: #374151;
  --canvas-toolbar-bg: rgba(255, 255, 255, 0.94);
  --canvas-toolbar-border: #d1d5db;
  --canvas-toolbar-shadow: rgba(15, 23, 42, 0.14);
  --canvas-tool-text: #374151;
  --canvas-tool-hover-bg: #f3f4f6;
  --canvas-tool-active-bg: #dbeafe;
  --canvas-tool-active-border: #bfdbfe;
  --canvas-tool-active-text: #1d4ed8;
  --canvas-divider-color: #e5e7eb;
  --canvas-grid-minor: rgba(15, 23, 42, 0.07);
  --canvas-grid-major: rgba(15, 23, 42, 0.13);
  --canvas-ink-color: #111827;
  --canvas-shape-border: rgba(15, 23, 42, 0.14);
  --canvas-shape-shadow: rgba(15, 23, 42, 0.12);
  --canvas-handle-bg: rgba(15, 23, 42, 0.08);
  --canvas-section-bg: rgba(219, 234, 254, 0.08);
  --canvas-section-border: rgba(37, 99, 235, 0.55);
  --canvas-section-title-bg: #eff6ff;
  --canvas-section-title-focus-bg: #ffffff;
  --canvas-section-title-border: rgba(37, 99, 235, 0.28);
  --canvas-section-title-text: #1e3a8a;
  --canvas-image-bg: #ffffff;
  --canvas-doc-bg: #ffffff;
  --canvas-doc-accent: #2563eb;
  --canvas-doc-divider: #e5e7eb;
  --canvas-doc-content: #374151;
  --canvas-link-bg: #ffffff;
  --canvas-link-border: rgba(15, 23, 42, 0.14);
  --canvas-link-title: #111827;
  --canvas-link-domain: #6b7280;
  --canvas-link-desc: #6b7280;
  --canvas-resize-border: rgba(15, 23, 42, 0.45);
  --canvas-presence-text: #111827;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--canvas-bg);
  color: var(--canvas-text);
}

@media (prefers-color-scheme: dark) {
  .canvas-root {
    --canvas-muted: #9ca3af;
    --canvas-strong: #e5e7eb;
    --canvas-toolbar-bg: rgba(24, 24, 27, 0.94);
    --canvas-toolbar-border: rgba(255, 255, 255, 0.12);
    --canvas-toolbar-shadow: rgba(0, 0, 0, 0.38);
    --canvas-tool-text: #d1d5db;
    --canvas-tool-hover-bg: rgba(255, 255, 255, 0.08);
    --canvas-tool-active-bg: rgba(37, 99, 235, 0.26);
    --canvas-tool-active-border: rgba(96, 165, 250, 0.48);
    --canvas-tool-active-text: #bfdbfe;
    --canvas-divider-color: rgba(255, 255, 255, 0.12);
    --canvas-grid-minor: rgba(255, 255, 255, 0.07);
    --canvas-grid-major: rgba(255, 255, 255, 0.13);
    --canvas-ink-color: #f3f4f6;
    --canvas-shape-border: rgba(255, 255, 255, 0.16);
    --canvas-shape-shadow: rgba(0, 0, 0, 0.32);
    --canvas-handle-bg: rgba(255, 255, 255, 0.12);
    --canvas-section-bg: rgba(96, 165, 250, 0.09);
    --canvas-section-border: rgba(147, 197, 253, 0.62);
    --canvas-section-title-bg: #172033;
    --canvas-section-title-focus-bg: #111827;
    --canvas-section-title-border: rgba(147, 197, 253, 0.36);
    --canvas-section-title-text: #dbeafe;
    --canvas-image-bg: #111827;
    --canvas-doc-bg: #1a1d24;
    --canvas-doc-accent: #93c5fd;
    --canvas-doc-divider: rgba(255, 255, 255, 0.1);
    --canvas-doc-content: #d1d5db;
    --canvas-link-bg: #1a1d24;
    --canvas-link-border: rgba(255, 255, 255, 0.12);
    --canvas-link-title: #f3f4f6;
    --canvas-link-domain: #9ca3af;
    --canvas-link-desc: #9ca3af;
    --canvas-resize-border: rgba(255, 255, 255, 0.58);
    --canvas-presence-text: #111827;
  }
}

.canvas-toolbar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: calc(100% - 24px);
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 12px;
  background: var(--canvas-toolbar-bg);
  padding: 6px;
  box-shadow: 0 10px 28px var(--canvas-toolbar-shadow);
  backdrop-filter: blur(8px);
}

.canvas-sub-toolbar {
  position: absolute;
  bottom: 74px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 11;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 12px;
  background: var(--canvas-toolbar-bg);
  padding: 6px;
  box-shadow: 0 8px 22px var(--canvas-toolbar-shadow);
  backdrop-filter: blur(8px);
}

.canvas-tool {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  padding: 0;
  color: var(--canvas-tool-text);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.canvas-tool:disabled {
  opacity: 0.35;
  cursor: default;
}

.canvas-tool-icon {
  width: 20px;
  height: 20px;
}

.canvas-tool:hover:not(:disabled) {
  background: var(--canvas-tool-hover-bg);
  color: var(--canvas-text);
}

.canvas-tool.active,
.canvas-tool.primary {
  border-color: var(--canvas-tool-active-border);
  background: var(--canvas-tool-active-bg);
  color: var(--canvas-tool-active-text);
}

.canvas-tool.danger {
  color: #b91c1c;
}

.canvas-tool:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.canvas-divider {
  width: 1px;
  height: 24px;
  background: var(--canvas-divider-color);
}

.canvas-shape-trigger {
  display: inline-flex;
}

/* The popover content is portaled to the document root, outside .canvas-root,
   so it cannot use the --canvas-* variables and carries its own colors. */
.canvas-shape-popover {
  width: max-content;
  padding-bottom: 8px;
  transition: opacity 0.12s ease;
}

.canvas-shape-popover-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
  border: 1px solid #d1d5db;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.94);
  padding: 6px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
  backdrop-filter: blur(8px);
}

.canvas-shape-option {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  padding: 7px 10px;
  color: #374151;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.canvas-shape-option:hover {
  background: #f3f4f6;
}

.canvas-shape-option.active {
  border-color: #bfdbfe;
  background: #dbeafe;
  color: #1d4ed8;
}

.canvas-shape-option-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

@media (prefers-color-scheme: dark) {
  .canvas-shape-popover-panel {
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(24, 24, 27, 0.94);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
  }

  .canvas-shape-option {
    color: #d1d5db;
  }

  .canvas-shape-option:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .canvas-shape-option.active {
    border-color: rgba(96, 165, 250, 0.48);
    background: rgba(37, 99, 235, 0.26);
    color: #bfdbfe;
  }
}

.canvas-unlock-button {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 9;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 999px;
  background: var(--canvas-toolbar-bg);
  padding: 0;
  color: var(--canvas-tool-text);
  box-shadow: 0 3px 10px var(--canvas-toolbar-shadow);
  cursor: pointer;
}

.canvas-unlock-button .svg-icon {
  width: 15px;
  height: 15px;
}

.canvas-unlock-button:hover {
  background: var(--canvas-tool-hover-bg);
  color: var(--canvas-text);
}

.canvas-unlock-button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.canvas-context-menu {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 10px;
  background: var(--canvas-toolbar-bg);
  padding: 4px;
  box-shadow: 0 6px 18px var(--canvas-toolbar-shadow);
  backdrop-filter: blur(8px);
  pointer-events: auto;
  will-change: transform;
  /* Offset slightly below and to the right of the long-press point. */
  translate: 8px 8px;
}

.canvas-note-colors {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: 2px;
}

.canvas-draw-modes {
  display: flex;
  align-items: center;
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 8px;
  padding: 2px;
}

.canvas-draw-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 0;
  color: var(--canvas-tool-text);
  cursor: pointer;
}

.canvas-draw-mode-icon {
  width: 18px;
  height: 18px;
}

.canvas-draw-mode:hover {
  background: var(--canvas-tool-hover-bg);
  color: var(--canvas-text);
}

.canvas-draw-mode.active {
  background: var(--canvas-tool-active-bg);
  color: var(--canvas-tool-active-text);
}

.canvas-color-swatch {
  width: 22px;
  height: 22px;
  border: 1px solid rgba(15, 23, 42, 0.18);
  border-radius: 999px;
  cursor: pointer;
}

.canvas-color-swatch.active {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}

.canvas-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background-color: var(--canvas-bg);
  touch-action: none;
  /* Prevent iOS long-press from selecting text in shape DOM nodes while drawing. */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  /* Focusable (tabindex) so the browser dispatches clipboard events here, but
     it's not a control — suppress the focus ring. */
  outline: none;
}

/* Re-enable text selection inside editable shape content. */
.canvas-section-title {
  -webkit-user-select: text;
  user-select: text;
}

.canvas-world {
  position: absolute;
  inset: 0;
  z-index: 4;
  transform-origin: 0 0;
}

.canvas-scene,
.canvas-active-ink,
.canvas-selection {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}

.canvas-scene {
  z-index: 0;
}

.canvas-active-ink {
  z-index: 3;
}

/* All local and remote selection outlines share this screen-space overlay.
   It sits above the transformed DOM world while remaining interaction-transparent. */
.canvas-selection {
  z-index: 5;
}

.canvas-shape {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--canvas-shape-border);
  border-radius: 8px;
  content-visibility: auto;
  transform-origin: center;
}

.canvas-upload-placeholder {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--canvas-shape-border);
  border-radius: 8px;
  background: var(--canvas-image-bg);
  color: var(--color-text-secondary, #6b7280);
  pointer-events: none;
}

.canvas-upload-spinner {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2.5px solid var(--canvas-shape-border);
  border-top-color: var(--color-accent, #3b82f6);
  animation: canvas-upload-spin 0.7s linear infinite;
}

.canvas-upload-name {
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.2;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes canvas-upload-spin {
  to {
    transform: rotate(360deg);
  }
}

.canvas-shape.text {
  width: max-content;
  max-width: none;
  min-width: 32px;
  min-height: 40px;
  border-color: transparent;
  background: transparent !important;
  box-shadow: none;
}

.canvas-shape.image {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.canvas-shape.video {
  border-color: transparent;
  background: var(--canvas-image-bg);
}

.canvas-shape.file {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.canvas-shape.image .canvas-shape-image,
.canvas-shape.video .canvas-shape-image,
.canvas-shape.file .canvas-shape-file {
  cursor: move;
}

.canvas-shape.image .canvas-shape-image {
  width: 100%;
  height: 100%;
  background: transparent;
}

.canvas-shape-file {
  width: 100%;
  height: 100%;
  max-width: none;
  margin: 0;
}

.canvas-shape.audio {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.canvas-shape-audio {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--canvas-doc-divider, #e5e7eb);
  border-radius: var(--radius-md);
  background: var(--canvas-toolbar-bg, #fff);
  box-shadow: 0 1px 3px rgb(15 23 42 / 12%);
}

.canvas-shape-audio-handle {
  flex: 0 0 auto;
  width: 16px;
  height: 100%;
  cursor: move;
  background-image: radial-gradient(currentcolor 1px, transparent 1px);
  background-position: center;
  background-size: 4px 4px;
  color: var(--canvas-text-muted, #9ca3af);
  opacity: 0.6;
}

.canvas-shape-audio-player {
  width: 100%;
  min-width: 0;
  height: 40px;
  flex: 1 1 auto;
}

.canvas-pdf-preview {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--canvas-doc-divider, #e5e7eb);
  border-radius: var(--radius-md);
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 12%);
}

.canvas-pdf-preview-header {
  min-width: 0;
  padding: 7px 10px;
  overflow: hidden;
  border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
  background: #f8fafc;
  color: var(--canvas-text, #111827);
  cursor: move;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-pdf-preview-frame {
  display: block;
  width: 100%;
  min-height: 0;
  flex: 1;
  border: 0;
  background: #fff;
}

.canvas-shape-handle {
  height: 18px;
  flex: 0 0 auto;
  cursor: move;
  background: var(--canvas-handle-bg);
}

.canvas-shape.document {
  background: var(--canvas-doc-bg) !important;
  cursor: move;
}

.canvas-shape-document {
  width: 100%;
  height: 100%;
  cursor: move;
}

.canvas-shape-document-editor {
  width: 100%;
  height: 100%;
}

/* Body of the <canvas-document-editor> custom element (was the scoped styles of
   CanvasDocumentEditor.vue). Descendant-scoped under .canvas-doc-editor so the
   generic child class names don't leak now that the block is global. */
.canvas-doc-editor {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  cursor: auto;
  color: var(--canvas-text, #111827);
  font: inherit;
}

.canvas-doc-editor .editor-header {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
  padding: 10px 12px;
  cursor: move;
}

.canvas-doc-editor .icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--canvas-doc-accent, #2563eb);
}

.canvas-doc-editor .title-wrap {
  min-width: 0;
  flex: 1 1 auto;
}

.canvas-doc-editor .title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
}

.canvas-doc-editor .done {
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  background: var(--canvas-doc-accent, #2563eb);
  padding: 4px 10px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}

.canvas-doc-editor .editor-header-image-frame {
  display: flex;
  width: 100%;
  aspect-ratio: 16 / 9;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
  background: var(--canvas-tool-hover-bg, #f3f4f6);
}

.canvas-doc-editor .editor-header-image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.canvas-doc-editor .editor-body {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 12px 14px 16px;
  scrollbar-width: thin;
}

.canvas-doc-editor .editor-body document-view {
  display: block;
  min-width: 0;
}

.canvas-doc-editor .editor-hint {
  margin: 0;
  color: var(--canvas-muted, #6b7280);
  font-size: 13px;
  line-height: 1.4;
}

.canvas-shape.link {
  background: var(--canvas-link-bg) !important;
  cursor: move;
}

.canvas-shape-link {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: auto;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  cursor: move;
}

.canvas-twitter-shape {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--canvas-link-bg);
  cursor: move;
}

/* Container built inside the <canvas-twitter-embed> custom element. */
.canvas-twitter-embed {
  display: flex;
  width: 100%;
  height: 100%;
  justify-content: center;
  overflow: hidden;
}

.canvas-link-image {
  flex: none;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--canvas-handle-bg);
}

.canvas-link-image img,
.canvas-link-image video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.canvas-link-body {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  min-height: 0;
  overflow: hidden;
}

.canvas-link-site {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.canvas-link-favicon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  object-fit: contain;
}

.canvas-link-domain {
  font-size: 11px;
  color: var(--canvas-link-domain);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.canvas-link-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--canvas-link-title);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.canvas-link-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--canvas-link-desc);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.canvas-section-title-overlay {
  position: absolute;
  z-index: 6;
  display: flex;
  cursor: move;
  pointer-events: auto;
  transform-origin: 0 0;
}

.canvas-section-title {
  box-sizing: border-box;
  field-sizing: content;
  max-width: 100%;
  border: 1px solid
    color-mix(in srgb, var(--canvas-section-color, #60a5fa) 48%, transparent);
  border-radius: 6px;
  background: color-mix(
    in srgb,
    var(--canvas-section-color, #60a5fa) 10%,
    var(--canvas-toolbar-bg)
  );
  padding: 3px 8px;
  color: var(--canvas-text);
  font: inherit;
  font-size: 13px;
  font-weight: 750;
  line-height: 1.2;
  outline: none;
}

.canvas-section-title:focus {
  border-color: var(--canvas-section-color, #60a5fa);
  background: var(--canvas-toolbar-bg);
}

.canvas-shape-image {
  display: block;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  object-fit: contain;
  background: var(--canvas-image-bg);
  user-select: none;
}

.canvas-shape-textwrap {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  --editor-padding: 0.25rem;
  color: var(--canvas-text);
  font-size: 15px;
  line-height: 1.35;
}

/* Text shapes auto-size to their content via TipTap's natural height. */
.canvas-shape.text .canvas-shape-textwrap {
  display: block;
  width: max-content;
  max-width: none;
  cursor: move;
  font-size: var(--canvas-text-font-size, 15px);
  --editor-white-space: pre-wrap;
  --editor-word-break: normal;
  --editor-overflow-wrap: normal;
}

.canvas-shape.note .canvas-shape-textwrap {
  color: #111827;
}

.canvas-transform-controls {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
}

.canvas-transform-handle {
  position: absolute;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--canvas-resize-border);
  cursor: nwse-resize;
  font-size: 20px;
  font-weight: 500;
  line-height: 1;
  text-shadow: 0 1px 2px var(--canvas-toolbar-shadow);
  pointer-events: auto;
  transform: translate(-50%, -50%);
}

.canvas-transform-handle:hover {
  color: #1d4ed8;
}

.canvas-transform-handle:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.canvas-rotate-handle {
  cursor: grab;
  font-size: 21px;
}

.canvas-rotate-handle:active {
  cursor: grabbing;
}

.canvas-resize-handle::before {
  position: absolute;
  top: 5px;
  left: 5px;
  width: 9px;
  height: 9px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  content: "";
}

.canvas-marquee {
  position: absolute;
  z-index: 7;
  border: 1px solid #2563eb;
  border-radius: 2px;
  background: rgba(37, 99, 235, 0.1);
  pointer-events: none;
}

.canvas-presence {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 8;
  pointer-events: none;
  transition: transform 120ms linear;
}

.canvas-presence.is-instant {
  transition: none;
}

.canvas-presence-cursor {
  position: absolute;
  left: -3px;
  top: -2px;
  filter: drop-shadow(0 1px 1.5px rgba(15, 23, 42, 0.3));
}

.canvas-presence-label {
  position: absolute;
  left: 14px;
  top: 16px;
  border-radius: 4px;
  background: var(--presence-color);
  padding: 3px 6px;
  color: var(--canvas-presence-text);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
</style>
