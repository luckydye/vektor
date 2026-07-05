<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  toRaw,
  watch,
} from "vue";
import * as Y from "yjs";
import {
  canvasFitViewIcon,
  canvasNoteIcon,
  canvasSectionIcon,
  canvasSelectIcon,
  canvasShapeIcon,
  canvasTextIcon,
  clipboardDocumentIcon,
  copyIcon,
  pencilIcon,
  redoArrowIcon,
  scissorsIcon,
  trashIcon,
  undoArrowIcon,
} from "~/src/assets/icons.ts";
import { api } from "../api/client.ts";
import {
  createDocumentLinkController,
  dragHasDocumentLink,
  droppedDocumentId as getDroppedDocumentId,
} from "../canvas/elements/documentLink.ts";
import {
  addCanvasDrawingPoint,
  type CanvasDrawingSession,
  cloneFreehandPoint,
  createStrokeMap,
  DRAW_STROKE_MODES,
  type DrawStrokeMode,
  FREEHAND_STYLE,
  finishCanvasDrawingStroke,
  hitTestCanvasStroke,
  PEN_COLORS,
  renderCanvasInk,
  renderCanvasSelections,
  startCanvasDrawingStroke,
  strokeStyleFromUnknown,
  toCanvasStroke,
} from "../canvas/elements/drawing.ts";
import { isFigmaClipboardHtml, pasteFigmaClipboard } from "../canvas/elements/figma.ts";
import {
  canvasFilesFromDataTransfer,
  createUploadedFileShape,
  dragHasCanvasFiles,
} from "../canvas/elements/files.ts";
import { createLinkPreviewController, createLinkShape } from "../canvas/elements/link.ts";
import {
  createUploadedMediaShape,
  isMediaElementType,
  mediaFilesFromDataTransfer,
  uploadMediaFile,
} from "../canvas/elements/media.ts";
import { createNoteShape, NOTE_COLORS } from "../canvas/elements/note.ts";
import {
  defaultColorForShape,
  defaultSizeForShape,
  defaultTextForShape,
  isCanvasShapeType,
  isValidCanvasShape,
  minSizeForShape,
} from "../canvas/elements/registry.ts";
import {
  type CanvasShapeLibraryItem,
  drawShapeElement,
  getShapeLibraryItem,
  hitTestShapeElement,
  SHAPE_LIBRARY,
} from "../canvas/elements/shape.ts";
import { createTextShape, shouldRemoveTextShape } from "../canvas/elements/text.ts";
import type {
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasSnapshot,
  CanvasStroke,
  CanvasStrokeSnapshot,
  CanvasTool,
} from "../canvas/elements/types.ts";
import type { CollaborationPresenceProfile } from "../composeables/useCollaboration.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useDocuments } from "../composeables/useDocuments.ts";
import type { CanvasPresenceState } from "../editor/collaboration.ts";
import "../editor/elements/rich-text-editor.ts";
import "@atrium-ui/elements/popover";
import { useToast } from "../composeables/useToast.ts";
import {
  CANVAS_CLIPBOARD_MIME,
  type CanvasClipboard,
  canvasClipboardFromDataTransfer,
  canvasClipboardToDocumentHtml,
  canvasClipboardToPlainText,
  createCanvasClipboard,
  documentClipboardToCanvasShapes,
  parseCanvasClipboardHtml,
  parseCanvasClipboardJson,
  serializeCanvasClipboard,
} from "../utils/clipboard.ts";
import {
  filenameFromUrl,
  IMAGE_RESIZE_TIERS,
  resizeImageUrl,
  transformImageUrl,
} from "../utils/imageUrlTransformers.ts";
import { type TranslationKey, t } from "../utils/lang.ts";
import {
  CANVAS_CURSOR_COLOR_CHANGE_EVENT,
  CANVAS_CURSOR_COLOR_STORAGE_KEY,
  readCanvasCursorColor,
} from "../utils/userPreferences.ts";
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
  worldViewportBounds,
} from "../viewport/index.ts";

const props = defineProps<{
  spaceId: string;
  documentId?: string;
  ydoc: Y.Doc;
  presenceProfiles?: CollaborationPresenceProfile<CanvasPresenceState>[];
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
      startPointer: { x: number; y: number };
      startSize: { width: number; height: number };
      minSize: { width: number; height: number };
      // Locked width/height ratio for media; undefined lets the axes move freely.
      aspect?: number;
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

const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
type ToolDef = {
  id: CanvasTool;
  label: TranslationKey;
  shortcut: string;
  icon: string;
};

const CANVAS_TOOLS: ToolDef[] = [
  {
    id: "select",
    label: "Select",
    shortcut: "V",
    icon: canvasSelectIcon,
  },
  {
    id: "draw",
    label: "Draw",
    shortcut: "D",
    icon: pencilIcon,
  },
  {
    id: "note",
    label: "Note",
    shortcut: "N",
    icon: canvasNoteIcon,
  },
  {
    id: "text",
    label: "Text",
    shortcut: "T",
    icon: canvasTextIcon,
  },
  {
    id: "section",
    label: "Section",
    shortcut: "S",
    icon: canvasSectionIcon,
  },
];
const viewportRef = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLCanvasElement | null>(null);
const inkRef = ref<HTMLCanvasElement | null>(null);
const imagesRef = ref<HTMLCanvasElement | null>(null);
const selectionRef = ref<HTMLCanvasElement | null>(null);
const imageCache = new Map<string, HTMLImageElement | "loading" | "error">();
const shapes = shallowRef<CanvasShape[]>([]);
const strokes = shallowRef<CanvasStroke[]>([]);
const selectedShapeIds = ref<Set<string>>(new Set());
const selectedStrokeIds = ref<Set<string>>(new Set());
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
// Library entry the shape tool places next; the toolbar popover changes it.
const activeShapeId = ref<string>(SHAPE_LIBRARY[0].id);
const shapePopoverRef = ref<(HTMLElement & { hide: () => void }) | null>(null);
const noteColor = ref<string>(NOTE_COLORS[0]);
const penColor = ref<string>(PEN_COLORS[0]);
const cursorColor = ref<string>(readCanvasCursorColor());
const drawStrokeMode = ref<DrawStrokeMode>("pen");
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
// Used to resolve a dropped/inserted document id to best-effort local title/type
// metadata. The persisted canvas reference remains id-only.
const { documents } = useDocuments();

const ydoc = props.ydoc;
const yShapes = ydoc.getMap<Y.Map<unknown>>("canvas.shapes");
const yStrokes = ydoc.getMap<Y.Map<unknown>>("canvas.strokes");
const documentLinks = createDocumentLinkController({
  documents,
  fetchDocument: (documentId) => api.document.get(props.spaceId, documentId),
  insertShape: (shape) => yShapes.set(shape.id, createShapeMap(shape)),
  selectShape: (shapeId) => selectOnlyShape(shapeId),
  afterInsert: () => {
    activeTool.value = "select";
    saveImmediately();
  },
});
const linkPreviews = createLinkPreviewController();

// Tracks only local edits (default trackedOrigins = {null}); remote/agent
// updates arrive with origin "remote" and are excluded, so undo/redo only
// reverts this user's own changes.
const undoManager = new Y.UndoManager([yShapes, yStrokes]);

function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
let dragState: DragState | null = null;
// True once a shape drag has actually moved the selection. Document-link cards
// read this to tell a click (open the document) from a drag (just reposition).
let dragMoved = false;
let drawingSession: CanvasDrawingSession | null = null;
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
const textShapeSizes = shallowRef(new Map<string, { width: number; height: number }>());

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

const remoteCanvasDomSelections = computed(() =>
  remoteCanvasSelections.value.filter(
    (selection) =>
      selection.bounds.type !== "image" || isGifSrc(selection.bounds.src ?? ""),
  ),
);

const remoteCanvasImageSelections = computed(() =>
  remoteCanvasSelections.value.filter(
    (selection) =>
      selection.bounds.type === "image" && !isGifSrc(selection.bounds.src ?? ""),
  ),
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
  isCameraMoving.value = true;
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
  cameraMoveTimer = setTimeout(() => {
    isCameraMoving.value = false;
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

// Non-GIF images and geometric shapes paint on the images canvas layer — no
// DOM article needed. All other shapes stay in the DOM permanently;
// content-visibility:auto in CSS tells the browser to skip painting off-screen
// articles without JS involvement.
function isCanvasPaintedShape(shape: CanvasShape) {
  return shape.type === "shape" || (shape.type === "image" && !isGifSrc(shape.src ?? ""));
}

const domShapes = computed(() =>
  shapes.value.filter((shape) => !isCanvasPaintedShape(shape)),
);

// Canvas-painted shapes within the current viewport. Used only by
// renderImages() to avoid draw calls for off-screen shapes.
const visiblePaintedShapes = computed(() => {
  const vr = worldViewportBounds(camera.value, screen.value, FIT_REFERENCE, 400);
  return shapes.value.filter(
    (shape) =>
      isCanvasPaintedShape(shape) &&
      rectsIntersect(vr, {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
      }),
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

// World-space bounding box of the current multi-selection. Does NOT depend on
// the camera transform, so pan/zoom never triggers the O(n×points) loop — only
// actual selection or position changes do.
const selectionWorldBounds = computed(() => {
  if (selectedShapeIds.value.size + selectedStrokeIds.value.size < 2) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const id of selectedShapeIds.value) {
    const shape = shapesById.value.get(id);
    if (!shape) continue;
    const bounds = shapeBounds(shape);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  for (const id of selectedStrokeIds.value) {
    const stroke = strokesById.value.get(id);
    if (!stroke || stroke.points.length === 0) continue;
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
});

// Screen-space top-center anchor for the multi-selection overlay. O(1) —
// just projects the cached world bounds through the current transform.
const selectionAnchorPos = computed(() => {
  const b = selectionWorldBounds.value;
  if (!b) return null;
  return worldToScreen({ x: (b.minX + b.maxX) / 2, y: b.minY });
});

function selectOnlyShape(id: string) {
  selectedShapeIds.value = new Set([id]);
  if (selectedStrokeIds.value.size > 0) {
    selectedStrokeIds.value = new Set();
    renderInk();
  }
}

function selectStroke(id: string, additive: boolean) {
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

function textShapeFallbackSize(shape: CanvasShape) {
  const minSize = minSizeForShape("text");
  const lines = (shape.text || defaultTextForShape("text")).split(/\n/);
  const longestLineLength = Math.max(1, ...lines.map((line) => line.length));
  return {
    width: Math.max(minSize.width, Math.ceil(longestLineLength * 8.5 + 26)),
    height: Math.max(minSize.height, Math.ceil(lines.length * 20.25 + 22)),
  };
}

function textShapeSize(shape: CanvasShape) {
  return textShapeSizes.value.get(shape.id) ?? textShapeFallbackSize(shape);
}

function shapeBounds(shape: CanvasShape): CanvasShape {
  if (shape.type !== "text") return shape;
  return { ...shape, ...textShapeSize(shape) };
}

// Text shapes lay themselves out from their content. Width/height are local
// measured bounds for canvas geometry, not persisted shape data.
let textShapeObserver: ResizeObserver | null = null;
const observedTextShapes = new Map<Element, string>();

type RichTextEditorWithElement = HTMLElement & { el?: HTMLElement | null };

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function borderBoxExtra(element: HTMLElement) {
  const style = getComputedStyle(element);
  return {
    width: cssPixels(style.borderLeftWidth) + cssPixels(style.borderRightWidth),
    height: cssPixels(style.borderTopWidth) + cssPixels(style.borderBottomWidth),
  };
}

function measureIntrinsicTextShapeSize(element: HTMLElement) {
  const editorElement =
    element.querySelector<RichTextEditorWithElement>("rich-text-editor");
  const editorContent =
    editorElement?.el ?? editorElement?.shadowRoot?.querySelector<HTMLElement>(".tiptap");
  const shadowRoot = editorElement?.shadowRoot;
  if (!editorContent || !shadowRoot) return null;

  const clone = editorContent.cloneNode(true) as HTMLElement;
  clone.removeAttribute("contenteditable");
  clone.removeAttribute("tabindex");
  Object.assign(clone.style, {
    position: "fixed",
    left: "-100000px",
    top: "-100000px",
    visibility: "hidden",
    pointerEvents: "none",
    width: "max-content",
    minWidth: "0",
    maxWidth: "none",
    height: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "normal",
    overflowWrap: "normal",
  });

  shadowRoot.append(clone);
  const contentWidth = Math.max(clone.scrollWidth, clone.offsetWidth);
  const contentHeight = Math.max(clone.scrollHeight, clone.offsetHeight);
  clone.remove();

  const extra = borderBoxExtra(element);
  return {
    width: Math.ceil(contentWidth + extra.width),
    height: Math.ceil(contentHeight + extra.height),
  };
}

function syncTextShapeSize(id: string, element: HTMLElement) {
  if (!yShapes.has(id)) return;

  const minSize = minSizeForShape("text");
  const intrinsicSize = measureIntrinsicTextShapeSize(element);
  const width = Math.max(
    minSize.width,
    intrinsicSize?.width ?? Math.ceil(element.offsetWidth),
  );
  const height = Math.max(
    minSize.height,
    intrinsicSize?.height ?? Math.ceil(element.offsetHeight),
  );
  const current = textShapeSizes.value.get(id);
  if (current?.width === width && current?.height === height) {
    return;
  }

  const next = new Map(textShapeSizes.value);
  next.set(id, { width, height });
  textShapeSizes.value = next;
  renderSelections();
}

function observeTextShapeSize(element: HTMLElement, shapeId: string) {
  if (observedTextShapes.get(element) === shapeId) return;
  if (!textShapeObserver && typeof ResizeObserver !== "undefined") {
    textShapeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = observedTextShapes.get(entry.target);
        if (id) syncTextShapeSize(id, entry.target as HTMLElement);
      }
    });
  }
  observedTextShapes.set(element, shapeId);
  textShapeObserver?.observe(element);
}

function syncTextShapeObservers() {
  const viewport = viewportRef.value;
  if (!viewport) return;

  const currentElements = new Set<Element>();
  for (const element of viewport.querySelectorAll<HTMLElement>(
    ".canvas-shape.text[data-shape-id]",
  )) {
    const shapeId = element.dataset.shapeId;
    if (!shapeId) continue;
    currentElements.add(element);
    observeTextShapeSize(element, shapeId);
  }

  for (const [element] of observedTextShapes) {
    if (!currentElements.has(element) || !element.isConnected) {
      const shapeId = observedTextShapes.get(element);
      textShapeObserver?.unobserve(element);
      observedTextShapes.delete(element);
      if (shapeId) {
        const next = new Map(textShapeSizes.value);
        next.delete(shapeId);
        textShapeSizes.value = next;
      }
    }
  }
}

function isGifSrc(src: string): boolean {
  return /\.gif($|\?)/i.test(src);
}

function resolveMediaSrc(src: string): string {
  return src.startsWith("/") ? `${window.location.origin}${src}` : src;
}

function toShape(
  id: string,
  source: Y.Map<unknown> | CanvasSerializedShape,
): CanvasShape {
  const read = (key: keyof CanvasShape) =>
    source instanceof Y.Map ? source.get(key) : source[key];

  const typeValue = read("type");
  const type: CanvasShapeType = isCanvasShapeType(typeValue) ? typeValue : "note";
  const defaultSize = defaultSizeForShape(type);
  const minSize = minSizeForShape(type);
  return {
    id,
    type,
    x: toNumber(read("x"), 0),
    y: toNumber(read("y"), 0),
    width: Math.max(minSize.width, toNumber(read("width"), defaultSize.width)),
    height: Math.max(minSize.height, toNumber(read("height"), defaultSize.height)),
    text: typeof read("text") === "string" ? String(read("text")) : "",
    color:
      typeof read("color") === "string"
        ? String(read("color"))
        : defaultColorForShape(type),
    src:
      typeof read("src") === "string" ? resolveMediaSrc(String(read("src"))) : undefined,
    alt: typeof read("alt") === "string" ? String(read("alt")) : undefined,
    docId: typeof read("docId") === "string" ? String(read("docId")) : undefined,
    variant: typeof read("variant") === "string" ? String(read("variant")) : undefined,
    updatedAt: toNumber(read("updatedAt"), Date.now()),
  };
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
    if (!isValidCanvasShape(shape)) {
      yShapes.delete(id);
      removedInvalid = true;
    }
  }

  shapes.value = [...yShapes.entries()]
    .map(([id, value]) => toShape(id, value))
    .filter(isValidCanvasShape)
    .sort((a, b) => {
      if (a.type === "section" && b.type !== "section") return -1;
      if (a.type !== "section" && b.type === "section") return 1;
      return a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
    });

  let pruned = false;
  for (const id of selectedShapeIds.value) {
    if (!yShapes.has(id)) {
      selectedShapeIds.value.delete(id);
      pruned = true;
    }
  }
  if (pruned) selectedShapeIds.value = new Set(selectedShapeIds.value);
  if (removedInvalid) {
    if (isReady) scheduleSave();
    else savePrunedInvalidShapesWhenReady = true;
  }
}

function syncStrokesFromY() {
  strokes.value = [...yStrokes.entries()]
    .map(([id, value]) => toStroke(id, value))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  let pruned = false;
  for (const id of selectedStrokeIds.value) {
    if (!yStrokes.has(id)) {
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
  map.set("x", shape.x);
  map.set("y", shape.y);
  if (shape.type !== "text") {
    map.set("width", shape.width);
    map.set("height", shape.height);
  }
  map.set("text", shape.text);
  map.set("color", shape.color);
  if (shape.src) map.set("src", resolveMediaSrc(shape.src));
  if (shape.alt) map.set("alt", shape.alt);
  if (shape.docId) map.set("docId", shape.docId);
  if (shape.variant) map.set("variant", shape.variant);
  map.set("updatedAt", shape.updatedAt);
  return map;
}

function serializeShape(shape: CanvasShape): CanvasSerializedShape {
  if (shape.type !== "text") return { ...shape };
  const { width: _width, height: _height, ...rest } = shape;
  return rest;
}

function serializeSnapshot(): string {
  const snapshot: CanvasSnapshot = {
    version: 1,
    shapes: shapes.value.map(serializeShape),
    strokes: strokes.value.map((stroke) => ({
      id: stroke.id,
      points: stroke.points.map(cloneFreehandPoint),
      style: { ...stroke.style },
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
let cssShapeBorder = "rgba(15, 23, 42, 0.14)";

function canvasCssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const source = viewportRef.value ?? document.documentElement;
  return getComputedStyle(source).getPropertyValue(name).trim() || fallback;
}

function refreshCssVars() {
  cssGridMajor = canvasCssVar("--canvas-grid-major", "rgba(15, 23, 42, 0.13)");
  cssGridMinor = canvasCssVar("--canvas-grid-minor", "rgba(15, 23, 42, 0.07)");
  cssInkColor = canvasCssVar("--canvas-ink-color", FREEHAND_STYLE.color);
  cssShapeBorder = canvasCssVar("--canvas-shape-border", "rgba(15, 23, 42, 0.14)");
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
  renderGrid();
  renderInk();
  renderImages();
}

function applyGridType(value: unknown) {
  const next: GridType =
    value === "clean" || value === "dots" || value === "grid" ? value : "dots";
  if (next === gridType.value) return;
  gridType.value = next;
  renderGrid();
}

function defaultInkColor() {
  return cssInkColor;
}

function renderGrid() {
  const canvas = gridRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);

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

// Returns the highest-quality already-loaded image for `src` across all tiers,
// used as a backdrop while the target tier is still decoding.
function getCachedFallback(src: string): HTMLImageElement | null {
  for (let i = IMAGE_RESIZE_TIERS.length - 1; i >= 0; i--) {
    const cached = imageCache.get(resizeImageUrl(src, IMAGE_RESIZE_TIERS[i]));
    if (cached instanceof HTMLImageElement) return cached;
  }
  const cached = imageCache.get(src);
  return cached instanceof HTMLImageElement ? cached : null;
}

function renderImages() {
  const canvas = imagesRef.value;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, screen.value.width, screen.value.height);

  const t = transform.value;
  for (const shape of visiblePaintedShapes.value) {
    if (shape.type === "shape") {
      // Geometric shapes are vector-painted; their selection outlines render
      // on the selection canvas like every other non-image shape.
      drawShapeElement(ctx, shape, t, cssShapeBorder);
      continue;
    }
    if (shape.type !== "image" || !shape.src || isGifSrc(shape.src)) continue;
    const sx = shape.x * t.scale + t.dx;
    const sy = shape.y * t.scale + t.dy;
    const sw = shape.width * t.scale;
    const sh = shape.height * t.scale;
    if (sw <= 0 || sh <= 0) continue;

    // Physical pixel width the image occupies on screen — used to pick the
    // smallest resolution tier that still renders crisply.
    const targetPx = Math.ceil(sw * dpr);
    const tieredSrc = resizeImageUrl(shape.src, targetPx);

    const cached = imageCache.get(tieredSrc);
    if (!cached) {
      imageCache.set(tieredSrc, "loading");
      const img = new Image();
      img.src = tieredSrc;
      // decode() resolves after the image is fully decoded off the main thread,
      // so drawImage() never has to block to decode inline.
      img
        .decode()
        .then(() => {
          imageCache.set(tieredSrc, img);
          renderImages();
        })
        .catch(() => {
          imageCache.set(tieredSrc, "error");
          renderImages();
        });
    }

    // While the correctly-sized version is still loading, paint any lower-res
    // cached version so the image doesn't flash back to a placeholder on zoom.
    const displayImg =
      cached instanceof HTMLImageElement ? cached : getCachedFallback(shape.src);

    if (!displayImg) {
      ctx.fillStyle = "rgba(128,128,128,0.15)";
      ctx.fillRect(sx, sy, sw, sh);
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(displayImg, sx, sy, sw, sh);
    }

    for (const selection of remoteCanvasImageSelections.value) {
      if (selection.bounds.id !== shape.id) continue;
      ctx.strokeStyle = selection.cursorColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
    }

    if (selectedShapeIds.value.has(shape.id)) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
    }
  }
}

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
  const canvas = inkRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  renderCanvasInk({
    context,
    dpr,
    screen: screen.value,
    transform: transform.value,
    strokes: strokes.value,
    activeStroke: activeFreehandStroke,
    snapGuides: activeSnapGuides,
    defaultInkColor: defaultInkColor(),
  });

  renderSelections();
}

function renderSelections() {
  const canvas = selectionRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  renderCanvasSelections({
    context,
    dpr,
    screen: screen.value,
    transform: transform.value,
    strokes: strokes.value,
    selectedStrokeIds: selectedStrokeIds.value,
    remoteSelectedStrokeIds: remoteCanvasStrokeSelections.value,
    selectedShapeBounds: [...selectedShapeIds.value]
      .map((id) => shapesById.value.get(id))
      .filter((s) => s != null)
      .map(shapeBounds),
    remoteSelectedShapeBounds: remoteCanvasDomSelections.value.map((s) => ({
      x: s.bounds.x,
      y: s.bounds.y,
      width: s.bounds.width,
      height: s.bounds.height,
      type: s.bounds.type,
      color: s.cursorColor,
    })),
  });
}

function resize() {
  const rect = viewportRef.value?.getBoundingClientRect() ?? null;
  cachedViewportRect = rect;
  screen.value = {
    width: Math.max(1, Math.round(rect?.width ?? 1)),
    height: Math.max(1, Math.round(rect?.height ?? 1)),
  };
  dpr = window.devicePixelRatio || 1;
  const canvas = gridRef.value;
  if (canvas) {
    canvas.width = Math.round(screen.value.width * dpr);
    canvas.height = Math.round(screen.value.height * dpr);
    canvas.style.width = `${screen.value.width}px`;
    canvas.style.height = `${screen.value.height}px`;
  }
  const ink = inkRef.value;
  if (ink) {
    ink.width = Math.round(screen.value.width * dpr);
    ink.height = Math.round(screen.value.height * dpr);
    ink.style.width = `${screen.value.width}px`;
    ink.style.height = `${screen.value.height}px`;
  }
  const images = imagesRef.value;
  if (images) {
    images.width = Math.round(screen.value.width * dpr);
    images.height = Math.round(screen.value.height * dpr);
    images.style.width = `${screen.value.width}px`;
    images.style.height = `${screen.value.height}px`;
  }
  const selection = selectionRef.value;
  if (selection) {
    selection.width = Math.round(screen.value.width * dpr);
    selection.height = Math.round(screen.value.height * dpr);
    selection.style.width = `${screen.value.width}px`;
    selection.style.height = `${screen.value.height}px`;
  }
  renderGrid();
  renderInk();
  renderImages();
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

async function addMediaFile(file: File, at: { x: number; y: number }) {
  saveState.value = "saving";
  dispatchSaveStatus();

  try {
    const shape = await createUploadedMediaShape(file, at, {
      spaceId: props.spaceId,
      documentId: props.documentId,
    });
    if (!shape) {
      saveState.value = "idle";
      dispatchSaveStatus();
      return;
    }
    yShapes.set(shape.id, createShapeMap(shape));
    selectOnlyShape(shape.id);
    activeTool.value = "select";
    saveState.value = "idle";
    dispatchSaveStatus();
  } catch (err) {
    saveState.value = "idle";
    toast.error(err instanceof Error ? err.message : String(err));
    dispatchSaveStatus();
  }
}

function uploadCanvasMediaFile(file: File): Promise<string> {
  return uploadMediaFile(file, {
    spaceId: props.spaceId,
    documentId: props.documentId,
  });
}

async function addCanvasFile(file: File, at: { x: number; y: number }) {
  saveState.value = "saving";
  dispatchSaveStatus();

  try {
    const shape = await createUploadedFileShape(file, at, {
      spaceId: props.spaceId,
      documentId: props.documentId,
    });
    if (!shape) {
      saveState.value = "idle";
      dispatchSaveStatus();
      return;
    }
    yShapes.set(shape.id, createShapeMap(shape));
    selectOnlyShape(shape.id);
    activeTool.value = "select";
    saveState.value = "idle";
    dispatchSaveStatus();
  } catch (err) {
    saveState.value = "idle";
    toast.error(err instanceof Error ? err.message : String(err));
    dispatchSaveStatus();
  }
}

async function addDroppedCanvasFiles(
  media: File[],
  files: File[],
  at: { x: number; y: number },
) {
  let offset = 0;
  for (const file of media) {
    await addMediaFile(file, { x: at.x + offset, y: at.y + offset });
    offset += 24;
  }
  for (const file of files) {
    await addCanvasFile(file, { x: at.x + offset, y: at.y + offset });
    offset += 24;
  }
}

function onDocumentShapeOpen(shape: CanvasShape, event: Event) {
  event.preventDefault();
  if (dragMoved) return;
  const requestedDocumentId =
    event instanceof CustomEvent && typeof event.detail?.documentId === "string"
      ? event.detail.documentId
      : null;
  const documentId = requestedDocumentId ?? documentLinks.documentIdForShape(shape);
  if (!documentId) return;
  window.dispatchEvent(
    new CustomEvent("view-document", {
      detail: { spaceId: props.spaceId, documentId },
    }),
  );
}

function onFileShapeClick(event: MouseEvent) {
  if (!dragMoved) return;
  event.preventDefault();
  event.stopPropagation();
}

function addShape(
  type: "note" | "text" | "section" | "shape",
  at: { x: number; y: number },
) {
  const libraryItem = getShapeLibraryItem(activeShapeId.value) ?? SHAPE_LIBRARY[0];
  const shape =
    type === "note"
      ? createNoteShape(at, noteColor.value)
      : type === "text"
        ? createTextShape(at)
        : type === "shape"
          ? libraryItem.create(at)
          : {
              id: `shape-${crypto.randomUUID()}`,
              type: "section",
              x: Math.round(at.x),
              y: Math.round(at.y),
              ...defaultSizeForShape(type),
              text: defaultTextForShape(type),
              color: defaultColorForShape(type),
              updatedAt: Date.now(),
            };
  yShapes.set(shape.id, createShapeMap(shape));
  selectOnlyShape(shape.id);
  activeTool.value = "select";
  // Geometric shapes are canvas-painted with no DOM element to focus; they
  // stay selected for immediate move/resize instead.
  if (type === "shape") return;
  nextTick(() => {
    const selector =
      type === "section"
        ? `[data-section-title="${shape.id}"]`
        : `.canvas-shape[data-shape-id="${shape.id}"] rich-text-editor`;
    const el = document.querySelector<HTMLElement>(selector);
    el?.focus();
    (el as HTMLInputElement | HTMLTextAreaElement | null)?.select?.();
  });
}

function updateShapeText(shape: CanvasShape, text: string) {
  updateShape(shape.id, { text });
}

function handleTextBlur(shape: CanvasShape, value: string) {
  // A text element with no content has nothing to anchor it, so remove it once
  // editing ends. Notes and sections keep their box even when empty.
  if (shape.type !== "text") return;
  if (!shouldRemoveTextShape(value)) return;
  yShapes.delete(shape.id);
  if (selectedShapeIds.value.has(shape.id)) {
    selectedShapeIds.value.delete(shape.id);
    selectedShapeIds.value = new Set(selectedShapeIds.value);
  }
}

function isShapeInsideSection(shape: CanvasShape, section: CanvasShape) {
  if (shape.id === section.id) return false;
  const bounds = shapeBounds(shape);
  const sectionBounds = shapeBounds(section);
  return (
    bounds.x >= sectionBounds.x &&
    bounds.y >= sectionBounds.y &&
    bounds.x + bounds.width <= sectionBounds.x + sectionBounds.width &&
    bounds.y + bounds.height <= sectionBounds.y + sectionBounds.height
  );
}

function isPointInsideSection(point: FreehandPoint, section: CanvasShape) {
  return (
    point.x >= section.x &&
    point.y >= section.y &&
    point.x <= section.x + section.width &&
    point.y <= section.y + section.height
  );
}

function isStrokeInsideSection(stroke: CanvasStroke, section: CanvasShape) {
  return (
    stroke.points.length > 0 &&
    stroke.points.every((point) => isPointInsideSection(point, section))
  );
}

function getSectionContents(section: CanvasShape) {
  return {
    shapes: shapes.value
      .filter((shape) => isShapeInsideSection(shape, section))
      .map((shape) => ({ id: shape.id, x: shape.x, y: shape.y })),
    strokes: strokes.value
      .filter((stroke) => isStrokeInsideSection(stroke, section))
      .map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map(cloneFreehandPoint),
      })),
  };
}

function translateStroke(id: string, points: FreehandPoint[], dx: number, dy: number) {
  const stroke = yStrokes.get(id);
  if (!stroke) return;
  stroke.set("updatedAt", Date.now());
  stroke.set(
    "points",
    points.map((point) => ({
      ...point,
      x: point.x + dx,
      y: point.y + dy,
    })),
  );
}

function setNoteColor(color: string) {
  noteColor.value = color;
  const selected = selectedShape.value;
  if (selected?.type === "note" || selected?.type === "shape") {
    updateShape(selected.id, { color });
  }
}

function pickShapeLibraryItem(item: CanvasShapeLibraryItem) {
  activeShapeId.value = item.id;
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

function updateShape(id: string, patch: Partial<Omit<CanvasShape, "id">>) {
  const shape = yShapes.get(id);
  if (!shape) return;
  shape.set("updatedAt", Date.now());
  const isTextShape = shape.get("type") === "text";
  for (const [key, value] of Object.entries(patch)) {
    if (isTextShape && (key === "width" || key === "height")) continue;
    shape.set(key, value);
  }
}

function deleteSelectedShape() {
  if (selectedShapeIds.value.size === 0 && selectedStrokeIds.value.size === 0) return;
  ydoc.transact(() => {
    for (const id of selectedShapeIds.value) yShapes.delete(id);
    for (const id of selectedStrokeIds.value) yStrokes.delete(id);
  });
  selectedShapeIds.value = new Set();
  selectedStrokeIds.value = new Set();
}

function startFreehand(event: PointerEvent) {
  const started = startCanvasDrawingStroke(event, screenToWorld(screenPoint(event)), {
    color: penColor.value,
    mode: drawStrokeMode.value,
    worldToScreenScale: transform.value.scale,
  });
  if (!started) return;

  clearSelection();
  drawingSession = started.session;
  activeFreehandStroke = started.stroke;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function finishFreehand(event: PointerEvent) {
  if (!drawingSession || drawingSession.pointerId !== event.pointerId) return;
  const finished = finishCanvasDrawingStroke(drawingSession);
  if (finished) {
    yStrokes.set(finished.id, createStrokeMap(finished));
  }
  drawingSession = null;
  activeFreehandStroke = null;
  renderInk();
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
    if (!shape) continue;
    moveShapes.set(shape.id, { id: shape.id, x: shape.x, y: shape.y });
    if (shape.type === "section") {
      const contents = getSectionContents(shape);
      for (const s of contents.shapes) if (!moveShapes.has(s.id)) moveShapes.set(s.id, s);
      for (const s of contents.strokes)
        if (!moveStrokes.has(s.id)) moveStrokes.set(s.id, s);
    }
  }
  for (const id of selectedStrokeIds.value) {
    if (moveStrokes.has(id)) continue;
    const stroke = strokesById.value.get(id);
    if (stroke) {
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

function startShapeDrag(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0) return;

  // Shift toggles membership and does not begin a drag.
  if (event.shiftKey) {
    toggleShapeSelection(shape.id);
    if (shape.type !== "text") event.preventDefault();
    return;
  }

  // Clicking a shape outside the current selection collapses to just it;
  // clicking one already inside keeps the selection so the whole group drags.
  if (!selectedShapeIds.value.has(shape.id)) {
    selectOnlyShape(shape.id);
  }

  dragMoved = false;
  dragState = buildShapeDragState(event);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  if (shape.type !== "text") {
    event.preventDefault();
  }
}

function startShapeResize(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0 || shape.type === "text") return;
  selectOnlyShape(shape.id);
  const isMedia = isMediaElementType(shape.type);
  dragState = {
    type: "resize",
    pointerId: event.pointerId,
    shapeId: shape.id,
    startPointer: screenToWorld(screenPoint(event)),
    startSize: { width: shape.width, height: shape.height },
    minSize: minSizeForShape(shape.type),
    // Media keeps its aspect ratio; notes and sections resize freely.
    aspect: isMedia && shape.height > 0 ? shape.width / shape.height : undefined,
  };
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
    const bounds = shapeBounds(shape);
    const hit =
      shape.type === "section"
        ? rectContains(worldRect, bounds)
        : rectsIntersect(worldRect, bounds);
    if (hit) shapeIds.add(shape.id);
  }

  const strokeIds = new Set(state.additive ? state.baseStrokeIds : []);
  for (const stroke of strokes.value) {
    if (stroke.points.some((point) => isPointInRect(point, worldRect))) {
      strokeIds.add(stroke.id);
    }
  }

  selectedShapeIds.value = shapeIds;
  selectedStrokeIds.value = strokeIds;
  renderInk();
}

// Hit-tests canvas-painted shapes (non-GIF images and geometric shapes) in
// reverse paint order.
function hitTestPaintedShape(worldPoint: { x: number; y: number }): CanvasShape | null {
  for (let i = shapes.value.length - 1; i >= 0; i--) {
    const shape = shapes.value[i];
    if (!isCanvasPaintedShape(shape)) continue;
    if (shape.type === "shape") {
      if (hitTestShapeElement(shape, worldPoint)) return shape;
      continue;
    }
    if (isPointInRect(worldPoint, shape)) return shape;
  }
  return null;
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

    const hitShape = hitTestPaintedShape(worldPoint);
    if (hitShape) {
      if (additive) {
        toggleShapeSelection(hitShape.id);
      } else if (!selectedShapeIds.value.has(hitShape.id)) {
        selectOnlyShape(hitShape.id);
      }
      dragMoved = false;
      dragState = buildShapeDragState(event);
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
      selectStroke(hitStroke, additive);
      event.preventDefault();
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

  if (activeTool.value === "draw") {
    startFreehand(event);
    return;
  }

  if (
    activeTool.value === "note" ||
    activeTool.value === "text" ||
    activeTool.value === "section" ||
    activeTool.value === "shape"
  ) {
    addShape(activeTool.value, screenToWorld(point));
  }
  event.preventDefault();
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
    const bounds = shapeBounds(shape);
    minX = Math.min(minX, moved.x);
    minY = Math.min(minY, moved.y);
    maxX = Math.max(maxX, moved.x + bounds.width);
    maxY = Math.max(maxY, moved.y + bounds.height);
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
    .filter(
      (shape) => !movingIds.has(shape.id) && rectsIntersect(near, shapeBounds(shape)),
    )
    .map((shape) => ({ id: shape.id, bounds: shapeBounds(shape) }));

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

function handlePointerMove(event: PointerEvent) {
  const point = screenPoint(event);
  localPointer = screenToWorld(point);

  if (drawingSession && drawingSession.pointerId === event.pointerId) {
    for (const coalesced of event.getCoalescedEvents()) {
      activeFreehandStroke = addCanvasDrawingPoint(
        drawingSession,
        coalesced,
        screenToWorld(screenPoint(coalesced)),
      );
    }
    scheduleInkRender();
    event.preventDefault();
    return;
  }

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
    let width = dragState.startSize.width + world.x - dragState.startPointer.x;
    let height = dragState.startSize.height + world.y - dragState.startPointer.y;

    if (dragState.aspect) {
      // Drive the locked box from whichever axis the pointer pushed out
      // furthest, then derive the other axis and clamp against both minimums.
      width = Math.max(width, height * dragState.aspect, dragState.minSize.width);
      height = width / dragState.aspect;
      if (height < dragState.minSize.height) {
        height = dragState.minSize.height;
        width = height * dragState.aspect;
      }
    } else {
      width = Math.max(dragState.minSize.width, width);
      height = Math.max(dragState.minSize.height, height);
    }

    updateShape(dragState.shapeId, {
      width: Math.round(width),
      height: Math.round(height),
    });
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
  ydoc.transact(() => {
    for (const moved of drag.shapes) {
      updateShape(moved.id, {
        x: Math.round(moved.x + dx),
        y: Math.round(moved.y + dy),
      });
    }
    for (const stroke of drag.strokes) {
      translateStroke(stroke.id, stroke.points, dx, dy);
    }
  });
  // Yjs shape edits don't trigger an ink redraw, so guides won't appear without
  // this explicit render.
  scheduleInkRender();
}

function handlePointerUp(event: PointerEvent) {
  finishFreehand(event);
  if (dragState?.pointerId === event.pointerId) {
    if (dragState.type === "marquee") marqueeRect.value = null;
    if (dragState.type === "pan") isPanning.value = false;
    if (activeSnapGuides.length > 0) {
      activeSnapGuides = [];
      renderInk();
    }
    dragState = null;
  }
}

function handlePointerLeave() {
  localPointer = null;
  updatePresence();
}

function handleDragOver(event: DragEvent) {
  const hasFiles = dragHasCanvasFiles(event.dataTransfer);
  if (!hasFiles && !dragHasDocumentLink(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) {
    // Document drags from the sidebar/palette advertise effectAllowed "move";
    // a mismatched "copy" dropEffect makes the browser reject the drop, so we
    // mirror "move" for those. OS file drops carry copy semantics.
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
  }
}

function handleDrop(event: DragEvent) {
  if (dragHasCanvasFiles(event.dataTransfer)) {
    // Prevent the browser from navigating to the file even when the dropped
    // files turn out not to be something we can place.
    event.preventDefault();
    const media = mediaFilesFromDataTransfer(event.dataTransfer);
    const files = canvasFilesFromDataTransfer(event.dataTransfer);
    const at = insertionPointFromEvent(event);
    if (media.length > 0 || files.length > 0) {
      void addDroppedCanvasFiles(media, files, at);
    }
    return;
  }

  // A document dragged from the sidebar or command palette becomes a link card.
  const droppedId = getDroppedDocumentId(event.dataTransfer, documents.value);
  if (
    droppedId &&
    documentLinks.insertDocumentLink(droppedId, insertionPointFromEvent(event))
  ) {
    event.preventDefault();
  }
}

function handleContextMenu(event: MouseEvent) {
  // Always prevent the native context menu / iOS callout.
  event.preventDefault();
  if (!viewportRef.value) return;

  // Don't open the menu when the draw tool is active.
  if (activeTool.value === "draw") return;

  dragState = null;
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
  const payload =
    parseCanvasClipboardJson(clipboard.canvasJson) ??
    parseCanvasClipboardHtml(clipboard.html) ??
    parseCanvasClipboardJson(clipboard.text);
  if (payload) {
    pasteCanvasClipboard(payload, insertAt);
    return;
  }

  if (clipboard.html.trim()) {
    const inserted = pasteDocumentClipboardShapes(
      documentClipboardToCanvasShapes({
        html: clipboard.html,
        text: clipboard.text,
        at: insertAt,
      }),
    );
    if (inserted) return;
  }

  if (clipboard.text.trim()) {
    pasteDocumentClipboardShapes(
      documentClipboardToCanvasShapes({ text: clipboard.text, at: insertAt }),
    );
  }
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
    .filter((shape) => selectedShapeIds.value.has(shape.id))
    .map(serializeShape);
  const selStrokes = strokes.value
    .filter((stroke) => selectedStrokeIds.value.has(stroke.id))
    .map((stroke) => ({
      id: stroke.id,
      points: stroke.points.map(cloneFreehandPoint),
      style: { ...stroke.style },
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
  if (el?.closest("textarea, input, select")) return true;
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
    ...payload.shapes.map((shape) => shape.x),
    ...payload.strokes.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...payload.shapes.map((shape) => shape.y),
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
          x: Math.round(shape.x + dx),
          y: Math.round(shape.y + dy),
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

function pasteDocumentClipboardShapes(nextShapes: CanvasShape[]): boolean {
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
  renderImages();
  return true;
}

async function addImageFromUrl(
  fetchUrl: string,
  originalUrl: string,
  at: { x: number; y: number },
) {
  let file: File;
  try {
    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) throw new Error("URL did not return an image");
    const blob = await response.blob();
    file = new File([blob], filenameFromUrl(originalUrl), { type: blob.type });
  } catch (err) {
    toast.error(
      `Could not fetch image: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  await addMediaFile(file, at);
}

function handlePaste(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input, select")) return;

  // The system clipboard is authoritative; it reflects the latest copy from
  // anywhere, including other tabs and spaces.
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const html = event.clipboardData?.getData("text/html") ?? "";

  // 1. Our own canvas elements. Prefer custom/html metadata, but keep parsing
  // legacy text/plain JSON from older copies.
  const payload = canvasClipboardFromDataTransfer(event.clipboardData);
  if (payload) {
    event.preventDefault();
    pasteCanvasClipboard(payload, insertionPointFromEvent());
    return;
  }

  // 2. Files pasted from the clipboard. Images/video keep their native canvas
  //    renderers; everything else uses the shared file attachment renderer.
  const media = mediaFilesFromDataTransfer(event.clipboardData);
  const files = canvasFilesFromDataTransfer(event.clipboardData);
  if (media.length > 0 || files.length > 0) {
    event.preventDefault();
    void addDroppedCanvasFiles(media, files, insertionPointFromEvent());
    return;
  }

  // 3. Figma selection — HTML blob with figmeta + kiwi binary scene data. Must
  //    run before the plain-text bail below because Figma also populates text/plain.
  if (isFigmaClipboardHtml(html)) {
    event.preventDefault();
    saveState.value = "saving";
    dispatchSaveStatus();
    void pasteFigmaClipboard(html, insertionPointFromEvent(), {
      uploadMediaFile: uploadCanvasMediaFile,
      insertShape: (shape) => yShapes.set(shape.id, createShapeMap(shape)),
    }).then((result) => {
      if (result.createdIds.length > 0) {
        selectedShapeIds.value = new Set(result.createdIds);
        activeTool.value = "select";
      }
      if (result.error) {
        toast.error(
          result.error instanceof Error ? result.error.message : String(result.error),
        );
      }
      saveState.value = "idle";
      dispatchSaveStatus();
    });
    return;
  }

  // 4. Plain-text URL that resolves to an image — fetch and insert as a
  //    canvas image shape. Must run before the non-empty text bail below
  //    because an image URL is "real" text we still want to consume.
  const imageUrl = transformImageUrl(text.trim());
  if (imageUrl) {
    event.preventDefault();
    void addImageFromUrl(imageUrl, text.trim(), insertionPointFromEvent());
    return;
  }

  // 5. Plain-text HTTP(S) URL — insert as a link preview card.
  const trimmedUrl = text.trim();
  if (/^https?:\/\//i.test(trimmedUrl)) {
    try {
      new URL(trimmedUrl);
      event.preventDefault();
      const shape = createLinkShape(trimmedUrl, insertionPointFromEvent());
      yShapes.set(shape.id, createShapeMap(shape));
      selectOnlyShape(shape.id);
      activeTool.value = "select";
      void linkPreviews.loadPreview(trimmedUrl);
      saveImmediately();
      return;
    } catch {
      // not a valid URL, fall through
    }
  }

  // 6. Rich document/web HTML — map supported nodes to canvas shapes.
  if (html.trim()) {
    const inserted = pasteDocumentClipboardShapes(
      documentClipboardToCanvasShapes({
        html,
        text,
        at: insertionPointFromEvent(),
      }),
    );
    if (inserted) {
      event.preventDefault();
      return;
    }
  }

  // 7. Plain text — create a text shape on the canvas.
  if (text.trim().length > 0) {
    event.preventDefault();
    pasteDocumentClipboardShapes(
      documentClipboardToCanvasShapes({ text, at: insertionPointFromEvent() }),
    );
    return;
  }

  // 8. The system clipboard gave us nothing usable.
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

function fitView(maxZoom = 5) {
  const xs = [
    ...shapes.value.flatMap((shape) => {
      const bounds = shapeBounds(shape);
      return [bounds.x, bounds.x + bounds.width];
    }),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...shapes.value.flatMap((shape) => {
      const bounds = shapeBounds(shape);
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
  if (target?.closest("textarea, input, select")) return;

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

  if (key === "v") activeTool.value = "select";
  if (key === "d") activeTool.value = "draw";
  if (key === "n") activeTool.value = "note";
  if (key === "t") activeTool.value = "text";
  if (key === "s") activeTool.value = "section";
  if (key === "r") activeTool.value = "shape";
  if (key === "f") fitView();
}

watch(
  shapes,
  () => {
    void nextTick(syncTextShapeObservers);
    renderImages();
    renderSelections();
  },
  { flush: "post" },
);

watch(selectedShapeIds, () => {
  renderImages();
  renderSelections();
  updatePresence();
});

watch(selectedStrokeIds, () => {
  renderSelections();
  updatePresence();
});

watch(remoteCanvasDomSelections, () => {
  renderSelections();
});

watch(remoteCanvasStrokeSelections, () => {
  renderSelections();
});

watch(remoteCanvasImageSelections, () => {
  renderImages();
});

watch(
  () => documentData.value?.properties?.gridtype,
  (value) => applyGridType(value),
  { immediate: true },
);

watch(
  () =>
    shapes.value
      .filter((shape) => shape.type === "document")
      .map((shape) => ({
        shapeId: shape.id,
        docId: shape.docId ?? null,
        resolvedDocId: documentLinks.documentIdForShape(shape) ?? null,
      })),
  (documentRefs) => {
    for (const ref of documentRefs) {
      if (ref.resolvedDocId) {
        void documentLinks.loadPreview(ref.resolvedDocId);
      }
    }
  },
  { deep: true, immediate: true },
);

watch(
  () => shapes.value.filter((s) => s.type === "link").map((s) => s.src),
  (urls) => {
    for (const url of urls) {
      if (url) void linkPreviews.loadPreview(url);
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
    renderGrid();
    renderInk();
    renderImages();
    updatePresence();
  },
  { flush: "post" },
);

onMounted(() => {
  void import("../editor/document.ts");
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
  void nextTick(syncTextShapeObservers);
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
      dragState = null;
      isPanning.value = false;
      drawingSession = null;
      activeFreehandStroke = null;
      renderInk();
    },
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
  window.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("copy", handleCopy);
  window.addEventListener("cut", handleCut);
  window.addEventListener("paste", handlePaste);
});

onUnmounted(() => {
  viewportControls?.dispose();
  resizeObserver?.disconnect();
  textShapeObserver?.disconnect();
  observedTextShapes.clear();
  themeObserver?.disconnect();
  colorSchemeMedia?.removeEventListener("change", updateThemeMode);
  emit("presence", []);
  undoManager.destroy();
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerUp);
  window.removeEventListener("copy", handleCopy);
  window.removeEventListener("cut", handleCut);
  window.removeEventListener("paste", handlePaste);
  window.removeEventListener(
    CANVAS_CURSOR_COLOR_CHANGE_EVENT,
    handleCursorColorPreferenceChange,
  );
  window.removeEventListener("storage", handleStorageChange);
  imageCache.clear();
  if (saveTimer) clearTimeout(saveTimer);
  if (saveStateTimer) clearTimeout(saveStateTimer);
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
  if (inkRafId !== null) cancelAnimationFrame(inkRafId);
  if (presenceRafId !== null) cancelAnimationFrame(presenceRafId);
});
</script>

<template>
  <div class="canvas-root" :class="{ 'is-dark': isDarkMode }">
    <div
      v-if="
        activeTool === 'draw' ||
        activeTool === 'note' ||
        selectedStrokeIds.size > 0 ||
        selectedShape?.type === 'note' ||
        selectedShape?.type === 'shape'
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
          :class="{ active: drawStrokeMode === mode.id }"
          :aria-label="t(mode.label)"
          :aria-pressed="drawStrokeMode === mode.id"
          :title="t(mode.label)"
          @click="drawStrokeMode = mode.id"
        >
          <div
            class="svg-icon canvas-draw-mode-icon"
            aria-hidden="true"
            v-html="mode.icon"
          />
        </button>
      </span>
      <span
        v-if="activeTool === 'draw'"
        class="canvas-divider"
      ></span>
      <span
        v-if="activeTool === 'note' || selectedShape?.type === 'note' || selectedShape?.type === 'shape'"
        class="canvas-note-colors"
        :aria-label="t('Note color')"
      >
        <button
          v-for="color in NOTE_COLORS"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: (selectedShape?.type === 'note' || selectedShape?.type === 'shape' ? selectedShape.color : noteColor) === color }"
          :style="{ background: color }"
          :aria-label="`${t('Set note color')} ${color}`"
          @click="setNoteColor(color)"
        ></button>
      </span>
      <span
        v-if="
          (activeTool === 'draw' || selectedStrokeIds.size > 0) &&
          (activeTool === 'note' || selectedShape?.type === 'note' || selectedShape?.type === 'shape')
        "
        class="canvas-divider"
      ></span>
      <span
        v-if="activeTool === 'draw' || selectedStrokeIds.size > 0"
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
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="undoArrowIcon" />
      </button>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Redo')"
        :data-tooltip="`${t('Redo')} · ⌘⇧Z`"
        :disabled="!canRedo"
        @click="redo"
      >
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="redoArrowIcon" />
      </button>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Fit to view')"
        :data-tooltip="`${t('Fit to view')} · F`"
        @click="fitView()"
      >
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="canvasFitViewIcon" />
      </button>
    </div>

    <div
      ref="viewportRef"
      class="canvas-viewport"
      tabindex="-1"
      :style="{ cursor: viewportCursor }"
      @contextmenu="handleContextMenu"
      @pointerdown="handleViewportPointerDown"
      @pointerleave="handlePointerLeave"
      @dragover="handleDragOver"
      @drop="handleDrop"
    >
      <canvas ref="gridRef" class="canvas-grid"></canvas>
      <canvas ref="imagesRef" class="canvas-images"></canvas>
      <canvas ref="inkRef" class="canvas-ink"></canvas>
      <canvas ref="selectionRef" class="canvas-selection"></canvas>
      <div
        class="canvas-world"
        :style="{
          transform: `translate(${transform.dx}px, ${transform.dy}px) scale(${transform.scale})`,
        }"
      >
        <article
          v-for="shape in domShapes"
          :key="shape.id"
          class="canvas-shape"
          :class="[
            shape.type,
            { selected: selectedShapeIds.has(shape.id) },
          ]"
          :style="{
            left: `${shape.x}px`,
            top: `${shape.y}px`,
            ...(shape.type === 'text'
              ? {}
              : { width: `${shape.width}px`, height: `${shape.height}px` }),
            ...(shape.type === 'image' ? {} : { background: shape.color }),
          }"
          :data-shape-id="shape.id"
        >
          <template v-if="shape.type === 'section'">
            <div
              class="canvas-section-edge top"
              @pointerdown.stop="startShapeDrag(shape, $event)"
            ></div>
            <div
              class="canvas-section-edge right"
              @pointerdown.stop="startShapeDrag(shape, $event)"
            ></div>
            <div
              class="canvas-section-edge bottom"
              @pointerdown.stop="startShapeDrag(shape, $event)"
            ></div>
            <div
              class="canvas-section-edge left"
              @pointerdown.stop="startShapeDrag(shape, $event)"
            ></div>
          </template>
          <div
            v-if="shape.type === 'section'"
            class="canvas-section-header"
            @pointerdown.stop="startShapeDrag(shape, $event)"
          >
            <input
              class="canvas-section-title"
              :data-section-title="shape.id"
              :value="shape.text"
              spellcheck="false"
              :aria-label="t('Section headline')"
              @focus="selectOnlyShape(shape.id)"
              @pointerdown.stop
              @input="updateShapeText(shape, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div
            v-else-if="shape.type === 'note'"
            class="canvas-shape-handle"
            @pointerdown.stop="startShapeDrag(shape, $event)"
          ></div>
          <img
            v-if="shape.type === 'image' && shape.src && isGifSrc(shape.src)"
            class="canvas-shape-image"
            :src="shape.src"
            :alt="shape.alt || ''"
            draggable="false"
            decoding="async"
            @pointerdown.stop="startShapeDrag(shape, $event)"
          />
          <div
            v-else-if="shape.type === 'image'"
            class="canvas-shape-image"
            @pointerdown.stop="startShapeDrag(shape, $event)"
          />
          <video
            v-else-if="shape.type === 'video' && shape.src"
            class="canvas-shape-image"
            :src="shape.src"
            :aria-label="shape.alt || ''"
            autoplay
            muted
            loop
            playsinline
            draggable="false"
            @pointerdown.stop="startShapeDrag(shape, $event)"
          ></video>
          <file-attachment
            v-else-if="shape.type === 'file' && shape.src"
            class="canvas-shape-file"
            :src="shape.src"
            :filename="shape.alt || shape.text || 'file'"
            @pointerdown.stop="startShapeDrag(shape, $event)"
            @click.capture="onFileShapeClick"
          ></file-attachment>
          <document-attachment
            v-else-if="shape.type === 'document'"
            class="canvas-shape-document"
            :title="documentLinks.shapeTitle(shape)"
            :type="documentLinks.shapeType(shape)"
            :status="documentLinks.shapeStatus(shape)"
            :content="documentLinks.shapeContent(shape)"
            :space-id="props.spaceId"
            :document-id="documentLinks.documentIdForShape(shape) || ''"
            @pointerdown.stop="startShapeDrag(shape, $event)"
            @wheel.stop
            @open-document="onDocumentShapeOpen(shape, $event)"
          ></document-attachment>
          <a
            v-else-if="shape.type === 'link' && shape.src"
            class="canvas-shape-link"
            :href="shape.src"
            target="_blank"
            rel="noopener noreferrer"
            draggable="false"
            @pointerdown.stop="startShapeDrag(shape, $event)"
            @click.capture="onFileShapeClick"
          >
            <div
              v-if="linkPreviews.previewForShape(shape)?.metadata?.video || linkPreviews.previewForShape(shape)?.metadata?.image"
              class="canvas-link-image"
            >
              <video
                v-if="linkPreviews.previewForShape(shape)?.metadata?.video"
                :src="`/api/v1/proxy-media?url=${encodeURIComponent(linkPreviews.previewForShape(shape)!.metadata!.video!)}`"
                autoplay
                muted
                loop
                playsinline
                draggable="false"
              ></video>
              <img
                v-else
                :src="linkPreviews.previewForShape(shape)!.metadata!.image!"
                alt=""
                draggable="false"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              />
            </div>
            <div class="canvas-link-body">
              <div class="canvas-link-site">
                <img
                  v-if="linkPreviews.previewForShape(shape)?.metadata?.favicon"
                  :src="linkPreviews.previewForShape(shape)!.metadata!.favicon!"
                  class="canvas-link-favicon"
                  aria-hidden="true"
                  draggable="false"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                />
                <span class="canvas-link-domain">
                  {{ linkPreviews.previewForShape(shape)?.metadata?.siteName || getDomainFromUrl(shape.src) }}
                </span>
              </div>
              <div class="canvas-link-title">
                {{ linkPreviews.previewForShape(shape)?.metadata?.title || shape.src }}
              </div>
              <div
                v-if="linkPreviews.previewForShape(shape)?.metadata?.description"
                class="canvas-link-desc"
              >
                {{ linkPreviews.previewForShape(shape)!.metadata!.description }}
              </div>
            </div>
          </a>
          <rich-text-editor
            v-else-if="shape.type !== 'section'"
            class="canvas-shape-textwrap"
            :value="shape.text"
            @content-change="updateShapeText(shape, ($event as CustomEvent).detail)"
            @editor-focus="selectOnlyShape(shape.id)"
            @editor-blur="handleTextBlur(shape, ($event as CustomEvent).detail)"
            @pointerdown.stop="shape.type === 'text' && !($event.currentTarget as Element).matches(':focus-within') && startShapeDrag(shape, $event)"
          />
          <button
            v-if="shape.type !== 'text' && selectedShape?.id === shape.id"
            type="button"
            class="canvas-resize-handle"
            :aria-label="`${t('Resize')} ${shape.type}`"
            @pointerdown.stop="startShapeResize(shape, $event)"
          ></button>
        </article>
      </div>

      <!-- Resize handle for canvas-painted shapes (lives in screen space, not world div) -->
      <button
        v-if="selectedShape && isCanvasPaintedShape(selectedShape)"
        type="button"
        class="canvas-resize-handle canvas-image-resize-handle"
        :aria-label="`${t('Resize')} ${selectedShape.type}`"
        :style="{
          left: `${worldToScreen({ x: selectedShape.x + selectedShape.width, y: selectedShape.y + selectedShape.height }).x - 18}px`,
          top: `${worldToScreen({ x: selectedShape.x + selectedShape.width, y: selectedShape.y + selectedShape.height }).y - 18}px`,
        }"
        @pointerdown.stop="startShapeResize(selectedShape, $event)"
      ></button>

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
        v-if="selectionAnchorPos"
        class="canvas-selection-overlay"
        :style="{
          transform: `translate(${selectionAnchorPos.x}px, ${selectionAnchorPos.y}px) translate(-50%, calc(-100% - 10px))`,
        }"
        @pointerdown.stop
      >
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Copy')"
          :data-tooltip="`${t('Copy')} · ⌘C`"
          @click="copySelectionToClipboard"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="copyIcon" />
        </button>
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Cut')"
          :data-tooltip="`${t('Cut')} · ⌘X`"
          @click="cutSelectionToClipboard"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="scissorsIcon" />
        </button>
        <span class="canvas-divider"></span>
        <button
          type="button"
          class="canvas-tool danger"
          :aria-label="t('Delete')"
          :data-tooltip="`${t('Delete')} · ⌫`"
          @click="deleteSelectedShape"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="trashIcon" />
        </button>
      </div>

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
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="scissorsIcon" />
          </button>
          <span class="canvas-divider"></span>
        </template>
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Paste')"
          @click="pasteFromContextMenu"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="clipboardDocumentIcon" />
        </button>
        <template v-if="selectedShapeIds.size > 0 || selectedStrokeIds.size > 0">
          <span class="canvas-divider"></span>
          <button
            type="button"
            class="canvas-tool danger"
            :aria-label="t('Delete')"
            @click="deleteSelectedShape(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="trashIcon" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
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
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
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

.canvas-selection-overlay {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 9;
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
  transform-origin: 0 0;
}

.canvas-grid,
.canvas-images,
.canvas-ink,
.canvas-selection {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}

.canvas-shape {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--canvas-shape-border);
  border-radius: 8px;
  box-shadow: 0 8px 22px var(--canvas-shape-shadow);
  content-visibility: auto;
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

.canvas-shape.section {
  overflow: visible;
  border: 2px solid var(--canvas-section-border);
  border-radius: 10px;
  background: var(--canvas-section-bg) !important;
  box-shadow: none;
  /* The inner fill is click-through; only the headline, border edges, and
     resize handle select/drag the section. */
  pointer-events: none;
}


.canvas-shape.section .canvas-section-header,
.canvas-shape.section .canvas-section-title,
.canvas-shape.section .canvas-section-edge,
.canvas-shape.section .canvas-resize-handle {
  pointer-events: auto;
}

.canvas-section-edge {
  position: absolute;
  cursor: move;
}

.canvas-section-edge.top {
  top: -6px;
  left: 0;
  right: 0;
  height: 12px;
}

.canvas-section-edge.bottom {
  bottom: -6px;
  left: 0;
  right: 0;
  height: 12px;
}

.canvas-section-edge.left {
  top: 0;
  bottom: 0;
  left: -6px;
  width: 12px;
}

.canvas-section-edge.right {
  top: 0;
  bottom: 0;
  right: -6px;
  width: 12px;
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

.canvas-shape.link {
  background: var(--canvas-link-bg) !important;
  cursor: move;
}

.canvas-shape-link {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  cursor: move;
}

.canvas-link-image {
  flex: 1;
  width: 100%;
  height: 120px;
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

.canvas-section-header {
  position: absolute;
  left: 12px;
  top: -16px;
  display: flex;
  max-width: calc(100% - 24px);
  cursor: move;
}

.canvas-section-title {
  min-width: 96px;
  max-width: 100%;
  border: 1px solid var(--canvas-section-title-border);
  border-radius: 6px;
  background: var(--canvas-section-title-bg);
  padding: 3px 8px;
  color: var(--canvas-section-title-text);
  font: inherit;
  font-size: 13px;
  font-weight: 750;
  line-height: 1.2;
  outline: none;
}

.canvas-section-title:focus {
  border-color: #2563eb;
  background: var(--canvas-section-title-focus-bg);
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
  --editor-padding: 10px 12px;
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
  --editor-white-space: pre-wrap;
  --editor-word-break: normal;
  --editor-overflow-wrap: normal;
}

.canvas-shape.note .canvas-shape-textwrap {
  color: #111827;
}

.canvas-image-resize-handle {
  position: absolute;
  right: auto;
  bottom: auto;
  z-index: 6;
}

.canvas-resize-handle {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 14px;
  height: 14px;
  border: 0;
  border-right: 2px solid var(--canvas-resize-border);
  border-bottom: 2px solid var(--canvas-resize-border);
  background: transparent;
  cursor: nwse-resize;
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
