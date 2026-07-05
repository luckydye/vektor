// Layout insets.
//
// The fixed navigation sidebar and any docked panels reserve space along the
// left and right edges of the viewport. Instead of reserving that space with
// flex placeholders (a parallel offset mechanism) or writing a document-wide
// custom property (which invalidates the whole document subtree on every resize
// frame), each consumer subscribes here and the current insets are applied
// directly to it as `--inset-left` / `--inset-right`. Content uses them as
// margins; docked panels derive their own position from the same numbers.
//
//   --inset-left  = sidebar width + Σ(left docked panel widths)
//   --inset-right =               Σ(right docked panel widths)
//
// Inputs:
//   • sidebar width — the `sidebar:resize` event (and persisted localStorage).
//   • docked panel widths — pushed in by the docked-windows layer via
//     `setDockInsets` whenever a panel docks/undocks/resizes.
//
// Consumption:
//   • <inset-view> custom element — self-subscribes on connectedCallback,
//     unsubscribes on disconnectedCallback. No scanning or timing required.
//   • Vue components: call `bindInsets(el)` / `onInsets(cb)` in `onMounted`
//     and invoke the returned unsubscribe in `onUnmounted`.

const SIDEBAR_STORAGE_KEY = "sidebar-width";
const DEFAULT_SIDEBAR = 280;

export interface Insets {
  /** Raw sidebar width in px. */
  sidebar: number;
  /** Left inset: sidebar + left docked panels. */
  left: number;
  /** Right inset: right docked panels. */
  right: number;
}

let sidebar = DEFAULT_SIDEBAR;
let leftDock = 0;
let rightDock = 0;
let wired = false;
const subscribers = new Set<(insets: Insets) => void>();

function readSavedSidebar(): number {
  if (typeof localStorage === "undefined") return DEFAULT_SIDEBAR;
  const n = parseInt(localStorage.getItem(SIDEBAR_STORAGE_KEY) ?? "", 10);
  return Number.isFinite(n) ? n : DEFAULT_SIDEBAR;
}

function snapshot(): Insets {
  return { sidebar, left: sidebar + leftDock, right: rightDock };
}

function notify() {
  const s = snapshot();
  for (const cb of subscribers) cb(s);
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  sidebar = readSavedSidebar();

  window.addEventListener("sidebar:resize", (e) => {
    const w = (e as CustomEvent<{ width?: number }>).detail?.width;
    if (typeof w === "number") sidebar = w;
    notify();
  });
}

/** Current insets (sidebar/left/right) in px. */
export function getInsets(): Insets {
  return snapshot();
}

/** Set the total docked-panel widths per side. Fed by the docked-windows layer. */
export function setDockInsets(left: number, right: number) {
  wire();
  if (left === leftDock && right === rightDock) return;
  leftDock = left;
  rightDock = right;
  notify();
}

/** Subscribe to inset changes. Fires immediately with the current value. Returns unsubscribe. */
export function onInsets(cb: (insets: Insets) => void): () => void {
  wire();
  subscribers.add(cb);
  cb(snapshot());
  return () => {
    subscribers.delete(cb);
  };
}

/** Bind an element's local `--inset-left`/`--inset-right` to the current values. Returns unsubscribe. */
export function bindInsets(el: HTMLElement): () => void {
  return onInsets((s) => {
    el.style.setProperty("--inset-left", `${s.left}px`);
    el.style.setProperty("--inset-right", `${s.right}px`);
  });
}

// <inset-view> custom element — replace `<div data-inset>` with this tag.
// Self-subscribes when connected to the DOM; no external initInsets() call needed.
if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("inset-view")
) {
  customElements.define(
    "inset-view",
    class InsetView extends HTMLElement {
      private unsub?: () => void;
      connectedCallback() {
        this.unsub = bindInsets(this);
      }
      disconnectedCallback() {
        this.unsub?.();
        this.unsub = undefined;
      }
    },
  );
}
