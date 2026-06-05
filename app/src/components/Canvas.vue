<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import * as Y from "yjs";
import { joinPresenceRoom, joinYjsRoom } from "../utils/sync.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import type { PresenceEnvelope } from "../utils/realtime.ts";
import {
  buildTransform,
  createViewportControls,
  drawWorldGrid,
  panCameraByScreenDelta,
  screenToWorld as viewportScreenToWorld,
  worldToScreen as viewportWorldToScreen,
  type FitReference,
  type ScreenSize,
  type ViewportCamera,
  type ViewportControls,
} from "../viewport/index.ts";

const props = defineProps<{
  spaceId: string;
  documentId?: string;
}>();

type CanvasTool = "select" | "note" | "box" | "text";
type CanvasShapeType = "note" | "box" | "text";

type CanvasShape = {
  id: string;
  type: CanvasShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  updatedAt: number;
};

type CanvasSnapshot = {
  version: 1;
  shapes: CanvasShape[];
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
    }
  | {
      type: "pan";
      pointerId: number;
      startPointer: { x: number; y: number };
      startCamera: ViewportCamera;
    };

const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
const viewportRef = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLCanvasElement | null>(null);
const shapes = ref<CanvasShape[]>([]);
const selectedShapeId = ref<string | null>(null);
const activeTool = ref<CanvasTool>("select");
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
const saveError = ref<string | null>(null);
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

let leaveYjsRoom = () => {};
let leavePresenceRoom = () => {};
let presenceHandle: { update: (state: CanvasPresenceState) => void; leave: () => void } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let dragState: DragState | null = null;
let isReady = false;
let hasSeededInitialContent = false;
let viewportControls: ViewportControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

const selectedShape = computed(() =>
  selectedShapeId.value
    ? shapes.value.find((shape) => shape.id === selectedShapeId.value) ?? null
    : null,
);

const remoteCanvasPresences = computed(() =>
  [...remotePresences.value.values()].filter(
    (presence) => presence.state?.kind === "canvas" && presence.state.pointer,
  ),
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

function toShape(id: string, source: Y.Map<unknown> | CanvasShape): CanvasShape {
  const read = (key: keyof CanvasShape) =>
    source instanceof Y.Map ? source.get(key) : source[key];

  const typeValue = read("type");
  const type: CanvasShapeType =
    typeValue === "box" || typeValue === "text" || typeValue === "note"
      ? typeValue
      : "note";

  return {
    id,
    type,
    x: toNumber(read("x"), 0),
    y: toNumber(read("y"), 0),
    width: Math.max(80, toNumber(read("width"), type === "text" ? 220 : 240)),
    height: Math.max(48, toNumber(read("height"), type === "text" ? 88 : 150)),
    text: typeof read("text") === "string" ? String(read("text")) : "",
    color: typeof read("color") === "string" ? String(read("color")) : defaultColor(type),
    updatedAt: toNumber(read("updatedAt"), Date.now()),
  };
}

function syncShapesFromY() {
  shapes.value = [...yShapes.entries()]
    .map(([id, value]) => toShape(id, value))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));

  if (selectedShapeId.value && !yShapes.has(selectedShapeId.value)) {
    selectedShapeId.value = null;
  }
}

function defaultColor(type: CanvasShapeType) {
  if (type === "box") return "#dbeafe";
  if (type === "text") return "#ffffff";
  return "#fef3c7";
}

function defaultText(type: CanvasShapeType) {
  if (type === "box") return "Box";
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
  map.set("updatedAt", shape.updatedAt);
  return map;
}

function parseSnapshot(content: string | null | undefined): CanvasSnapshot | null {
  if (!content?.trim()) return null;
  try {
    const parsed = JSON.parse(content) as Partial<CanvasSnapshot>;
    if (!parsed || !Array.isArray(parsed.shapes)) return null;
    return {
      version: 1,
      shapes: parsed.shapes
        .filter((shape): shape is CanvasShape => Boolean(shape && typeof shape.id === "string"))
        .map((shape) => toShape(shape.id, shape)),
    };
  } catch {
    return null;
  }
}

function seedFromSnapshot(snapshot: CanvasSnapshot | null) {
  if (!snapshot || yShapes.size > 0) return;
  ydoc.transact(() => {
    for (const shape of snapshot.shapes) {
      yShapes.set(shape.id, createShapeMap(shape));
    }
  });
  syncShapesFromY();
}

function serializeSnapshot(): string {
  const snapshot: CanvasSnapshot = {
    version: 1,
    shapes: shapes.value.map((shape) => ({ ...shape })),
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

function screenPoint(event: PointerEvent | WheelEvent) {
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

function renderGrid() {
  const canvas = gridRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);
  drawWorldGrid(context, transform.value, screen.value, {
    levels: [
      { size: 40, color: "rgba(15, 23, 42, 0.07)", lineWidth: 1, minScreenSpacing: 8 },
      { size: 200, color: "rgba(15, 23, 42, 0.13)", lineWidth: 1, minScreenSpacing: 24 },
    ],
  });
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
  renderGrid();
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

function addShape(type: CanvasShapeType, at: { x: number; y: number }) {
  const id = `shape-${crypto.randomUUID()}`;
  const shape: CanvasShape = {
    id,
    type,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: type === "text" ? 220 : 240,
    height: type === "text" ? 88 : 150,
    text: defaultText(type),
    color: defaultColor(type),
    updatedAt: Date.now(),
  };
  yShapes.set(id, createShapeMap(shape));
  selectedShapeId.value = id;
  activeTool.value = "select";
  nextTick(() => {
    const input = document.querySelector<HTMLTextAreaElement>(`[data-shape-text="${id}"]`);
    input?.focus();
    input?.select();
  });
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
  if (!selectedShapeId.value) return;
  yShapes.delete(selectedShapeId.value);
  selectedShapeId.value = null;
}

function startShapeDrag(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0) return;
  selectedShapeId.value = shape.id;
  dragState = {
    type: "shape",
    pointerId: event.pointerId,
    shapeId: shape.id,
    startPointer: screenToWorld(screenPoint(event)),
    startShape: { x: shape.x, y: shape.y },
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
    if (event.pointerType !== "touch") startPan(event);
    return;
  }

  addShape(activeTool.value, screenToWorld(point));
  event.preventDefault();
}

function handlePointerMove(event: PointerEvent) {
  const point = screenPoint(event);
  localPointer.value = screenToWorld(point);

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
  updateShape(dragState.shapeId, {
    x: Math.round(dragState.startShape.x + world.x - dragState.startPointer.x),
    y: Math.round(dragState.startShape.y + world.y - dragState.startPointer.y),
  });
}

function handlePointerUp(event: PointerEvent) {
  if (dragState?.pointerId === event.pointerId) {
    dragState = null;
  }
}

function handlePointerLeave() {
  localPointer.value = null;
  updatePresence();
}

function fitView() {
  if (shapes.value.length === 0) {
    camera.value = { centerX: 0, centerY: 0, zoom: 1 };
    return;
  }

  const minX = Math.min(...shapes.value.map((shape) => shape.x));
  const minY = Math.min(...shapes.value.map((shape) => shape.y));
  const maxX = Math.max(...shapes.value.map((shape) => shape.x + shape.width));
  const maxY = Math.max(...shapes.value.map((shape) => shape.y + shape.height));
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

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input, select")) return;

  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "s") {
    event.preventDefault();
    void manualSave();
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    deleteSelectedShape();
    return;
  }

  if (key === "v") activeTool.value = "select";
  if (key === "n") activeTool.value = "note";
  if (key === "b") activeTool.value = "box";
  if (key === "t") activeTool.value = "text";
  if (key === "f") fitView();
}

watch(
  () => documentData.value?.content,
  (content) => {
    if (hasSeededInitialContent || yShapes.size > 0) return;
    hasSeededInitialContent = true;
    seedFromSnapshot(parseSnapshot(content));
  },
  { immediate: true },
);

watch(user, setupPresence);
watch([camera, screen], () => {
  renderGrid();
  updatePresence();
}, { deep: true });

onMounted(() => {
  yShapes.observeDeep(() => {
    syncShapesFromY();
    scheduleSave();
  });
  syncShapesFromY();
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
    },
    minZoom: 0.25,
    maxZoom: 3,
  });

  resizeObserver = new ResizeObserver(resize);
  if (viewportRef.value) resizeObserver.observe(viewportRef.value);

  if (props.documentId) {
    leaveYjsRoom = joinYjsRoom(props.spaceId, props.documentId, ydoc);
  }

  setupPresence();
  isReady = true;
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
});

onUnmounted(() => {
  viewportControls?.dispose();
  resizeObserver?.disconnect();
  leavePresenceRoom();
  leaveYjsRoom();
  ydoc.destroy();
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerUp);
  if (saveTimer) clearTimeout(saveTimer);
  if (saveStateTimer) clearTimeout(saveStateTimer);
  if (presenceTimer) clearInterval(presenceTimer);
});
</script>

<template>
  <div class="canvas-root">
    <div class="canvas-toolbar" @pointerdown.stop>
      <button
        v-for="tool in (['select', 'note', 'box', 'text'] as CanvasTool[])"
        :key="tool"
        type="button"
        class="canvas-tool"
        :class="{ active: activeTool === tool }"
        @click="activeTool = tool"
      >
        {{ tool }}
      </button>
      <span class="canvas-divider"></span>
      <button type="button" class="canvas-tool" @click="fitView">Fit</button>
      <button
        type="button"
        class="canvas-tool danger"
        :disabled="!selectedShape"
        @click="deleteSelectedShape"
      >
        Delete
      </button>
      <button type="button" class="canvas-tool primary" @click="manualSave">
        {{ saveState === "saving" ? "Saving..." : "Save" }}
      </button>
      <span v-if="saveState === 'saved'" class="canvas-save-state">Saved</span>
      <span v-if="saveState === 'error'" class="canvas-save-state error">{{ saveError }}</span>
    </div>

    <div
      ref="viewportRef"
      class="canvas-viewport"
      @contextmenu.prevent
      @pointerdown="handleViewportPointerDown"
      @pointerleave="handlePointerLeave"
    >
      <canvas ref="gridRef" class="canvas-grid"></canvas>
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
          <div class="canvas-shape-handle" @pointerdown.stop="startShapeDrag(shape, $event)"></div>
          <textarea
            class="canvas-shape-text"
            :data-shape-text="shape.id"
            :value="shape.text"
            spellcheck="false"
            @focus="selectedShapeId = shape.id"
            @pointerdown.stop
            @input="updateShape(shape.id, { text: ($event.target as HTMLTextAreaElement).value })"
          ></textarea>
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

      <div v-if="shapes.length === 0" class="canvas-empty">
        <strong>Blank canvas</strong>
        <span>Choose Note, Box, or Text, then click the canvas.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.canvas-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #f8fafc;
  color: #111827;
}

.canvas-toolbar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  overflow-x: auto;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  padding: 6px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
}

.canvas-tool {
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  padding: 6px 9px;
  color: #374151;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  text-transform: capitalize;
  white-space: nowrap;
}

.canvas-tool:hover {
  background: #f3f4f6;
}

.canvas-tool.active,
.canvas-tool.primary {
  border-color: #bfdbfe;
  background: #dbeafe;
  color: #1d4ed8;
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
  background: #e5e7eb;
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
  background-color: #f8fafc;
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

.canvas-grid {
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
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 8px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.12);
}

.canvas-shape.selected {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.canvas-shape.box {
  border-style: dashed;
}

.canvas-shape.text {
  border-color: transparent;
  background: transparent !important;
  box-shadow: none;
}

.canvas-shape-handle {
  height: 18px;
  flex: 0 0 auto;
  cursor: move;
  background: rgba(15, 23, 42, 0.08);
}

.canvas-shape.text .canvas-shape-handle {
  height: 12px;
  background: rgba(37, 99, 235, 0.12);
}

.canvas-shape-text {
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  background: transparent;
  padding: 10px 12px;
  color: #111827;
  font: inherit;
  font-size: 15px;
  line-height: 1.35;
  outline: none;
  resize: none;
}

.canvas-shape.text .canvas-shape-text {
  font-size: 20px;
  font-weight: 650;
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
  color: #111827;
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
  color: #6b7280;
  text-align: center;
  pointer-events: none;
}

.canvas-empty strong {
  color: #374151;
  font-size: 16px;
}
</style>
