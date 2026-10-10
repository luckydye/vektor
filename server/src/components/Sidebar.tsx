import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { Actions } from "#utils/actions.ts";
import { readStored, storedText, writeStored } from "#utils/clientStorage.ts";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseSidebarWidth,
  SIDEBAR_WIDTH_KEY,
  writeSidebarWidthCookie,
} from "#utils/sidebarState.ts";
import { Icon } from "./Icon.tsx";
import { Navigation } from "./Navigation.tsx";
import { useSwipeDrawer } from "#composeables/useSwipeDrawer.ts";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  initialWidth?: number;
}

const RESIZE_DRAG_THRESHOLD = 4;
const SNAP_THRESHOLD = 15;

export function Sidebar(props: Props) {
  const t = useTranslation();

  const defaultWidth = () => props.defaultWidth ?? DEFAULT_SIDEBAR_WIDTH;
  const minWidth = () => props.minWidth ?? MIN_SIDEBAR_WIDTH;
  const maxWidth = () => props.maxWidth ?? MAX_SIDEBAR_WIDTH;

  let sidebarRef: HTMLDivElement | undefined;
  const initialSidebarWidth = parseSidebarWidth(props.initialWidth, defaultWidth());

  const [currentWidth, setCurrentWidth] = createSignal(initialSidebarWidth);
  const [displayWidth, setDisplayWidth] = createSignal(initialSidebarWidth);
  const [isResizing, setIsResizing] = createSignal(false);
  const [isMobileOpen, setIsMobileOpen] = createSignal(false);

  let hasDragged = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartWidth = 0;

  const isMobileViewport = () => window.matchMedia("(max-width: 767px)").matches;
  const mobileDrawerWidth = () => Math.max(currentWidth(), defaultWidth());

  const drawer = useSwipeDrawer({
    side: "left",
    size: mobileDrawerWidth,
    openFromScreen: true,
    isOpen: isMobileOpen,
    setOpen: setIsMobileOpen,
  });

  function closeMobileDrawerOnDesktop() {
    if (!isMobileViewport() && isMobileOpen()) setIsMobileOpen(false);
  }

  function dispatchSidebarResize() {
    window.dispatchEvent(
      new CustomEvent("sidebar:resize", { detail: { width: currentWidth() } }),
    );
  }

  function persistSidebarWidth(width: number) {
    const parsedWidth = parseSidebarWidth(width, defaultWidth());
    writeStored(SIDEBAR_WIDTH_KEY, parsedWidth.toString(), storedText);
    writeSidebarWidthCookie(parsedWidth);
  }

  function handleResize(e: MouseEvent) {
    if (!isResizing() || !sidebarRef) return;

    const deltaX = e.clientX - resizeStartX;
    const deltaY = e.clientY - resizeStartY;
    if (!hasDragged) {
      if (Math.hypot(deltaX, deltaY) < RESIZE_DRAG_THRESHOLD) return;
      hasDragged = true;
    }

    let newWidth = resizeStartWidth + deltaX;
    if (Math.abs(newWidth - defaultWidth()) <= SNAP_THRESHOLD) newWidth = defaultWidth();
    else if (Math.abs(newWidth - minWidth()) <= SNAP_THRESHOLD) newWidth = minWidth();

    if (newWidth < minWidth()) {
      setDisplayWidth(minWidth() - (minWidth() - newWidth) * 0.2);
    } else if (newWidth > maxWidth()) {
      setDisplayWidth(maxWidth() + (newWidth - maxWidth()) * 0.2);
    } else {
      setDisplayWidth(newWidth);
    }

    setCurrentWidth(Math.max(minWidth(), Math.min(maxWidth(), displayWidth())));
    dispatchSidebarResize();
  }

  function stopResize() {
    const didDrag = hasDragged;
    setIsResizing(false);
    document.removeEventListener("mousemove", handleResize);
    document.removeEventListener("mouseup", stopResize);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    if (!didDrag) {
      Actions.run("ui:toggle:sidebar");
      return;
    }

    const clamped = Math.max(minWidth(), Math.min(maxWidth(), displayWidth()));
    setCurrentWidth(clamped);
    setDisplayWidth(clamped);
    persistSidebarWidth(clamped);
    dispatchSidebarResize();
  }

  function startResize(e: MouseEvent) {
    setIsResizing(true);
    hasDragged = false;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = currentWidth();
    e.preventDefault();
    e.stopPropagation();

    document.addEventListener("mousemove", handleResize);
    document.addEventListener("mouseup", stopResize);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  onMount(() => {
    window.addEventListener("resize", closeMobileDrawerOnDesktop);

    Actions.register("ui:toggle:sidebar", {
      title: t("Toggle Sidebar"),
      description: t("Open or close the sidebar menu"),
      group: "navigation",
      run: async () => {
        const targetWidth = currentWidth() === minWidth() ? defaultWidth() : minWidth();
        setCurrentWidth(targetWidth);
        setDisplayWidth(targetWidth);
        persistSidebarWidth(targetWidth);
        dispatchSidebarResize();
        queueMicrotask(() => window.dispatchEvent(new Event("resize")));
      },
    });

    Actions.register("sidebar:toggle-mobile", {
      title: t("Toggle Mobile Sidebar"),
      description: t("Open or close the mobile sidebar menu"),
      group: "navigation",
      run: async () => setIsMobileOpen(!isMobileOpen()),
    });

    const savedWidth = readStored(SIDEBAR_WIDTH_KEY, storedText);
    const resolved = savedWidth
      ? parseSidebarWidth(savedWidth, initialSidebarWidth)
      : initialSidebarWidth;
    setCurrentWidth(resolved);
    setDisplayWidth(resolved);
    persistSidebarWidth(resolved);

    dispatchSidebarResize();
  });

  onCleanup(() => {
    if (isServer) return;

    window.removeEventListener("resize", closeMobileDrawerOnDesktop);
    Actions.unregister("ui:toggle:sidebar");
    Actions.unregister("sidebar:toggle-mobile");
  });

  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer gestures are this control's only interaction. */}
      <Show when={isMobileOpen()}>
        <div
          class="fixed inset-y-0 right-0 z-40 touch-pan-y md:hidden"
          style={{ left: `${mobileDrawerWidth()}px` }}
          onTouchStart={drawer.startFromDrawer}
        />
      </Show>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: closes the drawer when a link inside it is followed. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the links themselves are the keyboard path. */}
      <div
        ref={sidebarRef}
        style={{
          "--sidebar-rendered-width": `${displayWidth()}px`,
          "--mobile-sidebar-width": `${mobileDrawerWidth()}px`,
          translate: drawer.translate(),
          transition: drawer.transition(),
          "--color-background": "var(--color-neutral-10)",
        }}
        class={twMerge(
          "@container sidebar flex p-1.5",
          "fixed top-0 bottom-0 w-(--mobile-sidebar-width) touch-pan-y transition-transform will-change-transform md:w-(--sidebar-rendered-width)",
          "z-40 md:z-10",
          "md:translate-x-0",
          isMobileOpen() || drawer.isDragging() ? "translate-x-0" : "-translate-x-full",
        )}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.tagName === "A" || target.closest("a")) setIsMobileOpen(false);
        }}
        onTouchStart={drawer.startFromDrawer}
      >
        <span
          aria-hidden="true"
          class="absolute top-1/2 -right-2 md:right-1 h-20 w-1 -translate-y-1/2 rounded-full bg-neutral-300/30 z-20"
        />

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            Actions.run("ui:toggle:sidebar");
          }}
          class="absolute -right-3 bottom-7 z-50 hidden rounded-full bg-background p-2 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 md:block"
          title={currentWidth() === minWidth() ? "Expand sidebar" : "Collapse sidebar"}
        >
          <Icon name="collapse-sidebar" class="block h-4 w-4" />
        </button>

        <div class={twMerge(
          "sidebar-panel after:surface-noise relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-background *:relative *:z-10 transition-shadow border border-neutral-50",
          (drawer.isDragging() || isMobileOpen()) && "shadow-2xl"
        )}>
          <Navigation />
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle, not a control. */}
        <div
          class={twMerge(
            "sidebar-resize-handle group absolute top-2 right-1 bottom-2 z-20 hidden w-1 cursor-col-resize transition-colors hover:bg-neutral-200/50 md:block rounded-[99px]",
            isResizing() ? "bg-neutral-200 active:bg-neutral-200" : "",
          )}
          onMouseDown={startResize}
        >
          <div class="absolute inset-y-0 -right-1 w-3" />
        </div>
      </div>
    </div>
  );
}
