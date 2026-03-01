import { ref, computed, type Ref } from "vue";

export interface DockedWindowState {
  mode: "docked" | "floating";
  side: "left" | "right";
  width: number;
  open: boolean;
  x?: number;
  y?: number;
  height?: number;
}

function storageKey(id: string) {
  return `docked-window:${id}`;
}

function loadState(id: string): DockedWindowState | null {
  const saved = localStorage.getItem(storageKey(id));
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

function saveState(id: string, state: DockedWindowState) {
  localStorage.setItem(storageKey(id), JSON.stringify(state));
}

// Module-level shared state
const windows = ref(new Map<string, DockedWindowState>());

export const leftWindows = computed(() =>
  [...windows.value.entries()]
    .filter(([, w]) => w.open && w.mode === "docked" && w.side === "left")
    .map(([id, w]) => ({ id, ...w })),
);

export const rightWindows = computed(() =>
  [...windows.value.entries()]
    .filter(([, w]) => w.open && w.mode === "docked" && w.side === "right")
    .map(([id, w]) => ({ id, ...w })),
);

function getWindow(id: string): DockedWindowState | undefined {
  return windows.value.get(id);
}

function update(id: string, patch: Partial<DockedWindowState>) {
  const current = windows.value.get(id);
  if (!current) throw new Error(`Window "${id}" not registered`);
  const next = { ...current, ...patch };
  windows.value.set(id, next);
  // Trigger reactivity by replacing the map
  windows.value = new Map(windows.value);
  saveState(id, next);
}

// Register a window (on mount) — respects persisted open state
function register(
  id: string,
  opts?: Partial<Pick<DockedWindowState, "mode" | "side" | "width">>,
) {
  if (windows.value.has(id)) return;
  const persisted = loadState(id);
  const state: DockedWindowState = persisted ?? {
    mode: opts?.mode ?? "docked",
    side: opts?.side ?? "right",
    width: opts?.width ?? 380,
    open: false,
  };
  windows.value.set(id, state);
  windows.value = new Map(windows.value);
}

// Remove window from reactive state (localStorage untouched so state survives navigation)
function deregister(id: string) {
  windows.value.delete(id);
  windows.value = new Map(windows.value);
}

function open(
  id: string,
  opts?: Partial<Pick<DockedWindowState, "mode" | "side" | "width">>,
) {
  register(id, opts);
  update(id, { open: true });
}

function close(id: string) {
  update(id, { open: false });
}

function toggle(
  id: string,
  opts?: Partial<Pick<DockedWindowState, "mode" | "side" | "width">>,
) {
  const w = windows.value.get(id);
  if (!w || !w.open) {
    open(id, opts);
  } else {
    close(id);
  }
}

function dock(id: string, side: "left" | "right") {
  update(id, { mode: "docked", side });
}

function undock(id: string) {
  update(id, { mode: "floating" });
}

function setWidth(id: string, width: number) {
  update(id, { width });
}

function setPosition(id: string, x: number, y: number, w: number, h: number) {
  update(id, { x, y, width: w, height: h });
}

export function useDockedWindows() {
  return {
    windows: windows as Ref<Map<string, DockedWindowState>>,
    register,
    deregister,
    open,
    close,
    toggle,
    dock,
    undock,
    setWidth,
    setPosition,
    getWindow,
    leftWindows,
    rightWindows,
  };
}
