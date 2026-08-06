import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  type DockedWindowState,
  useDockedWindows,
} from "#composeables/useDockedWindows.ts";
import { useIsDesktop } from "#composeables/useIsDesktop.ts";
import { getInsets, type Insets, onInsets } from "#utils/insets.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  id: string;
  title: string;
  defaultSide?: "left" | "right";
  defaultWidth?: number;
  defaultMode?: "docked" | "floating";
  children?: JSX.Element;
}

const DOCK_THRESHOLD = 100;
const DOCK_MARGIN = 6;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;

export function DockedPanel(props: Props) {
  const {
    register,
    deregister,
    close,
    dock,
    undock,
    setWidth,
    setPosition,
    windows,
    leftWindows,
    rightWindows,
  } = useDockedWindows();

  // Reactive window state derived from the composable
  const state = createMemo<DockedWindowState | undefined>(() => windows().get(props.id));
  const isOpen = createMemo(() => state()?.open ?? false);
  const mode = createMemo(() => state()?.mode ?? "docked");
  const side = createMemo(() => state()?.side ?? props.defaultSide ?? "right");
  const width = createMemo(() => state()?.width ?? props.defaultWidth ?? 380);

  // Floating position signals (used during drag/resize, synced on end)
  const [floatX, setFloatX] = createSignal(100);
  const [floatY, setFloatY] = createSignal(100);
  const [floatW, setFloatW] = createSignal(props.defaultWidth ?? 380);
  const [floatH, setFloatH] = createSignal(600);

  // Layout insets (sidebar + docked panels), kept in sync via the inset subscriber.
  const [insets, setInsets] = createSignal<Insets>(getInsets());

  // Track the md breakpoint reactively so docked positioning recomputes when the
  // sidebar collapses to an overlay below it, and so the panel becomes a bottom
  // drawer on mobile.
  const isDesktop = useIsDesktop();

  function sidebarOffset(): number {
    return isDesktop() ? insets().sidebar : 0;
  }

  // Sum of same-side docked panel widths stacked before this one.
  function precedingWidth(): number {
    const list = side() === "left" ? leftWindows() : rightWindows();
    const idx = list.findIndex((w) => w.id === props.id);
    return list.slice(0, Math.max(0, idx)).reduce((sum, w) => sum + w.width, 0);
  }

  // Left edge (viewport px) of this panel when docked.
  function dockedLeft(): number {
    if (side() === "left") return sidebarOffset() + precedingWidth();
    return window.innerWidth - DOCK_MARGIN - precedingWidth() - width();
  }

  // Computed style for the fixed overlay. Docked panels derive their position
  // from the inset system rather than a measured placeholder, anchoring to the
  // relevant edge so no viewport math is needed: left panels sit past the sidebar
  // (and any panels stacked before them), right panels stack in from the right.
  const overlayStyle = createMemo<JSX.CSSProperties>(() => {
    if (mode() === "docked") {
      const base = {
        top: `${DOCK_MARGIN}px`,
        width: `${width()}px`,
        height: `calc(100vh - ${DOCK_MARGIN * 2}px)`,
      };
      return side() === "left"
        ? { ...base, left: `${sidebarOffset() + precedingWidth()}px` }
        : { ...base, right: `${DOCK_MARGIN + precedingWidth()}px` };
    }
    return {
      left: `${floatX()}px`,
      top: `${floatY()}px`,
      width: `${floatW()}px`,
      height: `${floatH()}px`,
    };
  });

  // Sync floating signals from composable state
  createEffect(
    on(state, (s) => {
      if (!s || s.mode !== "floating") return;
      if (s.x != null) setFloatX(s.x);
      if (s.y != null) setFloatY(s.y);
      if (s.height != null) setFloatH(s.height);
      setFloatW(s.width);
    }),
  );

  // ── Drag ────────────────────────────────────────────────────────────────────

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let windowStartX = 0;
  let windowStartY = 0;

  function onDragStart(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(".panel-close")) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    if (mode() === "docked") {
      // Start from docked position so the panel tracks the cursor
      windowStartX = dockedLeft();
      windowStartY = DOCK_MARGIN;
      setFloatX(windowStartX);
      setFloatY(windowStartY);
      setFloatW(width());
      setFloatH(window.innerHeight - DOCK_MARGIN * 2);
    } else {
      windowStartX = floatX();
      windowStartY = floatY();
    }
    e.preventDefault();
  }

  // ── Resize ──────────────────────────────────────────────────────────────────

  let resizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  let resizeEdge: "inner" | "corner" = "corner";

  function onResizeEdgeStart(e: MouseEvent) {
    resizing = true;
    resizeEdge = "inner";
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = width();
    resizeStartH = floatH();
    e.preventDefault();
    e.stopPropagation();
  }

  function onResizeCornerStart(e: MouseEvent) {
    resizing = true;
    resizeEdge = "corner";
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = mode() === "floating" ? floatW() : width();
    resizeStartH = floatH();
    e.preventDefault();
    e.stopPropagation();
  }

  // ── Mouse event handlers (global) ───────────────────────────────────────────

  function onMouseMove(e: MouseEvent) {
    if (dragging) {
      const newX = Math.max(0, windowStartX + (e.clientX - dragStartX));
      const newY = Math.max(0, windowStartY + (e.clientY - dragStartY));

      // If docked and dragged far enough, undock
      if (mode() === "docked") {
        const threshold =
          side() === "left"
            ? sidebarOffset() + precedingWidth() + DOCK_THRESHOLD
            : window.innerWidth - DOCK_MARGIN - width() - DOCK_THRESHOLD;
        const movedAway = side() === "left" ? newX > threshold : newX < threshold;

        if (movedAway) {
          undock(props.id);
          setFloatX(newX);
          setFloatY(newY);
        }
      } else {
        setFloatX(newX);
        setFloatY(newY);
      }
    } else if (resizing) {
      if (mode() === "docked") {
        // Width-only resize for docked panels — the overlay repositions reactively
        // through the inset system as the width changes.
        const dx = e.clientX - resizeStartX;
        const dir = side() === "right" ? -1 : 1;
        const newW = Math.max(MIN_WIDTH, resizeStartW + dx * dir);
        setWidth(props.id, newW);
      } else {
        // Free resize for floating
        setFloatW(Math.max(MIN_WIDTH, resizeStartW + (e.clientX - resizeStartX)));
        if (resizeEdge === "corner") {
          setFloatH(Math.max(MIN_HEIGHT, resizeStartH + (e.clientY - resizeStartY)));
        }
      }
    }
  }

  function onMouseUp() {
    if (dragging) {
      // Snap-to-dock if near edges
      if (mode() === "floating") {
        const sidebar = sidebarOffset();
        const nearLeft = floatX() < sidebar + DOCK_THRESHOLD;
        const nearRight = floatX() + floatW() > window.innerWidth - DOCK_THRESHOLD;

        if (nearLeft) {
          dock(props.id, "left");
        } else if (nearRight) {
          dock(props.id, "right");
        } else {
          setPosition(props.id, floatX(), floatY(), floatW(), floatH());
        }
      }
      dragging = false;
    } else if (resizing) {
      if (mode() === "floating") {
        setPosition(props.id, floatX(), floatY(), floatW(), floatH());
      }
      resizing = false;
    }
  }

  function onWindowResize() {
    if (mode() !== "floating") return;
    // Clamp floating position
    const maxX = window.innerWidth - floatW() - DOCK_MARGIN;
    if (floatX() > maxX) setFloatX(Math.max(0, maxX));
    const maxY = window.innerHeight - floatH() - DOCK_MARGIN;
    if (floatY() > maxY) setFloatY(Math.max(0, maxY));
  }

  function onClose() {
    close(props.id);
  }

  onMount(() => {
    register(props.id, {
      mode: props.defaultMode ?? "docked",
      side: props.defaultSide ?? "right",
      width: props.defaultWidth ?? 380,
    });

    const stopInsets = onInsets(setInsets);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("resize", onWindowResize);

    onCleanup(() => {
      deregister(props.id);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", onWindowResize);
      stopInsets?.();
    });
  });

  return (
    <Show
      when={isDesktop()}
      fallback={
        // Mobile: a bottom-drawer dialog instead of a docked/floating panel.
        <Dialog
          show={isOpen()}
          title={props.title}
          expand
          bodyClass="p-0 flex flex-col min-h-0 overflow-hidden"
          onUpdateShow={(v) => {
            if (!v) onClose();
          }}
        >
          {props.children}
        </Dialog>
      }
    >
      {/* Desktop: docked / floating overlay. */}
      <Show when={isOpen()}>
        <div
          class="docked-panel fixed z-50 flex flex-col overflow-hidden rounded-lg border border-neutral-100 bg-neutral-10 shadow-xl"
          style={overlayStyle()}
        >
          {/* Header / drag handle */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the header is the drag surface; the close button inside it is the control. */}
          <div
            class="flex shrink-0 cursor-move select-none items-center gap-2 border-neutral-100 border-b bg-neutral-10 px-3 py-2.5"
            onMouseDown={onDragStart}
          >
            {/* Drag dots */}
            <Icon class="h-3.5 w-3.5 shrink-0 text-neutral-400" name="drag-dots" />
            <span class="flex-1 font-semibold text-neutral-800 text-size-medium">
              {props.title}
            </span>
            {/* Right controls */}
            <div class="panel-close flex items-center gap-0.5">
              <button
                type="button"
                class="rounded-sm p-1 text-neutral-500 transition-colors hover:text-neutral-800"
                onClick={onClose}
              >
                <Icon class="h-3.5 w-3.5" name="cancel" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div class="min-h-0 flex-1 overflow-hidden">{props.children}</div>

          {/* Resize handle: inner edge for docked, corner for floating */}
          <Show
            when={mode() === "docked"}
            fallback={
              // biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only resize affordance; keyboard resizing has no equivalent here.
              <div
                class="absolute right-0 bottom-0 h-4 w-4 cursor-se-resize"
                onMouseDown={onResizeCornerStart}
              >
                <Icon class="h-4 w-4 text-neutral-400" name="resize-handle" />
              </div>
            }
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only resize affordance; keyboard resizing has no equivalent here. */}
            <div
              class="absolute top-0 h-full w-1.5 cursor-ew-resize transition-colors hover:bg-primary-200/30"
              classList={{ "left-0": side() === "right", "right-0": side() !== "right" }}
              onMouseDown={onResizeEdgeStart}
            />
          </Show>
        </div>
      </Show>
    </Show>
  );
}
