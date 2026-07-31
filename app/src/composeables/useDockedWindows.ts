import { type Accessor, createMemo, createSignal } from "solid-js";

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

/**
 * Module-level shared state: a docked window is addressed by id from anywhere
 * in the app, and the layout components render whatever is registered. Browser
 * only — it reads `localStorage` — so there is no SSR isolation concern.
 *
 * The map is replaced rather than mutated on every write: `Map.set` is
 * invisible to a signal.
 */
const [windows, setWindows] = createSignal(new Map<string, DockedWindowState>());

function writeWindows(mutate: (next: Map<string, DockedWindowState>) => void) {
  const next = new Map(windows());
  mutate(next);
  setWindows(next);
}

export const leftWindows = createMemo(() =>
  [...windows().entries()]
    .filter(([, w]) => w.open && w.mode === "docked" && w.side === "left")
    .map(([id, w]) => ({ id, ...w })),
);

export const rightWindows = createMemo(() =>
  [...windows().entries()]
    .filter(([, w]) => w.open && w.mode === "docked" && w.side === "right")
    .map(([id, w]) => ({ id, ...w })),
);

function getWindow(id: string): DockedWindowState | undefined {
  return windows().get(id);
}

function update(id: string, patch: Partial<DockedWindowState>) {
  const current = windows().get(id);
  if (!current) throw new Error(`Window "${id}" not registered`);
  const next = { ...current, ...patch };
  writeWindows((map) => map.set(id, next));
  saveState(id, next);
}

// Register a window (on mount) — respects persisted open state
function register(
  id: string,
  opts?: Partial<Pick<DockedWindowState, "mode" | "side" | "width">>,
) {
  if (windows().has(id)) return;
  const state: DockedWindowState = {
    mode: opts?.mode ?? "docked",
    side: opts?.side ?? "right",
    width: opts?.width ?? 380,
    open: false,
  };
  writeWindows((map) => map.set(id, state));

  const persisted = loadState(id);
  if (persisted) {
    queueMicrotask(() => {
      if (!windows().has(id)) return;
      writeWindows((map) => map.set(id, persisted));
    });
  }
}

// Remove window from reactive state (localStorage untouched so state survives navigation)
function deregister(id: string) {
  writeWindows((map) => map.delete(id));
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
  const w = windows().get(id);
  if (!w?.open) {
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
    windows: windows as Accessor<Map<string, DockedWindowState>>,
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
