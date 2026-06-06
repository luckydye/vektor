<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import * as Y from "yjs";
import { joinPresenceRoom, joinYjsRoom } from "../utils/sync.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import type { PresenceEnvelope } from "../utils/realtime.ts";
import {
  buildTransform,
  buildFreehandStroke,
  createViewportControls,
  createFreehandStrokeBuilder,
  drawFreehandStroke,
  drawWorldGrid,
  panCameraByScreenDelta,
  screenToWorld as viewportScreenToWorld,
  worldToScreen as viewportWorldToScreen,
  type FitReference,
  type FreehandPoint,
  type FreehandStroke,
  type FreehandStrokeBuilder,
  type FreehandStrokeOptions,
  type FreehandStrokeStyle,
  type ScreenSize,
  type ViewportCamera,
  type ViewportControls,
} from "../viewport/index.ts";
import { undoArrowIcon, redoArrowIcon } from "~/src/assets/icons.ts";

const props = defineProps<{
  spaceId: string;
  documentId?: string;
}>();

type CanvasTool = "select" | "draw" | "note" | "text" | "section";
type CanvasShapeType = "note" | "text" | "image" | "video" | "section";

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
      shapeId: string;
      startPointer: { x: number; y: number };
      startShape: { x: number; y: number };
      containedShapes: { id: string; x: number; y: number }[];
      containedStrokes: { id: string; points: FreehandPoint[] }[];
    }
  | {
      type: "resize";
      pointerId: number;
      shapeId: string;
      startPointer: { x: number; y: number };
      startSize: { width: number; height: number };
      minSize: { width: number; height: number };
    }
  | {
      type: "pan";
      pointerId: number;
      startPointer: { x: number; y: number };
      startCamera: ViewportCamera;
    };

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
function freehandOptions(style: FreehandStrokeStyle = FREEHAND_STYLE): FreehandStrokeOptions {
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
    paths: ["M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8l6-6V6a2 2 0 0 0-2-2z", "M14 20v-6h6"],
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
const MIN_TEXT_SIZE = { width: 32, height: 40 };
const viewportRef = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLCanvasElement | null>(null);
const inkRef = ref<HTMLCanvasElement | null>(null);
const shapes = ref<CanvasShape[]>([]);
const strokes = ref<CanvasStroke[]>([]);
const selectedShapeId = ref<string | null>(null);
const selectedStrokeId = ref<string | null>(null);
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
let presenceHandle: { update: (state: CanvasPresenceState) => void; leave: () => void } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let dragState: DragState | null = null;
let freehandBuilder: FreehandStrokeBuilder | null = null;
let freehandPointerId: number | null = null;
const activeFreehandStroke = ref<FreehandStroke | null>(null);
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
const selectedShape = computed(() =>
  selectedShapeId.value
    ? shapes.value.find((shape) => shape.id === selectedShapeId.value) ?? null
    : null,
);

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

function measureTextShape(text: string) {
  if (typeof document === "undefined") {
    return { ...MIN_TEXT_SIZE };
  }

  const measure = document.createElement("div");
  measure.className = "canvas-text-measure";
  measure.textContent = text || "Text";
  document.body.appendChild(measure);
  const rect = measure.getBoundingClientRect();
  measure.remove();

  return {
    width: Math.max(MIN_TEXT_SIZE.width, Math.ceil(rect.width)),
    height: Math.max(MIN_TEXT_SIZE.height, Math.ceil(rect.height)),
  };
}

function resizeTextShapeToContent(id: string, text: string) {
  const shape = yShapes.get(id);
  if (!shape) return;

  const nextSize = measureTextShape(text);
  const width = toNumber(shape.get("width"), 0);
  const height = toNumber(shape.get("height"), 0);
  if (width === nextSize.width && height === nextSize.height) {
    return;
  }

  updateShape(id, nextSize);
}

function resizeAllTextShapesToContent() {
  for (const shape of shapes.value) {
    if (shape.type === "text") {
      resizeTextShapeToContent(shape.id, shape.text);
    }
  }
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
    typeValue === "section"
      ? typeValue
      : "note";

  const defaultWidth = type === "text" ? 220 : type === "section" ? 560 : 240;
  const defaultHeight = type === "text" ? 88 : type === "section" ? 340 : 150;
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

function toStroke(id: string, source: Y.Map<unknown> | CanvasStrokeSnapshot): CanvasStroke {
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

  if (selectedShapeId.value && !yShapes.has(selectedShapeId.value)) {
    selectedShapeId.value = null;
  }

  void nextTick(resizeAllTextShapesToContent);
}

function syncStrokesFromY() {
  strokes.value = [...yStrokes.entries()]
    .map(([id, value]) => toStroke(id, value))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  if (selectedStrokeId.value && !yStrokes.has(selectedStrokeId.value)) {
    selectedStrokeId.value = null;
  }
  renderInk();
}

function defaultColor(type: CanvasShapeType) {
  if (type === "image") return "#ffffff";
  if (type === "video") return "#000000";
  if (type === "section") return "rgba(255, 255, 255, 0.02)";
  if (type === "text") return "#ffffff";
  return NOTE_COLORS[0];
}

function defaultText(type: CanvasShapeType) {
  if (type === "image" || type === "video") return "";
  if (type === "section") return "Section";
  if (type === "text") return "Text";
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
            Boolean(stroke && typeof stroke.id === "string" && Array.isArray(stroke.points)),
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
        .filter((shape): shape is CanvasShape => Boolean(shape && typeof shape.id === "string"))
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
    drawFreehandStroke(context, themedStroke(activeFreehandStroke.value), transform.value);
  }
  drawStrokeSelection(context);
}

function drawStrokeSelection(context: CanvasRenderingContext2D) {
  const id = selectedStrokeId.value;
  if (!id) return;
  const stroke = strokes.value.find((s) => s.id === id);
  if (!stroke || stroke.points.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke.points) {
    const screenPos = worldToScreen(point);
    minX = Math.min(minX, screenPos.x);
    minY = Math.min(minY, screenPos.y);
    maxX = Math.max(maxX, screenPos.x);
    maxY = Math.max(maxY, screenPos.y);
  }

  const halfWidth = (stroke.style.width / 2) * transform.value.scale;
  const padding = halfWidth + 8;
  const x = minX - padding;
  const y = minY - padding;
  const width = maxX - minX + padding * 2;
  const height = maxY - minY + padding * 2;

  context.save();
  context.strokeStyle = "#2563eb";
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.strokeRect(x, y, width, height);
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
    selectionIds: selectedShapeId.value ? [selectedShapeId.value] : [],
    focusedNodeId: selectedShapeId.value,
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
          if (presence.clientId !== presenceClientId) next.set(presence.clientId, presence);
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
    image.onload = () => resolve({
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
    video.onloadedmetadata = () => resolve({
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
  const scale = Math.min(1, maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
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
    selectedShapeId.value = id;
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

function addShape(type: CanvasShapeType, at: { x: number; y: number }) {
  const id = `shape-${crypto.randomUUID()}`;
  const text = defaultText(type);
  const textSize = type === "text" ? measureTextShape(text) : null;
  const shape: CanvasShape = {
    id,
    type,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: textSize?.width ?? (type === "section" ? 560 : 240),
    height: textSize?.height ?? (type === "section" ? 340 : 150),
    text,
    color: type === "note" ? noteColor.value : defaultColor(type),
    updatedAt: Date.now(),
  };
  yShapes.set(id, createShapeMap(shape));
  selectedShapeId.value = id;
  if (selectedStrokeId.value !== null) {
    selectedStrokeId.value = null;
    renderInk();
  }
  activeTool.value = "select";
  nextTick(() => {
    const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      type === "section" ? `[data-section-title="${id}"]` : `[data-shape-text="${id}"]`,
    );
    if (type === "text") resizeTextShapeToContent(id, shape.text);
    input?.focus();
    input?.select();
  });
}

function updateShapeText(shape: CanvasShape, text: string) {
  updateShape(shape.id, { text });
  if (shape.type === "text") {
    void nextTick(() => resizeTextShapeToContent(shape.id, text));
  }
}

function handleTextBlur(shape: CanvasShape, event: FocusEvent) {
  // A text element with no content has nothing to anchor it, so remove it once
  // editing ends. Notes and sections keep their box even when empty.
  if (shape.type !== "text") return;
  const value = (event.target as HTMLTextAreaElement).value;
  if (value.trim() !== "") return;
  yShapes.delete(shape.id);
  if (selectedShapeId.value === shape.id) selectedShapeId.value = null;
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
  return stroke.points.length > 0 && stroke.points.every((point) => isPointInsideSection(point, section));
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
  if (selectedShapeId.value) {
    yShapes.delete(selectedShapeId.value);
    selectedShapeId.value = null;
  }
  if (selectedStrokeId.value) {
    yStrokes.delete(selectedStrokeId.value);
    selectedStrokeId.value = null;
  }
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
  selectedShapeId.value = null;
  selectedStrokeId.value = null;
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
    yStrokes.set(id, createStrokeMap({
      id,
      points: finished.points.map(cloneFreehandPoint),
      style: { ...finished.style },
      updatedAt: Date.now(),
    }));
  }
  freehandBuilder = null;
  freehandPointerId = null;
  activeFreehandStroke.value = null;
  renderInk();
}

function startShapeDrag(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0) return;
  selectedShapeId.value = shape.id;
  if (selectedStrokeId.value !== null) {
    selectedStrokeId.value = null;
    renderInk();
  }
  const sectionContents = shape.type === "section" ? getSectionContents(shape) : null;
  dragState = {
    type: "shape",
    pointerId: event.pointerId,
    shapeId: shape.id,
    startPointer: screenToWorld(screenPoint(event)),
    startShape: { x: shape.x, y: shape.y },
    containedShapes: sectionContents?.shapes ?? [],
    containedStrokes: sectionContents?.strokes ?? [],
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  if (shape.type !== "text") {
    event.preventDefault();
  }
}

function startShapeResize(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0 || (shape.type !== "note" && shape.type !== "section")) return;
  selectedShapeId.value = shape.id;
  dragState = {
    type: "resize",
    pointerId: event.pointerId,
    shapeId: shape.id,
    startPointer: screenToWorld(screenPoint(event)),
    startSize: { width: shape.width, height: shape.height },
    minSize: shape.type === "section" ? MIN_SECTION_SIZE : MIN_NOTE_SIZE,
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
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function handleViewportPointerDown(event: PointerEvent) {
  if (event.pointerType === "touch" && !event.isPrimary) return;

  const point = screenPoint(event);
  localPointer.value = screenToWorld(point);

  if (event.button === 1 || event.button === 2) {
    startPan(event);
    event.preventDefault();
    return;
  }

  if (activeTool.value === "select") {
    selectedShapeId.value = null;
    const hitStroke = strokeHitTest(screenToWorld(point));
    selectedStrokeId.value = hitStroke;
    renderInk();
    if (hitStroke) {
      event.preventDefault();
      return;
    }
    if (event.pointerType !== "touch") startPan(event);
    return;
  }

  if (activeTool.value === "draw") {
    startFreehand(event);
    return;
  }

  addShape(activeTool.value, screenToWorld(point));
  event.preventDefault();
}

function handlePointerMove(event: PointerEvent) {
  const point = screenPoint(event);
  localPointer.value = screenToWorld(point);

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

  const world = screenToWorld(point);
  if (dragState.type === "resize") {
    updateShape(dragState.shapeId, {
      width: Math.round(
        Math.max(
          dragState.minSize.width,
          dragState.startSize.width + world.x - dragState.startPointer.x,
        ),
      ),
      height: Math.round(
        Math.max(
          dragState.minSize.height,
          dragState.startSize.height + world.y - dragState.startPointer.y,
        ),
      ),
    });
    return;
  }

  const dx = world.x - dragState.startPointer.x;
  const dy = world.y - dragState.startPointer.y;
  ydoc.transact(() => {
    updateShape(dragState.shapeId, {
      x: Math.round(dragState.startShape.x + dx),
      y: Math.round(dragState.startShape.y + dy),
    });

    for (const contained of dragState.containedShapes) {
      updateShape(contained.id, {
        x: Math.round(contained.x + dx),
        y: Math.round(contained.y + dy),
      });
    }

    for (const stroke of dragState.containedStrokes) {
      translateStroke(stroke.id, stroke.points, dx, dy);
    }
  });
}

function handlePointerUp(event: PointerEvent) {
  finishFreehand(event);
  if (dragState?.pointerId === event.pointerId) {
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

function handleDragOver(event: DragEvent) {
  if (!dragHasMediaFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleDrop(event: DragEvent) {
  if (!dragHasMediaFiles(event.dataTransfer)) return;
  // Prevent the browser from navigating to the file even when the dropped
  // files turn out not to be media we can place.
  event.preventDefault();
  const media = mediaFilesFromList(event.dataTransfer?.files ?? []);
  if (media.length === 0) return;
  void addMediaFiles(media, insertionPointFromEvent(event));
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
  const selShapes = selectedShapeId.value
    ? shapes.value.filter((shape) => shape.id === selectedShapeId.value).map((shape) => ({ ...shape }))
    : [];
  const selStrokes = selectedStrokeId.value
    ? strokes.value
        .filter((stroke) => stroke.id === selectedStrokeId.value)
        .map((stroke) => ({
          id: stroke.id,
          points: stroke.points.map(cloneFreehandPoint),
          style: { ...stroke.style },
          updatedAt: stroke.updatedAt,
        }))
    : [];
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

function parseCanvasClipboard(text: string | null | undefined): CanvasClipboard | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<CanvasClipboard>;
    if (!parsed || parsed[CANVAS_CLIPBOARD_MARKER] !== 1) return null;
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
  let firstShapeId: string | null = null;
  let firstStrokeId: string | null = null;

  ydoc.transact(() => {
    for (const shape of payload.shapes) {
      const id = `shape-${crypto.randomUUID()}`;
      if (!firstShapeId) firstShapeId = id;
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
      if (!firstStrokeId) firstStrokeId = id;
      yStrokes.set(
        id,
        createStrokeMap({
          id,
          points: stroke.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
          style: { ...stroke.style },
          updatedAt: now,
        }),
      );
    }
  });

  selectedStrokeId.value = firstShapeId ? null : firstStrokeId;
  selectedShapeId.value = firstShapeId;
  activeTool.value = "select";
}

function handlePaste(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input, select")) return;

  // Canvas elements first (portable JSON in the clipboard text).
  const payload =
    parseCanvasClipboard(event.clipboardData?.getData("text/plain")) ??
    parseCanvasClipboard(internalClipboard);
  if (payload) {
    event.preventDefault();
    pasteCanvasClipboard(payload, insertionPointFromEvent());
    return;
  }

  const files = Array.from(event.clipboardData?.files ?? []);
  const media = mediaFilesFromList(files);
  if (media.length === 0) return;

  event.preventDefault();
  void addMediaFiles(media, insertionPointFromEvent());
}

function fitView() {
  const xs = [
    ...shapes.value.flatMap((shape) => [shape.x, shape.x + shape.width]),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...shapes.value.flatMap((shape) => [shape.y, shape.y + shape.height]),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.y)),
  ];

  if (xs.length === 0 || ys.length === 0) {
    camera.value = { centerX: 0, centerY: 0, zoom: 1 };
    return;
  }

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX + 160);
  const height = Math.max(1, maxY - minY + 160);
  const fitScale = Math.min(screen.value.width / width, screen.value.height / height);
  const baseScale = Math.min(
    screen.value.width / FIT_REFERENCE.width,
    screen.value.height / FIT_REFERENCE.height,
  );

  camera.value = {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    zoom: Math.max(0.25, Math.min(3, fitScale / baseScale)),
  };
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
watch([camera, screen], () => {
  renderGrid();
  renderInk();
  updatePresence();
}, { deep: true });

onMounted(() => {
  yShapes.observeDeep(() => {
    syncShapesFromY();
    scheduleSave();
    refreshUndoState();
  });
  yStrokes.observeDeep(() => {
    syncStrokesFromY();
    scheduleSave();
    refreshUndoState();
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
      freehandBuilder = null;
      freehandPointerId = null;
      activeFreehandStroke.value = null;
      renderInk();
    },
    minZoom: 0.25,
    maxZoom: 3,
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
        @click="fitView"
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
      @contextmenu.prevent
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
            { selected: selectedShapeId === shape.id },
          ]"
          :style="{
            left: `${shape.x}px`,
            top: `${shape.y}px`,
            width: `${shape.width}px`,
            height: `${shape.height}px`,
            background: shape.color,
          }"
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
              @focus="selectedShapeId = shape.id"
              @pointerdown.stop
              @input="updateShapeText(shape, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <div
            v-else-if="shape.type !== 'text'"
            class="canvas-shape-handle"
            @pointerdown.stop="startShapeDrag(shape, $event)"
          ></div>
          <img
            v-if="shape.type === 'image' && shape.src"
            class="canvas-shape-image"
            :src="shape.src"
            :alt="shape.alt || ''"
            draggable="false"
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
          <textarea
            v-else-if="shape.type !== 'section'"
            class="canvas-shape-text"
            :data-shape-text="shape.id"
            :value="shape.text"
            spellcheck="false"
            @focus="selectedShapeId = shape.id"
            @blur="handleTextBlur(shape, $event)"
            @pointerdown.stop="shape.type === 'text' && startShapeDrag(shape, $event)"
            @input="updateShapeText(shape, ($event.target as HTMLTextAreaElement).value)"
          ></textarea>
          <button
            v-if="(shape.type === 'note' || shape.type === 'section') && selectedShapeId === shape.id"
            type="button"
            class="canvas-resize-handle"
            :aria-label="shape.type === 'section' ? 'Resize section' : 'Resize note'"
            @pointerdown.stop="startShapeResize(shape, $event)"
          ></button>
        </article>
      </div>

      <div
        v-for="presence in remoteCanvasPresences"
        :key="presence.clientId"
        class="canvas-presence"
        :style="{
          transform: `translate(${worldToScreen(presence.state!.pointer!).x}px, ${worldToScreen(presence.state!.pointer!).y}px)`,
          '--presence-color': presence.user.color || getPresenceColor(presence.user.id),
        }"
      >
        <span class="canvas-presence-cursor"></span>
        <span class="canvas-presence-label">{{ presence.user.name }}</span>
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
  cursor: grab;
  touch-action: none;
}

.canvas-viewport:active {
  cursor: grabbing;
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
  border-color: transparent;
  background: transparent !important;
  box-shadow: none;
}

.canvas-shape.image {
  background: var(--canvas-image-bg);
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

.canvas-shape.text .canvas-shape-text {
  cursor: move;
  font-size: 20px;
  font-weight: 650;
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

:global(.canvas-text-measure) {
  position: fixed;
  left: -10000px;
  top: -10000px;
  z-index: -1;
  box-sizing: border-box;
  display: inline-block;
  min-width: 32px;
  min-height: 40px;
  border: 0;
  padding: 10px 12px;
  white-space: pre;
  color: var(--canvas-text);
  font: inherit;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.35;
  pointer-events: none;
}

.canvas-presence {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 8;
  pointer-events: none;
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
