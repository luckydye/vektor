<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import * as Y from "yjs";
import {
  chevronRightThinIcon,
  clipboardDocumentIcon,
  copyIcon,
  documentIcon,
  redoArrowIcon,
  scissorsIcon,
  trashIcon,
  undoArrowIcon,
} from "~/src/assets/icons.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useDocuments } from "../composeables/useDocuments.ts";
import { useRoute } from "../composeables/useRoute.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import type { PresenceEnvelope } from "../utils/realtime.ts";
import { joinPresenceRoom, joinYjsRoom } from "../utils/sync.ts";
import {
  buildFreehandStroke,
  buildTransform,
  computeSnapGuides,
  createFreehandStrokeBuilder,
  createViewportControls,
  drawFreehandOutline,
  drawFreehandStroke,
  drawSnapGuides,
  drawWorldGrid,
  type FitReference,
  type FreehandPoint,
  type FreehandStroke,
  type FreehandStrokeBuilder,
  type FreehandStrokeOptions,
  type FreehandStrokeStyle,
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
} from "../viewport/index.ts";

const props = defineProps<{
  spaceId: string;
  documentId?: string;
}>();

type CanvasTool = "select" | "draw" | "note" | "text" | "section";
type CanvasShapeType = "note" | "text" | "image" | "video" | "section" | "document";

type CanvasShape = {
  id: string;
  type: CanvasShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  src?: string;
  alt?: string;
  // For "document" shapes: the linked document's id and slug. The slug builds
  // the navigation URL; the id is the stable reference.
  docId?: string;
  docSlug?: string;
  updatedAt: number;
};

type CanvasSnapshot = {
  version: 1;
  shapes: CanvasShape[];
  strokes?: CanvasStrokeSnapshot[];
};

type CanvasStrokeSnapshot = {
  id: string;
  points: FreehandPoint[];
  style: FreehandStrokeStyle;
  updatedAt: number;
};

type CanvasStroke = FreehandStroke & {
  id: string;
  updatedAt: number;
};

type CanvasPresenceState = {
  kind: "canvas";
  pointer: { x: number; y: number } | null;
  view: { x: number; y: number; scale: number };
  selectionIds: string[];
  focusedNodeId: string | null;
  activeTool: CanvasTool | null;
};

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
const FREEHAND_STYLE: FreehandStrokeStyle = {
  color: "#111827",
  width: 10,
  opacity: 1,
  lineCap: "round",
  lineJoin: "round",
};
// Width bounds are in world units; the renderer scales them by zoom.
const FREEHAND_VELOCITY = {
  minWidth: 5,
  maxWidth: 14,
  smoothing: 0.7,
};
// The stroke reaches its thinnest at roughly this pointer speed in screen px/ms.
const SCREEN_VELOCITY_FULL = 4;

// addVelocityWidths measures velocity in world units/ms, so it would otherwise
// taper differently depending on zoom. Multiplying the scale by the current
// world→screen scale makes the taper track on-screen pointer speed instead.
function freehandOptions(
  style: FreehandStrokeStyle = FREEHAND_STYLE,
): FreehandStrokeOptions {
  return {
    minDistance: 2,
    simplifyTolerance: 0.75,
    smoothing: 0.9,
    style,
    velocityWidth: {
      ...FREEHAND_VELOCITY,
      scale: (1 / SCREEN_VELOCITY_FULL) * transform.value.scale,
    },
  };
}
type ToolDef = {
  id: CanvasTool;
  label: string;
  shortcut: string;
  paths: string[];
};

// Outline (stroke) icon paths on a 24×24 grid, drawn with currentColor.
const CANVAS_TOOLS: ToolDef[] = [
  {
    id: "select",
    label: "Select",
    shortcut: "V",
    paths: [
      "M4.5 4.2a.6.6 0 0 1 .77-.77l13.2 5.36a.6.6 0 0 1-.07 1.13l-5.05 1.3a1.6 1.6 0 0 0-1.15 1.15l-1.3 5.05a.6.6 0 0 1-1.13.07z",
    ],
  },
  {
    id: "draw",
    label: "Draw",
    shortcut: "D",
    paths: ["M16.5 4.5l3 3L8 19l-4 1 1-4z", "M14.5 6.5l3 3"],
  },
  {
    id: "note",
    label: "Note",
    shortcut: "N",
    paths: [
      "M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8l6-6V6a2 2 0 0 0-2-2z",
      "M14 20v-6h6",
    ],
  },
  {
    id: "text",
    label: "Text",
    shortcut: "T",
    paths: ["M5 6V4h14v2", "M9.5 20h5", "M12 4v16"],
  },
  {
    id: "section",
    label: "Section",
    shortcut: "S",
    paths: ["M4 9h16", "M4 15h16", "M9 4v16", "M15 4v16"],
  },
];
const FIT_ICON_PATHS = [
  "M8 3H5a2 2 0 0 0-2 2v3",
  "M21 8V5a2 2 0 0 0-2-2h-3",
  "M3 16v3a2 2 0 0 0 2 2h3",
  "M16 21h3a2 2 0 0 0 2-2v-3",
];
const NOTE_COLORS = ["#fef3c7", "#dcfce7", "#dbeafe", "#fae8ff", "#fee2e2"] as const;
const MIN_NOTE_SIZE = { width: 140, height: 96 };
const MIN_SECTION_SIZE = { width: 240, height: 160 };
const MIN_MEDIA_SIZE = { width: 80, height: 60 };
const MIN_TEXT_SIZE = { width: 32, height: 40 };
// Default footprint of a document-link card dropped on the canvas.
const DOC_CARD_SIZE = { width: 260, height: 64 };
const viewportRef = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLCanvasElement | null>(null);
const inkRef = ref<HTMLCanvasElement | null>(null);
const shapes = ref<CanvasShape[]>([]);
const strokes = ref<CanvasStroke[]>([]);
const selectedShapeIds = ref<Set<string>>(new Set());
const selectedStrokeIds = ref<Set<string>>(new Set());
// Live screen-space rectangle while drag-selecting; null when not marqueeing.
const marqueeRect = ref<Rect | null>(null);
// Alignment guides shown while dragging shapes; empty when no edge/center of
// the dragged group is snapped to another shape. Drawn on the ink overlay.
const activeSnapGuides = ref<SnapGuide[]>([]);
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
const noteColor = ref<string>(NOTE_COLORS[0]);
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
const saveError = ref<string | null>(null);
const isDarkMode = ref(false);
const localPointer = ref<{ x: number; y: number } | null>(null);
const remotePresences = ref(new Map<string, PresenceEnvelope<CanvasPresenceState>>());

const camera = ref<ViewportCamera>({ centerX: 0, centerY: 0, zoom: 1 });
const screen = ref<ScreenSize>({ width: 1, height: 1 });
const user = useUserProfile();
const { document: documentData, saveDocument } = useDocument(props.documentId, "canvas");
// Used to resolve a dropped/inserted document id to its slug + title, and to
// build navigation URLs for document-link cards.
const { documents } = useDocuments();
const { spaceSlug } = useRoute();

const roomId = props.documentId || crypto.randomUUID();
const presenceClientId = crypto.randomUUID();
const ydoc = new Y.Doc();
const yShapes = ydoc.getMap<Y.Map<unknown>>("canvas.shapes");
const yStrokes = ydoc.getMap<Y.Map<unknown>>("canvas.strokes");
// Tracks only local edits (default trackedOrigins = {null}); remote/agent
// updates arrive with origin "remote" and are excluded, so undo/redo only
// reverts this user's own changes.
const undoManager = new Y.UndoManager([yShapes, yStrokes]);

let leaveYjsRoom = () => {};
let leavePresenceRoom = () => {};
let presenceHandle: {
  update: (state: CanvasPresenceState) => void;
  leave: () => void;
} | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let dragState: DragState | null = null;
// True once a shape drag has actually moved the selection. Document-link cards
// read this to tell a click (open the document) from a drag (just reposition).
let dragMoved = false;
let freehandBuilder: FreehandStrokeBuilder | null = null;
let freehandPointerId: number | null = null;
const activeFreehandStroke = ref<FreehandStroke | null>(null);
// Screen-space position of the long-press context menu, null when hidden.
const contextMenuPos = ref<{ x: number; y: number } | null>(null);
// World-space insertion point captured when the context menu was opened.
let contextMenuInsertWorld: { x: number; y: number } | null = null;
// Raw client position of the most recent primary touch pointerdown. Used to
// detect movement before a contextmenu event so we don't open the menu when
// the user has actually started drawing or panning.
let touchDownClient: { x: number; y: number } | null = null;
// Set to true once the primary touch has moved beyond LONG_PRESS_SLOP_PX,
// so contextmenu events caused by iOS firing contextmenu despite small drags
// are suppressed.
let touchMovedPastSlop = false;
const LONG_PRESS_SLOP_PX = 10;
let isReady = false;
let hasSeededInitialContent = false;
let viewportControls: ViewportControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let colorSchemeMedia: MediaQueryList | null = null;
let dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

const remoteCanvasPresences = computed(() =>
  [...remotePresences.value.values()].filter(
    (presence) => presence.state?.kind === "canvas" && presence.state.pointer,
  ),
);

// Remote pointers arrive in discrete ~120ms presence updates; a CSS
// transition on the cursor smooths the jumps. While the local camera moves,
// the transition is suspended so cursors stay locked to the canvas instead
// of lagging behind the pan/zoom.
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
  return shapes.value.find((shape) => shape.id === id) ?? null;
});

// Screen-space top-center anchor for the multi-selection overlay. Returns null
// when fewer than 2 items are selected so the overlay stays hidden.
const selectionAnchorPos = computed(() => {
  const totalSelected = selectedShapeIds.value.size + selectedStrokeIds.value.size;
  if (totalSelected < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of selectedShapeIds.value) {
    const shape = shapes.value.find((s) => s.id === id);
    if (!shape) continue;
    minX = Math.min(minX, shape.x);
    minY = Math.min(minY, shape.y);
    maxX = Math.max(maxX, shape.x + shape.width);
    maxY = Math.max(maxY, shape.y + shape.height);
  }

  for (const id of selectedStrokeIds.value) {
    const stroke = strokes.value.find((s) => s.id === id);
    if (!stroke || stroke.points.length === 0) continue;
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!isFinite(minX)) return null;

  return worldToScreen({ x: (minX + maxX) / 2, y: minY });
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

// Text shapes lay themselves out with CSS (the box auto-sizes to its content),
// but the resulting size still has to live in the shape data: section
// containment, fit-to-content bounds, and remote clients all read it. A
// ResizeObserver on each text shape element writes the layout size back.
let textShapeObserver: ResizeObserver | null = null;
const observedTextShapes = new Map<Element, string>();

function syncTextShapeSize(id: string, element: HTMLElement) {
  const shape = yShapes.get(id);
  if (!shape) return;

  const width = Math.max(MIN_TEXT_SIZE.width, Math.ceil(element.offsetWidth));
  const height = Math.max(MIN_TEXT_SIZE.height, Math.ceil(element.offsetHeight));
  if (
    toNumber(shape.get("width"), 0) === width &&
    toNumber(shape.get("height"), 0) === height
  ) {
    return;
  }

  updateShape(id, { width, height });
}

function trackTextShapeSize(element: unknown, shape: CanvasShape) {
  if (shape.type !== "text") return;

  if (!(element instanceof HTMLElement)) {
    for (const [observed, id] of observedTextShapes) {
      if (id !== shape.id) continue;
      textShapeObserver?.unobserve(observed);
      observedTextShapes.delete(observed);
    }
    return;
  }

  if (observedTextShapes.get(element) === shape.id) return;
  if (!textShapeObserver && typeof ResizeObserver !== "undefined") {
    textShapeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = observedTextShapes.get(entry.target);
        if (id) syncTextShapeSize(id, entry.target as HTMLElement);
      }
    });
  }
  observedTextShapes.set(element, shape.id);
  textShapeObserver?.observe(element);
}

function toShape(id: string, source: Y.Map<unknown> | CanvasShape): CanvasShape {
  const read = (key: keyof CanvasShape) =>
    source instanceof Y.Map ? source.get(key) : source[key];

  const typeValue = read("type");
  const type: CanvasShapeType =
    typeValue === "text" ||
    typeValue === "note" ||
    typeValue === "image" ||
    typeValue === "video" ||
    typeValue === "section" ||
    typeValue === "document"
      ? typeValue
      : "note";

  const defaultWidth =
    type === "text" ? 220 : type === "section" ? 560 : type === "document" ? 260 : 240;
  const defaultHeight =
    type === "text" ? 88 : type === "section" ? 340 : type === "document" ? 64 : 150;
  return {
    id,
    type,
    x: toNumber(read("x"), 0),
    y: toNumber(read("y"), 0),
    width: Math.max(80, toNumber(read("width"), defaultWidth)),
    height: Math.max(48, toNumber(read("height"), defaultHeight)),
    text: typeof read("text") === "string" ? String(read("text")) : "",
    color: typeof read("color") === "string" ? String(read("color")) : defaultColor(type),
    src: typeof read("src") === "string" ? String(read("src")) : undefined,
    alt: typeof read("alt") === "string" ? String(read("alt")) : undefined,
    docId: typeof read("docId") === "string" ? String(read("docId")) : undefined,
    docSlug: typeof read("docSlug") === "string" ? String(read("docSlug")) : undefined,
    updatedAt: toNumber(read("updatedAt"), Date.now()),
  };
}

function isFreehandPoint(value: unknown): value is FreehandPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FreehandPoint).x === "number" &&
    typeof (value as FreehandPoint).y === "number"
  );
}

function cloneFreehandPoint(point: FreehandPoint): FreehandPoint {
  return {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
    time: point.time,
    velocity: point.velocity,
    width: point.width,
  };
}

function toStroke(
  id: string,
  source: Y.Map<unknown> | CanvasStrokeSnapshot,
): CanvasStroke {
  const read = (key: keyof CanvasStrokeSnapshot) =>
    source instanceof Y.Map ? source.get(key) : source[key];
  const pointsValue = read("points");
  const points = Array.isArray(pointsValue)
    ? pointsValue.filter(isFreehandPoint).map(cloneFreehandPoint)
    : [];
  const styleValue = read("style");
  const style =
    typeof styleValue === "object" && styleValue !== null
      ? { ...FREEHAND_STYLE, ...(styleValue as Partial<FreehandStrokeStyle>) }
      : FREEHAND_STYLE;
  // Persisted points already carry the widths computed while drawing.
  // Recomputing velocity widths here would depend on the viewer's current
  // zoom (and on the pre-layout 1×1 screen during initial load), so only
  // derive widths when none were stored.
  const options = freehandOptions(style);
  if (points.some((point) => point.width !== undefined)) {
    options.velocityWidth = undefined;
  }
  const stroke = buildFreehandStroke(points, options);
  return {
    id,
    updatedAt: toNumber(read("updatedAt"), Date.now()),
    ...stroke,
  };
}

function syncShapesFromY() {
  shapes.value = [...yShapes.entries()]
    .map(([id, value]) => toShape(id, value))
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

function defaultColor(type: CanvasShapeType) {
  if (type === "image") return "#ffffff";
  if (type === "video") return "#000000";
  if (type === "section") return "rgba(255, 255, 255, 0.02)";
  if (type === "text") return "#ffffff";
  // Theme-aware surface so the card reads correctly in light and dark mode.
  if (type === "document") return "var(--canvas-doc-bg)";
  return NOTE_COLORS[0];
}

function defaultText(type: CanvasShapeType) {
  if (type === "image" || type === "video") return "";
  if (type === "section") return "Section";
  if (type === "text") return "Text";
  if (type === "document") return "Untitled";
  return "Note";
}

function createShapeMap(shape: CanvasShape) {
  const map = new Y.Map<unknown>();
  map.set("type", shape.type);
  map.set("x", shape.x);
  map.set("y", shape.y);
  map.set("width", shape.width);
  map.set("height", shape.height);
  map.set("text", shape.text);
  map.set("color", shape.color);
  if (shape.src) map.set("src", shape.src);
  if (shape.alt) map.set("alt", shape.alt);
  if (shape.docId) map.set("docId", shape.docId);
  if (shape.docSlug) map.set("docSlug", shape.docSlug);
  map.set("updatedAt", shape.updatedAt);
  return map;
}

function createStrokeMap(stroke: CanvasStrokeSnapshot) {
  const map = new Y.Map<unknown>();
  map.set("points", stroke.points.map(cloneFreehandPoint));
  map.set("style", { ...stroke.style });
  map.set("updatedAt", stroke.updatedAt);
  return map;
}

function parseSnapshot(content: string | null | undefined): CanvasSnapshot | null {
  if (!content?.trim()) return null;
  try {
    const parsed = JSON.parse(content) as Partial<CanvasSnapshot>;
    if (!parsed || !Array.isArray(parsed.shapes)) return null;
    const strokes = Array.isArray(parsed.strokes)
      ? parsed.strokes
          .filter((stroke): stroke is CanvasStrokeSnapshot =>
            Boolean(
              stroke && typeof stroke.id === "string" && Array.isArray(stroke.points),
            ),
          )
          .map((stroke) => ({
            id: stroke.id,
            points: stroke.points.filter(isFreehandPoint).map(cloneFreehandPoint),
            style: { ...FREEHAND_STYLE, ...(stroke.style ?? {}) },
            updatedAt: toNumber(stroke.updatedAt, Date.now()),
          }))
      : [];
    return {
      version: 1,
      shapes: parsed.shapes
        .filter((shape): shape is CanvasShape =>
          Boolean(shape && typeof shape.id === "string"),
        )
        .map((shape) => toShape(shape.id, shape)),
      strokes,
    };
  } catch {
    return null;
  }
}

function seedFromSnapshot(snapshot: CanvasSnapshot | null) {
  if (!snapshot || yShapes.size > 0 || yStrokes.size > 0) return;
  // Origin "seed" keeps this out of the undo history (UndoManager tracks only
  // origin null) while still broadcasting to the room (origin !== "remote").
  ydoc.transact(() => {
    for (const shape of snapshot.shapes) {
      yShapes.set(shape.id, createShapeMap(shape));
    }
    for (const stroke of snapshot.strokes ?? []) {
      yStrokes.set(stroke.id, createStrokeMap(stroke));
    }
  }, "seed");
  syncShapesFromY();
  syncStrokesFromY();
}

function serializeSnapshot(): string {
  const snapshot: CanvasSnapshot = {
    version: 1,
    shapes: shapes.value.map((shape) => ({ ...shape })),
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
      detail: { status: saveState.value, error: saveError.value },
    }),
  );
}

async function manualSave() {
  if (!isReady) return;
  saveState.value = "saving";
  saveError.value = null;
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
    saveState.value = "error";
    saveError.value = err instanceof Error ? err.message : String(err);
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

function screenPoint(event: MouseEvent) {
  const rect = viewportRef.value?.getBoundingClientRect();
  return {
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0),
  };
}

const transform = computed(() =>
  buildTransform(camera.value, screen.value, FIT_REFERENCE),
);

// Panning (middle/right-drag) shows the grabbing hand; the select tool rests on
// the default arrow, while the content-placing tools use a crosshair.
const viewportCursor = computed(() => {
  if (isPanning.value) return "grabbing";
  if (activeTool.value === "select") return "default";
  return "crosshair";
});

function screenToWorld(point: { x: number; y: number }) {
  return viewportScreenToWorld(point.x, point.y, transform.value);
}

function worldToScreen(point: { x: number; y: number }) {
  return viewportWorldToScreen(point.x, point.y, transform.value);
}

function canvasCssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const source = viewportRef.value ?? document.documentElement;
  return getComputedStyle(source).getPropertyValue(name).trim() || fallback;
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
  renderGrid();
  renderInk();
}

function defaultInkColor() {
  return canvasCssVar("--canvas-ink-color", FREEHAND_STYLE.color);
}

function themedStroke(stroke: FreehandStroke): FreehandStroke {
  if (stroke.style.color !== FREEHAND_STYLE.color) {
    return stroke;
  }

  return {
    ...stroke,
    style: {
      ...stroke.style,
      color: defaultInkColor(),
    },
  };
}

function renderGrid() {
  const canvas = gridRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);
  drawWorldGrid(context, transform.value, screen.value, {
    levels: [
      {
        size: 40,
        color: canvasCssVar("--canvas-grid-minor", "rgba(15, 23, 42, 0.07)"),
        lineWidth: 1,
        minScreenSpacing: 8,
      },
      {
        size: 200,
        color: canvasCssVar("--canvas-grid-major", "rgba(15, 23, 42, 0.13)"),
        lineWidth: 1,
        minScreenSpacing: 24,
      },
    ],
  });
}

function renderInk() {
  const canvas = inkRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);
  for (const stroke of strokes.value) {
    drawFreehandStroke(context, themedStroke(stroke), transform.value);
  }
  if (activeFreehandStroke.value) {
    drawFreehandStroke(
      context,
      themedStroke(activeFreehandStroke.value),
      transform.value,
    );
  }
  drawStrokeSelection(context);
  drawSnapGuides(context, activeSnapGuides.value, transform.value, screen.value, {
    color: "#2563eb",
  });
}

function drawStrokeSelection(context: CanvasRenderingContext2D) {
  if (selectedStrokeIds.value.size === 0) return;

  context.save();
  context.strokeStyle = "#2563eb";
  context.lineWidth = 1.5;
  context.setLineDash([]);
  for (const id of selectedStrokeIds.value) {
    const stroke = strokes.value.find((s) => s.id === id);
    if (!stroke || stroke.points.length === 0) continue;
    drawFreehandOutline(context, stroke, transform.value, 4);
  }
  context.restore();
}

function resize() {
  const rect = viewportRef.value?.getBoundingClientRect();
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
  renderGrid();
  renderInk();
}

function presenceState(): CanvasPresenceState {
  return {
    kind: "canvas",
    pointer: localPointer.value,
    view: {
      x: camera.value.centerX,
      y: camera.value.centerY,
      scale: camera.value.zoom,
    },
    selectionIds: [...selectedShapeIds.value],
    focusedNodeId: selectedShape.value?.id ?? null,
    activeTool: activeTool.value,
  };
}

function updatePresence() {
  presenceHandle?.update(presenceState());
}

function setupPresence() {
  if (!user.value || presenceHandle) return;
  presenceHandle = joinPresenceRoom<CanvasPresenceState>(
    props.spaceId,
    roomId,
    presenceClientId,
    {
      id: user.value.id,
      name: user.value.name,
      image: user.value.image,
      color: getPresenceColor(user.value.id),
    },
    (event) => {
      const next = new Map(remotePresences.value);
      if (event.type === "presence-snapshot") {
        next.clear();
        for (const presence of event.presences) {
          if (presence.clientId !== presenceClientId)
            next.set(presence.clientId, presence);
        }
      } else if (event.type === "presence-update") {
        if (event.presence.clientId !== presenceClientId) {
          next.set(event.presence.clientId, event.presence);
        }
      } else {
        next.delete(event.clientId);
      }
      remotePresences.value = next;
    },
    presenceState(),
  );
  leavePresenceRoom = presenceHandle.leave;
  presenceTimer = setInterval(updatePresence, 120);
}

function isImageFile(file: File) {
  if (file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
}

function isVideoFile(file: File) {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
}

function isMediaFile(file: File) {
  return isVideoFile(file) || isImageFile(file);
}

function insertionPointFromEvent(event?: DragEvent | PointerEvent) {
  if (event) return screenToWorld(screenPoint(event));
  if (localPointer.value) return localPointer.value;
  return screenToWorld({
    x: screen.value.width / 2,
    y: screen.value.height / 2,
  });
}

async function uploadMediaFile(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file, file.name || "upload");
  if (props.documentId) formData.append("documentId", props.documentId);

  const response = await fetch(`/api/v1/spaces/${props.spaceId}/uploads`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const result = (await response.json()) as { url: string };
  return result.url;
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || 320,
        height: image.naturalHeight || 220,
      });
    image.onerror = () => resolve({ width: 320, height: 220 });
    image.src = src;
  });
}

function videoSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      resolve({
        width: video.videoWidth || 320,
        height: video.videoHeight || 220,
      });
    video.onerror = () => resolve({ width: 320, height: 220 });
    video.src = src;
  });
}

function fitImageSize(width: number, height: number) {
  const maxWidth = 480;
  const maxHeight = 360;
  const scale = Math.min(
    1,
    maxWidth / Math.max(1, width),
    maxHeight / Math.max(1, height),
  );
  return {
    width: Math.max(80, Math.round(width * scale)),
    height: Math.max(60, Math.round(height * scale)),
  };
}

async function addMediaFile(file: File, at: { x: number; y: number }) {
  if (!isMediaFile(file)) return;
  const type: CanvasShapeType = isVideoFile(file) ? "video" : "image";
  saveState.value = "saving";
  saveError.value = null;
  dispatchSaveStatus();

  try {
    const src = await uploadMediaFile(file);
    const naturalSize = await (type === "video" ? videoSize(src) : imageSize(src));
    const size = fitImageSize(naturalSize.width, naturalSize.height);
    const id = `shape-${crypto.randomUUID()}`;
    const shape: CanvasShape = {
      id,
      type,
      x: Math.round(at.x - size.width / 2),
      y: Math.round(at.y - size.height / 2),
      width: size.width,
      height: size.height,
      text: "",
      color: defaultColor(type),
      src,
      alt: file.name,
      updatedAt: Date.now(),
    };
    yShapes.set(id, createShapeMap(shape));
    selectOnlyShape(id);
    activeTool.value = "select";
    saveState.value = "idle";
    dispatchSaveStatus();
  } catch (err) {
    saveState.value = "error";
    saveError.value = err instanceof Error ? err.message : String(err);
    dispatchSaveStatus();
  }
}

function mediaFilesFromList(files: FileList | File[]) {
  return Array.from(files).filter(isMediaFile);
}

async function addMediaFiles(files: File[], at: { x: number; y: number }) {
  let offset = 0;
  for (const file of files) {
    await addMediaFile(file, { x: at.x + offset, y: at.y + offset });
    offset += 24;
  }
}

function documentLabel(doc: { properties?: { title?: string | null } | null }): string {
  const title = doc.properties?.title;
  return title?.trim() ? title.trim() : "Untitled";
}

// Places a card on the canvas that links to another document. Returns false if
// the id doesn't resolve to a known document (e.g. a stray text drag), so the
// caller can leave the drop to the browser.
function insertDocumentLink(documentId: string, at: { x: number; y: number }): boolean {
  const doc = documents.value.find((entry) => entry.id === documentId);
  if (!doc) return false;
  const id = `shape-${crypto.randomUUID()}`;
  const shape: CanvasShape = {
    id,
    type: "document",
    x: Math.round(at.x - DOC_CARD_SIZE.width / 2),
    y: Math.round(at.y - DOC_CARD_SIZE.height / 2),
    width: DOC_CARD_SIZE.width,
    height: DOC_CARD_SIZE.height,
    text: documentLabel(doc),
    color: defaultColor("document"),
    docId: doc.id,
    docSlug: doc.slug ?? undefined,
    updatedAt: Date.now(),
  };
  yShapes.set(id, createShapeMap(shape));
  selectOnlyShape(id);
  activeTool.value = "select";
  return true;
}

function documentShapeHref(shape: CanvasShape): string | undefined {
  if (!shape.docSlug) return undefined;
  return spaceSlug.value
    ? `/${spaceSlug.value}/doc/${shape.docSlug}`
    : `/doc/${shape.docSlug}`;
}

// The card is an anchor, so navigation is native — we only intervene to swallow
// the click when the pointer was actually dragging the card, or when the card
// has no resolvable target.
function onDocumentShapeClick(shape: CanvasShape, event: MouseEvent) {
  if (dragMoved || !documentShapeHref(shape)) event.preventDefault();
}

function addShape(type: CanvasShapeType, at: { x: number; y: number }) {
  const id = `shape-${crypto.randomUUID()}`;
  const text = defaultText(type);
  const shape: CanvasShape = {
    id,
    type,
    x: Math.round(at.x),
    y: Math.round(at.y),
    // Text shapes auto-size to their content; the observer corrects this
    // placeholder right after mount.
    width: type === "text" ? MIN_TEXT_SIZE.width : type === "section" ? 560 : 240,
    height: type === "text" ? MIN_TEXT_SIZE.height : type === "section" ? 340 : 150,
    text,
    color: type === "note" ? noteColor.value : defaultColor(type),
    updatedAt: Date.now(),
  };
  yShapes.set(id, createShapeMap(shape));
  selectOnlyShape(id);
  activeTool.value = "select";
  nextTick(() => {
    const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      type === "section" ? `[data-section-title="${id}"]` : `[data-shape-text="${id}"]`,
    );
    input?.focus();
    input?.select();
  });
}

function updateShapeText(shape: CanvasShape, text: string) {
  updateShape(shape.id, { text });
}

function handleTextBlur(shape: CanvasShape, event: FocusEvent) {
  // A text element with no content has nothing to anchor it, so remove it once
  // editing ends. Notes and sections keep their box even when empty.
  if (shape.type !== "text") return;
  const value = (event.target as HTMLTextAreaElement).value;
  if (value.trim() !== "") return;
  yShapes.delete(shape.id);
  if (selectedShapeIds.value.has(shape.id)) {
    selectedShapeIds.value.delete(shape.id);
    selectedShapeIds.value = new Set(selectedShapeIds.value);
  }
}

function isShapeInsideSection(shape: CanvasShape, section: CanvasShape) {
  if (shape.id === section.id) return false;
  return (
    shape.x >= section.x &&
    shape.y >= section.y &&
    shape.x + shape.width <= section.x + section.width &&
    shape.y + shape.height <= section.y + section.height
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
  if (selectedShape.value?.type === "note") {
    updateShape(selectedShape.value.id, { color });
  }
}

function updateShape(id: string, patch: Partial<Omit<CanvasShape, "id">>) {
  const shape = yShapes.get(id);
  if (!shape) return;
  shape.set("updatedAt", Date.now());
  for (const [key, value] of Object.entries(patch)) {
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

function distanceToSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function strokeHitTest(world: { x: number; y: number }): string | null {
  const scale = transform.value.scale || 1;
  // Search topmost (last drawn) first.
  for (let i = strokes.value.length - 1; i >= 0; i -= 1) {
    const stroke = strokes.value[i];
    const points = stroke.points;
    const threshold = stroke.style.width / 2 + 8 / scale;
    if (points.length === 1) {
      if (Math.hypot(world.x - points[0].x, world.y - points[0].y) <= threshold) {
        return stroke.id;
      }
      continue;
    }
    for (let j = 1; j < points.length; j += 1) {
      if (distanceToSegment(world, points[j - 1], points[j]) <= threshold) {
        return stroke.id;
      }
    }
  }
  return null;
}

function freehandPoint(event: PointerEvent): FreehandPoint {
  const point = screenToWorld(screenPoint(event));
  // Only trust pressure from a stylus. Mice report a constant 0.5 while a button
  // is held, and touch rarely reports meaningful pressure, so for those inputs
  // width falls back to velocity-based tapering.
  const hasStylusPressure = event.pointerType === "pen" && event.pressure > 0;
  return {
    x: point.x,
    y: point.y,
    pressure: hasStylusPressure ? event.pressure : undefined,
    time: event.timeStamp,
  };
}

function startFreehand(event: PointerEvent) {
  if (event.button !== 0 || (event.pointerType === "touch" && !event.isPrimary)) return;
  clearSelection();
  freehandPointerId = event.pointerId;
  freehandBuilder = createFreehandStrokeBuilder(freehandOptions());
  activeFreehandStroke.value = freehandBuilder.startAt(freehandPoint(event));
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function finishFreehand(event: PointerEvent) {
  if (!freehandBuilder || freehandPointerId !== event.pointerId) return;
  const finished = freehandBuilder.finish();
  if (finished.points.length > 0) {
    const id = `stroke-${crypto.randomUUID()}`;
    yStrokes.set(
      id,
      createStrokeMap({
        id,
        points: finished.points.map(cloneFreehandPoint),
        style: { ...finished.style },
        updatedAt: Date.now(),
      }),
    );
  }
  freehandBuilder = null;
  freehandPointerId = null;
  activeFreehandStroke.value = null;
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
    const shape = shapes.value.find((s) => s.id === id);
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
    const stroke = strokes.value.find((s) => s.id === id);
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
  const isMedia = shape.type === "image" || shape.type === "video";
  dragState = {
    type: "resize",
    pointerId: event.pointerId,
    shapeId: shape.id,
    startPointer: screenToWorld(screenPoint(event)),
    startSize: { width: shape.width, height: shape.height },
    minSize:
      shape.type === "section"
        ? MIN_SECTION_SIZE
        : isMedia
          ? MIN_MEDIA_SIZE
          : MIN_NOTE_SIZE,
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
    const bounds: Rect = {
      x: shape.x,
      y: shape.y,
      width: shape.width,
      height: shape.height,
    };
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

  // Reset touch movement tracking so contextmenu events on this touch
  // can be checked against how far the finger actually moved.
  if (event.pointerType === "touch") {
    touchDownClient = { x: event.clientX, y: event.clientY };
    touchMovedPastSlop = false;
  }

  // The handlers below call preventDefault(), which suppresses the browser's
  // default focus shift — so without this the canvas never holds focus and
  // copy/cut/paste events are never dispatched to it. Shape/text pointerdowns
  // use @pointerdown.stop, so this only fires for empty-canvas/stroke clicks
  // and won't pull focus out of a text shape being edited.
  viewportRef.value?.focus({ preventScroll: true });

  const point = screenPoint(event);
  localPointer.value = screenToWorld(point);

  if (event.button === 1 || event.button === 2) {
    startPan(event);
    event.preventDefault();
    return;
  }

  if (activeTool.value === "select") {
    const additive = event.shiftKey;
    const hitStroke = strokeHitTest(screenToWorld(point));
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

  addShape(activeTool.value, screenToWorld(point));
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
    const shape = shapes.value.find((s) => s.id === moved.id);
    if (!shape) continue;
    minX = Math.min(minX, moved.x);
    minY = Math.min(minY, moved.y);
    maxX = Math.max(maxX, moved.x + shape.width);
    maxY = Math.max(maxY, moved.y + shape.height);
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
    activeSnapGuides.value = [];
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
      (shape) =>
        !movingIds.has(shape.id) &&
        rectsIntersect(near, {
          x: shape.x,
          y: shape.y,
          width: shape.width,
          height: shape.height,
        }),
    )
    .map((shape) => ({
      id: shape.id,
      bounds: { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
    }));

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

  activeSnapGuides.value = snap.guides;
  return { dx: dx + snap.dx, dy: dy + snap.dy };
}

function handlePointerMove(event: PointerEvent) {
  const point = screenPoint(event);
  localPointer.value = screenToWorld(point);

  // Track whether the primary touch has moved enough to be a drag/stroke
  // rather than a hold.  We check this in handleContextMenu to suppress the
  // context menu when the user is actually drawing.
  if (event.pointerType === "touch" && event.isPrimary && touchDownClient && !touchMovedPastSlop) {
    const dx = event.clientX - touchDownClient.x;
    const dy = event.clientY - touchDownClient.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) {
      touchMovedPastSlop = true;
    }
  }

  if (freehandBuilder && freehandPointerId === event.pointerId) {
    activeFreehandStroke.value = freehandBuilder.addPoint(freehandPoint(event));
    renderInk();
    event.preventDefault();
    return;
  }

  if (!dragState || dragState.pointerId !== event.pointerId) {
    updatePresence();
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
    updatePresence();
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
    updatePresence();
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
  renderInk();
}

function handlePointerUp(event: PointerEvent) {
  finishFreehand(event);
  if (dragState?.pointerId === event.pointerId) {
    if (dragState.type === "marquee") marqueeRect.value = null;
    if (dragState.type === "pan") isPanning.value = false;
    if (activeSnapGuides.value.length > 0) {
      activeSnapGuides.value = [];
      renderInk();
    }
    dragState = null;
  }
}

function handlePointerLeave() {
  localPointer.value = null;
  updatePresence();
}

// During dragover the browser hides file contents (dataTransfer.files is
// empty); only item kind/type metadata is available to decide acceptance.
function dragHasMediaFiles(transfer: DataTransfer | null) {
  if (!transfer) return false;
  if (transfer.items.length > 0) {
    return Array.from(transfer.items).some(
      (item) =>
        item.kind === "file" &&
        (item.type === "" ||
          item.type.startsWith("image/") ||
          item.type.startsWith("video/")),
    );
  }
  return transfer.types.includes("Files");
}

// Documents dragged from the sidebar/command palette carry their id as
// `text/plain` (see page-target.ts). The actual id can't be read during
// dragover, so accept any plain-text drag here and verify it on drop.
function dragHasDocumentLink(transfer: DataTransfer | null) {
  return Boolean(transfer?.types.includes("text/plain"));
}

function handleDragOver(event: DragEvent) {
  const hasMedia = dragHasMediaFiles(event.dataTransfer);
  if (!hasMedia && !dragHasDocumentLink(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) {
    // Document drags from the sidebar/palette advertise effectAllowed "move";
    // a mismatched "copy" dropEffect makes the browser reject the drop, so we
    // mirror "move" for those. OS file drops carry copy semantics.
    event.dataTransfer.dropEffect = hasMedia ? "copy" : "move";
  }
}

function handleDrop(event: DragEvent) {
  if (dragHasMediaFiles(event.dataTransfer)) {
    // Prevent the browser from navigating to the file even when the dropped
    // files turn out not to be media we can place.
    event.preventDefault();
    const media = mediaFilesFromList(clipboardFiles(event.dataTransfer));
    if (media.length > 0) void addMediaFiles(media, insertionPointFromEvent(event));
    return;
  }

  // A document dragged from the sidebar or command palette becomes a link card.
  const droppedId = event.dataTransfer?.getData("text/plain")?.trim();
  if (droppedId && insertDocumentLink(droppedId, insertionPointFromEvent(event))) {
    event.preventDefault();
  }
}

function handleContextMenu(event: MouseEvent) {
  // Always prevent the native context menu / iOS callout.
  event.preventDefault();
  if (!viewportRef.value) return;

  // Don't open the menu if the user was drawing or has moved their finger —
  // the long-press just fired because iOS' own slop threshold is tighter than
  // ours.  In both cases the pointer events continue uninterrupted.
  if (freehandBuilder || touchMovedPastSlop) return;

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

  const text = await navigator.clipboard.readText().catch(() => null);
  if (text !== null) {
    const payload = parseCanvasClipboard(text);
    if (payload) {
      pasteCanvasClipboard(payload, insertAt);
      return;
    }
  }

  const internal = parseCanvasClipboard(internalClipboard);
  if (internal) pasteCanvasClipboard(internal, insertAt);
}

// Portable clipboard payload — written to the system clipboard as JSON so a
// copy in one tab/browser can be pasted into another. Kept as an in-memory
// fallback for non-secure contexts where the Clipboard API is unavailable.
const CANVAS_CLIPBOARD_MARKER = "vektor-canvas-clipboard";
type CanvasClipboard = {
  "vektor-canvas-clipboard": 1;
  shapes: CanvasShape[];
  strokes: CanvasStrokeSnapshot[];
};
let internalClipboard: string | null = null;

function collectSelection(): { shapes: CanvasShape[]; strokes: CanvasStrokeSnapshot[] } {
  const selShapes = shapes.value
    .filter((shape) => selectedShapeIds.value.has(shape.id))
    .map((shape) => ({ ...shape }));
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

/** Serializes the current selection to a portable JSON string, or null if nothing is selected. */
function serializeSelection(): string | null {
  const selection = collectSelection();
  if (selection.shapes.length === 0 && selection.strokes.length === 0) return null;
  return JSON.stringify({
    [CANVAS_CLIPBOARD_MARKER]: 1,
    ...selection,
  } satisfies CanvasClipboard);
}

/** True when the user has a real text selection (let the browser copy that instead). */
function hasActiveTextSelection(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.closest("textarea, input, select")) return true;
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

// Native clipboard events: synchronous, no permission prompt, and the JSON
// lands in the system clipboard so it pastes across tabs and browsers.
function handleCopy(event: ClipboardEvent) {
  if (hasActiveTextSelection(event.target)) return;
  const json = serializeSelection();
  if (!json) return;
  event.preventDefault();
  event.clipboardData?.setData("text/plain", json);
  internalClipboard = json;
}

function handleCut(event: ClipboardEvent) {
  if (hasActiveTextSelection(event.target)) return;
  const json = serializeSelection();
  if (!json) return;
  event.preventDefault();
  event.clipboardData?.setData("text/plain", json);
  internalClipboard = json;
  deleteSelectedShape();
}

function copySelectionToClipboard() {
  const json = serializeSelection();
  if (!json) return;
  internalClipboard = json;
  navigator.clipboard?.writeText(json).catch(() => {});
}

function cutSelectionToClipboard() {
  const json = serializeSelection();
  if (!json) return;
  internalClipboard = json;
  navigator.clipboard?.writeText(json).catch(() => {});
  deleteSelectedShape();
}

function parseCanvasClipboard(text: string | null | undefined): CanvasClipboard | null {
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

function handlePaste(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input, select")) return;

  // The system clipboard is authoritative — it reflects the *latest* copy from
  // anywhere. Check it before the in-memory fallback so copying something new
  // (an image, other text) overrides a previously-copied canvas element.
  const text = event.clipboardData?.getData("text/plain") ?? "";

  // 1. Our own canvas elements (portable JSON in the clipboard text).
  const payload = parseCanvasClipboard(text);
  if (payload) {
    event.preventDefault();
    pasteCanvasClipboard(payload, insertionPointFromEvent());
    return;
  }

  // 2. Images / video pasted from the clipboard.
  const media = mediaFilesFromList(clipboardFiles(event.clipboardData));
  if (media.length > 0) {
    event.preventDefault();
    void addMediaFiles(media, insertionPointFromEvent());
    return;
  }

  // 3. The clipboard holds some other real content (plain text, etc.) that
  //    isn't ours — leave it to the browser, don't paste a stale element.
  if (text.trim().length > 0) return;

  // 4. The system clipboard gave us nothing usable (e.g. a non-secure context
  //    where clipboardData is unavailable). Fall back to the last canvas copy
  //    held in memory.
  const internal = parseCanvasClipboard(internalClipboard);
  if (internal) {
    event.preventDefault();
    pasteCanvasClipboard(internal, insertionPointFromEvent());
  }
}

// Images on the clipboard (e.g. a screenshot or "copy image") may arrive in
// `files`, in `items` as a file entry, or both. Collect from both and dedupe so
// a single pasted image isn't inserted twice.
function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The canvas renders full-bleed behind the fixed navigation sidebar, so the
// left `inset` px of the viewport are occluded by the nav. Fit-to-view must
// frame content within the *visible* region instead of the full viewport.
function reservedSidebarWidth(): number {
  if (typeof window === "undefined") return 0;
  // Below the lg breakpoint the sidebar is an overlay drawer and reserves no space.
  if (!window.matchMedia("(min-width: 1024px)").matches) return 0;
  const rect = document.querySelector(".sidebar")?.getBoundingClientRect();
  return Math.max(0, rect?.right ?? 0);
}

function fitView(maxZoom = 5) {
  const xs = [
    ...shapes.value.flatMap((shape) => [shape.x, shape.x + shape.width]),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...shapes.value.flatMap((shape) => [shape.y, shape.y + shape.height]),
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
  if (key === "f") fitView();
}

watch(
  () => documentData.value?.content,
  (content) => {
    if (hasSeededInitialContent || yShapes.size > 0 || yStrokes.size > 0) return;
    hasSeededInitialContent = true;
    seedFromSnapshot(parseSnapshot(content));
  },
  { immediate: true },
);

watch(user, setupPresence);
watch(
  [camera, screen],
  () => {
    renderGrid();
    renderInk();
    updatePresence();
  },
  { deep: true },
);

onMounted(() => {
  yShapes.observeDeep((_events, transaction) => {
    syncShapesFromY();
    scheduleSave();
    refreshUndoState();
    fitInitialViewIfNeeded(transaction.origin !== null);
  });
  yStrokes.observeDeep((_events, transaction) => {
    syncStrokesFromY();
    scheduleSave();
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
      dragState = null;
      isPanning.value = false;
      freehandBuilder = null;
      freehandPointerId = null;
      activeFreehandStroke.value = null;
      renderInk();
    },
    minZoom: 0.25,
    maxZoom: 5,
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

  if (props.documentId) {
    leaveYjsRoom = joinYjsRoom(props.spaceId, props.documentId, ydoc);
  }

  setupPresence();
  isReady = true;
  // Content already present at mount (seeded synchronously or preloaded from
  // the Yjs room) is initial — frame it now that the screen has been measured.
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
  leavePresenceRoom();
  leaveYjsRoom();
  undoManager.destroy();
  ydoc.destroy();
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerUp);
  window.removeEventListener("copy", handleCopy);
  window.removeEventListener("cut", handleCut);
  window.removeEventListener("paste", handlePaste);
  if (saveTimer) clearTimeout(saveTimer);
  if (saveStateTimer) clearTimeout(saveStateTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
});
</script>

<template>
  <div class="canvas-root" :class="{ 'is-dark': isDarkMode }">
    <div class="canvas-toolbar" @pointerdown.stop>
      <button
        v-for="tool in CANVAS_TOOLS"
        :key="tool.id"
        type="button"
        class="canvas-tool"
        :class="{ active: activeTool === tool.id }"
        :aria-label="tool.label"
        :aria-pressed="activeTool === tool.id"
        :data-tooltip="`${tool.label} · ${tool.shortcut}`"
        @click="activeTool = tool.id"
      >
        <svg
          class="canvas-tool-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path v-for="(d, i) in tool.paths" :key="i" :d="d" />
        </svg>
      </button>
      <span
        v-if="activeTool === 'note' || selectedShape?.type === 'note'"
        class="canvas-note-colors"
        aria-label="Note color"
      >
        <button
          v-for="color in NOTE_COLORS"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: (selectedShape?.type === 'note' ? selectedShape.color : noteColor) === color }"
          :style="{ background: color }"
          :aria-label="`Set note color ${color}`"
          @click="setNoteColor(color)"
        ></button>
      </span>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        aria-label="Undo"
        data-tooltip="Undo · ⌘Z"
        :disabled="!canUndo"
        @click="undo"
      >
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="undoArrowIcon" />
      </button>
      <button
        type="button"
        class="canvas-tool"
        aria-label="Redo"
        data-tooltip="Redo · ⌘⇧Z"
        :disabled="!canRedo"
        @click="redo"
      >
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="redoArrowIcon" />
      </button>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        aria-label="Fit to view"
        data-tooltip="Fit to view · F"
        @click="fitView()"
      >
        <svg
          class="canvas-tool-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path v-for="(d, i) in FIT_ICON_PATHS" :key="i" :d="d" />
        </svg>
      </button>
      <span v-if="saveState === 'error'" class="canvas-save-state error">{{ saveError }}</span>
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
      <canvas ref="inkRef" class="canvas-ink"></canvas>
      <div
        class="canvas-world"
        :style="{
          transform: `translate(${transform.dx}px, ${transform.dy}px) scale(${transform.scale})`,
        }"
      >
        <article
          v-for="shape in shapes"
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
            background: shape.color,
          }"
          :ref="(el) => trackTextShapeSize(el, shape)"
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
              aria-label="Section headline"
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
            v-if="shape.type === 'image' && shape.src"
            class="canvas-shape-image"
            :src="shape.src"
            :alt="shape.alt || ''"
            draggable="false"
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
          <a
            v-else-if="shape.type === 'document'"
            class="canvas-shape-doc"
            :href="documentShapeHref(shape)"
            draggable="false"
            @pointerdown.stop="startShapeDrag(shape, $event)"
            @dragstart.prevent
            @click="onDocumentShapeClick(shape, $event)"
          >
            <span class="svg-icon canvas-shape-doc-icon" v-html="documentIcon"></span>
            <span class="canvas-shape-doc-title">{{ shape.text || "Untitled" }}</span>
            <span class="svg-icon canvas-shape-doc-open" v-html="chevronRightThinIcon"></span>
          </a>
          <div
            v-else-if="shape.type !== 'section'"
            class="canvas-shape-textwrap"
            :data-replicated-value="shape.text"
          >
            <textarea
              class="canvas-shape-text"
              :data-shape-text="shape.id"
              :value="shape.text"
              spellcheck="false"
              @focus="selectOnlyShape(shape.id)"
              @blur="handleTextBlur(shape, $event)"
              @pointerdown.stop="shape.type === 'text' && startShapeDrag(shape, $event)"
              @input="updateShapeText(shape, ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
          </div>
          <button
            v-if="shape.type !== 'text' && selectedShape?.id === shape.id"
            type="button"
            class="canvas-resize-handle"
            :aria-label="`Resize ${shape.type}`"
            @pointerdown.stop="startShapeResize(shape, $event)"
          ></button>
        </article>
      </div>

      <div
        v-for="presence in remoteCanvasPresences"
        :key="presence.clientId"
        class="canvas-presence"
        :class="{ 'is-instant': isCameraMoving }"
        :style="{
          transform: `translate(${worldToScreen(presence.state!.pointer!).x}px, ${worldToScreen(presence.state!.pointer!).y}px)`,
          '--presence-color': presence.user.color || getPresenceColor(presence.user.id),
        }"
      >
        <span class="canvas-presence-cursor"></span>
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
          aria-label="Copy"
          data-tooltip="Copy · ⌘C"
          @click="copySelectionToClipboard"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="copyIcon" />
        </button>
        <button
          type="button"
          class="canvas-tool"
          aria-label="Cut"
          data-tooltip="Cut · ⌘X"
          @click="cutSelectionToClipboard"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="scissorsIcon" />
        </button>
        <span class="canvas-divider"></span>
        <button
          type="button"
          class="canvas-tool danger"
          aria-label="Delete"
          data-tooltip="Delete · ⌫"
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
            aria-label="Copy"
            @click="copySelectionToClipboard(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="copyIcon" />
          </button>
          <button
            type="button"
            class="canvas-tool"
            aria-label="Cut"
            @click="cutSelectionToClipboard(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="scissorsIcon" />
          </button>
          <span class="canvas-divider"></span>
        </template>
        <button
          type="button"
          class="canvas-tool"
          aria-label="Paste"
          @click="pasteFromContextMenu"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="clipboardDocumentIcon" />
        </button>
        <template v-if="selectedShapeIds.size > 0 || selectedStrokeIds.size > 0">
          <span class="canvas-divider"></span>
          <button
            type="button"
            class="canvas-tool danger"
            aria-label="Delete"
            @click="deleteSelectedShape(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="trashIcon" />
          </button>
        </template>
      </div>

      <div v-if="shapes.length === 0 && strokes.length === 0" class="canvas-empty">
        <strong>Blank canvas</strong>
        <span>Choose Draw, Note, Text, or Section, then use the canvas.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.canvas-root {
  --canvas-bg: #f8fafc;
  --canvas-text: #111827;
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
  --canvas-tooltip-bg: #111827;
  --canvas-tooltip-text: #f9fafb;
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
  :global(:root:not([data-theme])) .canvas-root {
    --canvas-bg: #0f1115;
    --canvas-text: #f3f4f6;
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
    --canvas-tooltip-bg: #e5e7eb;
    --canvas-tooltip-text: #111827;
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
    --canvas-resize-border: rgba(255, 255, 255, 0.58);
    --canvas-presence-text: #111827;
  }
}

.canvas-root.is-dark,
:global(:root[data-theme="dark"]) .canvas-root {
  --canvas-bg: #0f1115;
  --canvas-text: #f3f4f6;
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
  --canvas-tooltip-bg: #e5e7eb;
  --canvas-tooltip-text: #111827;
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
  --canvas-resize-border: rgba(255, 255, 255, 0.58);
  --canvas-presence-text: #111827;
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

/* Hover tooltip that escapes the toolbar (above the button). */
.canvas-tool[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 9px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  padding: 5px 9px;
  border-radius: 7px;
  background: var(--canvas-tooltip-bg);
  color: var(--canvas-tooltip-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.28);
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.canvas-tool[data-tooltip]::before {
  content: "";
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%) translateY(4px);
  border: 5px solid transparent;
  border-top-color: var(--canvas-tooltip-bg);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.canvas-tool[data-tooltip]:hover::after,
.canvas-tool[data-tooltip]:hover::before {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
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

.canvas-save-state {
  color: #047857;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.canvas-save-state.error {
  max-width: 320px;
  overflow: hidden;
  color: #b91c1c;
  text-overflow: ellipsis;
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
.canvas-shape-text,
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
.canvas-ink {
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
}

.canvas-shape.selected {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.canvas-shape.text {
  min-width: 32px;
  min-height: 40px;
  border-color: transparent;
  background: transparent !important;
  box-shadow: none;
}

.canvas-shape.image,
.canvas-shape.video {
  border-color: transparent;
  background: var(--canvas-image-bg);
}

.canvas-shape.image .canvas-shape-image,
.canvas-shape.video .canvas-shape-image {
  cursor: move;
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

.canvas-shape.section.selected {
  outline-offset: 4px;
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

/* Document-link card: a draggable surface whose body is a click-to-open
   anchor. */
.canvas-shape.document {
  cursor: pointer;
}

.canvas-shape-doc {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 0 14px;
  color: var(--canvas-text);
  text-decoration: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.canvas-shape-doc-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--canvas-doc-accent);
}

.canvas-shape-doc-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-shape-doc-open {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  opacity: 0.45;
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
}

.canvas-shape-text {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  background: transparent;
  padding: 10px 12px;
  color: var(--canvas-text);
  font: inherit;
  font-size: 15px;
  line-height: 1.35;
  outline: none;
  overflow: hidden;
  resize: none;
}

/* Text shapes auto-size to their content: a hidden replica of the text (the
   ::after) sizes the box, and the textarea is overlaid on top of it. Both
   share the same styles, so the box always fits the text exactly. */
.canvas-shape.text .canvas-shape-textwrap {
  position: relative;
  display: block;
}

.canvas-shape.text .canvas-shape-textwrap::after {
  content: attr(data-replicated-value) " ";
  display: block;
  visibility: hidden;
  white-space: pre;
}

.canvas-shape.text .canvas-shape-text,
.canvas-shape.text .canvas-shape-textwrap::after {
  box-sizing: border-box;
  padding: 10px 12px;
  font: inherit;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.35;
}

.canvas-shape.text .canvas-shape-text {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: move;
}

.canvas-shape.note .canvas-shape-text {
  color: #111827;
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
  width: 0;
  height: 0;
  border-top: 14px solid var(--presence-color);
  border-right: 9px solid transparent;
  filter: drop-shadow(0 1px 1px rgba(15, 23, 42, 0.25));
}

.canvas-presence-label {
  position: absolute;
  left: 10px;
  top: 12px;
  border-radius: 4px;
  background: var(--presence-color);
  padding: 3px 6px;
  color: var(--canvas-presence-text);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.canvas-empty {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transform: translate(-50%, -50%);
  color: var(--canvas-muted);
  text-align: center;
  pointer-events: none;
}

.canvas-empty strong {
  color: var(--canvas-strong);
  font-size: 16px;
}
</style>
