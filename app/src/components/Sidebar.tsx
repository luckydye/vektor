import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { lockScroll, unlockScroll } from "#utils/scrollLock.ts";
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

interface Props {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  initialWidth?: number;
  onMobileOpenChange?: (open: boolean, width: number) => void;
  onMobileDragChange?: (offset: number | null) => void;
}

const RESIZE_DRAG_THRESHOLD = 4;
const DRAWER_DRAG_THRESHOLD = 8;
const ANDROID_BACK_GESTURE_INSET = 24;
const SNAP_THRESHOLD = 15;

export function Sidebar(props: Props) {
  const defaultWidth = () => props.defaultWidth ?? DEFAULT_SIDEBAR_WIDTH;
  const minWidth = () => props.minWidth ?? MIN_SIDEBAR_WIDTH;
  const maxWidth = () => props.maxWidth ?? MAX_SIDEBAR_WIDTH;

  let sidebarRef: HTMLDivElement | undefined;
  const initialSidebarWidth = parseSidebarWidth(props.initialWidth, defaultWidth());

  const [currentWidth, setCurrentWidth] = createSignal(initialSidebarWidth);
  const [displayWidth, setDisplayWidth] = createSignal(initialSidebarWidth);
  const [isResizing, setIsResizing] = createSignal(false);
  const [isMobileOpen, setIsMobileOpen] = createSignal(false);
  const [drawerOffset, setDrawerOffset] = createSignal(0);
  const [drawerWidth, setDrawerWidth] = createSignal(initialSidebarWidth);
  const [isDrawerDragging, setIsDrawerDragging] = createSignal(false);

  let hasDragged = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartWidth = 0;
  let drawerPointerId: number | null = null;
  let drawerStartX = 0;
  let drawerStartY = 0;
  let drawerStartOffset = 0;
  let holdsScrollLock = false;

  const isMobileViewport = () => window.matchMedia("(max-width: 767px)").matches;
  const mobileDrawerWidth = () => Math.max(currentWidth(), defaultWidth());

  function setMobileOpen(open: boolean) {
    setIsMobileOpen(open);
    if (open && !holdsScrollLock) {
      lockScroll();
      holdsScrollLock = true;
    } else if (!open && holdsScrollLock) {
      unlockScroll();
      holdsScrollLock = false;
    }
    props.onMobileOpenChange?.(open, mobileDrawerWidth());
  }

  function closeMobileDrawerOnDesktop() {
    if (!isMobileViewport() && isMobileOpen()) setMobileOpen(false);
  }

  const isAndroidBackGestureAt = (clientX: number) =>
    /Android/i.test(navigator.userAgent) && clientX < ANDROID_BACK_GESTURE_INSET;

  function isInsideHorizontallyScrollableContent(
    targets: readonly (EventTarget | undefined)[],
  ) {
    return targets.some((target) => {
      if (!(target instanceof Element)) return false;
      const { overflowX } = getComputedStyle(target);
      return (
        (overflowX === "auto" || overflowX === "scroll") &&
        target.scrollWidth > target.clientWidth
      );
    });
  }

  function isDrawerGestureControl(e: TouchEvent) {
    return e
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target.matches("a-track, input[type='range'], [role='slider']"),
      );
  }

  function startDrawerDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
    startOffset: number,
  ) {
    if (!isMobileViewport()) return false;

    drawerPointerId = pointerId;
    drawerStartX = clientX;
    drawerStartY = clientY;
    drawerStartOffset = startOffset;
    setDrawerOffset(startOffset);
    setDrawerWidth(mobileDrawerWidth());
    setIsDrawerDragging(false);
    sidebarRef?.style.removeProperty("transform");
    return true;
  }

  function startDrawerFromScreen(e: TouchEvent) {
    const touch = e.changedTouches[0];
    if (!touch || e.touches.length !== 1) return;
    if (
      isMobileOpen() ||
      isAndroidBackGestureAt(touch.clientX) ||
      isDrawerGestureControl(e) ||
      isInsideHorizontallyScrollableContent(e.composedPath())
    ) {
      return;
    }
    startDrawerDrag(touch.identifier, touch.clientX, touch.clientY, 0);
  }

  function startDrawerFromSidebar(e: TouchEvent) {
    if (!isMobileOpen()) return;
    const touch = e.changedTouches[0];
    if (
      !touch ||
      e.touches.length !== 1 ||
      isDrawerGestureControl(e) ||
      isInsideHorizontallyScrollableContent(e.composedPath())
    ) {
      return;
    }
    startDrawerDrag(touch.identifier, touch.clientX, touch.clientY, mobileDrawerWidth());
  }

  function startDrawerFromContent(e: TouchEvent) {
    const touch = e.changedTouches[0];
    if (!touch || e.touches.length !== 1) return;
    startDrawerDrag(touch.identifier, touch.clientX, touch.clientY, mobileDrawerWidth());
  }

  function moveDrawerDrag(pointerId: number, clientX: number, clientY: number) {
    if (pointerId !== drawerPointerId) return false;

    const deltaX = clientX - drawerStartX;
    const deltaY = clientY - drawerStartY;
    if (!isDrawerDragging()) {
      if (
        Math.abs(deltaY) > DRAWER_DRAG_THRESHOLD &&
        Math.abs(deltaY) > Math.abs(deltaX)
      ) {
        drawerPointerId = null;
        return false;
      }
      if (Math.abs(deltaX) < DRAWER_DRAG_THRESHOLD) return false;
      const isOpening = drawerStartOffset === 0;
      if ((isOpening && deltaX < 0) || (!isOpening && deltaX > 0)) {
        drawerPointerId = null;
        return false;
      }
      setIsDrawerDragging(true);
    }

    setDrawerOffset(Math.max(0, Math.min(drawerWidth(), drawerStartOffset + deltaX)));
    sidebarRef?.style.setProperty(
      "transform",
      `translateX(${drawerOffset() - drawerWidth()}px)`,
    );
    props.onMobileDragChange?.(drawerOffset());
    return true;
  }

  function stopDrawerDrag(pointerId: number) {
    if (pointerId !== drawerPointerId) return;
    drawerPointerId = null;
    if (!isDrawerDragging()) return;

    setIsDrawerDragging(false);
    props.onMobileDragChange?.(null);
    setMobileOpen(drawerOffset() >= drawerWidth() / 2);
  }

  function cancelDrawerDrag() {
    drawerPointerId = null;
    if (!isDrawerDragging()) return;

    setIsDrawerDragging(false);
    props.onMobileDragChange?.(null);
    setMobileOpen(isMobileOpen());
  }

  function changedDrawerTouch(e: TouchEvent) {
    for (let index = 0; index < e.changedTouches.length; index += 1) {
      const touch = e.changedTouches.item(index);
      if (touch?.identifier === drawerPointerId) return touch;
    }
    return null;
  }

  function handleDrawerTouchMove(e: TouchEvent) {
    const touch = changedDrawerTouch(e);
    if (!touch) return;

    const deltaX = touch.clientX - drawerStartX;
    const deltaY = touch.clientY - drawerStartY;
    const isOpening = drawerStartOffset === 0;
    if ((isOpening ? deltaX > 0 : deltaX < 0) && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (!e.cancelable) {
        cancelDrawerDrag();
        return;
      }
      e.preventDefault();
    }

    moveDrawerDrag(touch.identifier, touch.clientX, touch.clientY);
  }

  const handleScreenDrawerMove = (e: TouchEvent) => {
    if (!isMobileOpen()) handleDrawerTouchMove(e);
  };
  const stopScreenDrawerDrag = (e: TouchEvent) => {
    if (isMobileOpen()) return;
    const touch = changedDrawerTouch(e);
    if (touch) stopDrawerDrag(touch.identifier);
  };
  const handleOpenDrawerMove = (e: TouchEvent) => {
    if (isMobileOpen()) handleDrawerTouchMove(e);
  };
  // Not `onTouchMove`: Solid delegates touchmove to the document, where the
  // browser forces the listener passive, so the drag's preventDefault() is a
  // no-op and the gesture bails out on the uncancelable event.
  const closeDrawerMoveListener = {
    handleEvent: handleOpenDrawerMove,
    passive: false,
  };
  const stopOpenDrawerDrag = (e: TouchEvent) => {
    if (!isMobileOpen()) return;
    const touch = changedDrawerTouch(e);
    if (touch) stopDrawerDrag(touch.identifier);
  };

  function dispatchSidebarResize() {
    window.dispatchEvent(
      new CustomEvent("sidebar:resize", { detail: { width: currentWidth() } }),
    );
  }

  function persistSidebarWidth(width: number) {
    const parsedWidth = parseSidebarWidth(width, defaultWidth());
    localStorage.setItem(SIDEBAR_WIDTH_KEY, parsedWidth.toString());
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

    // Past either bound the handle keeps moving, but at a fifth of the speed —
    // the rubber-band that tells you there is nothing further.
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

    // A press with no movement is a click on the handle, which toggles.
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
    document.addEventListener("touchstart", startDrawerFromScreen, { capture: true });
    document.addEventListener("touchmove", handleScreenDrawerMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchend", stopScreenDrawerDrag, { capture: true });
    document.addEventListener("touchcancel", stopScreenDrawerDrag, { capture: true });

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
        // A microtask, not `nextTick`: subscribers measure against the new
        // width, so the resize event has to follow the DOM write rather than
        // ride along with it.
        queueMicrotask(() => window.dispatchEvent(new Event("resize")));
      },
    });

    Actions.register("sidebar:toggle-mobile", {
      title: t("Toggle Mobile Sidebar"),
      description: t("Open or close the mobile sidebar menu"),
      group: "navigation",
      run: async () => setMobileOpen(!isMobileOpen()),
    });

    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const resolved = savedWidth
      ? parseSidebarWidth(savedWidth, initialSidebarWidth)
      : initialSidebarWidth;
    setCurrentWidth(resolved);
    setDisplayWidth(resolved);
    persistSidebarWidth(resolved);

    // Publish the resolved width so subscribers (page insets, toolbar, docked
    // panels) sync to the actual component state on mount.
    dispatchSidebarResize();
  });

  onCleanup(() => {
    // Solid runs cleanup when it disposes the *server* render tree too.
    // Everything below is browser teardown, and reaching `window` during SSR
    // crashes the render.
    if (isServer) return;

    window.removeEventListener("resize", closeMobileDrawerOnDesktop);
    document.removeEventListener("touchstart", startDrawerFromScreen, true);
    document.removeEventListener("touchmove", handleScreenDrawerMove, true);
    document.removeEventListener("touchend", stopScreenDrawerDrag, true);
    document.removeEventListener("touchcancel", stopScreenDrawerDrag, true);
    props.onMobileDragChange?.(null);
    if (holdsScrollLock) {
      unlockScroll();
      holdsScrollLock = false;
    }
    props.onMobileOpenChange?.(false, mobileDrawerWidth());
    Actions.unregister("ui:toggle:sidebar");
    Actions.unregister("sidebar:toggle-mobile");
  });

  return (
    <div>
      {/* The open drawer is modal on mobile: drag anywhere in the exposed
          content area to push it back to the left. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer gestures are this control's only interaction. */}
      <Show when={isMobileOpen()}>
        <div
          class="fixed inset-y-0 right-0 z-40 touch-pan-y md:hidden"
          style={{ left: `${mobileDrawerWidth()}px` }}
          onTouchStart={startDrawerFromContent}
          on:touchmove={closeDrawerMoveListener}
          onTouchEnd={stopOpenDrawerDrag}
          onTouchCancel={stopOpenDrawerDrag}
        />
      </Show>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: closes the drawer when a link inside it is followed. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the links themselves are the keyboard path. */}
      <div
        ref={sidebarRef}
        style={{
          "--sidebar-rendered-width": `${displayWidth()}px`,
          "--mobile-sidebar-width": `${mobileDrawerWidth()}px`,
          transform: isDrawerDragging()
            ? `translateX(${drawerOffset() - drawerWidth()}px)`
            : undefined,
          transition: isDrawerDragging() ? "none" : undefined,
          "--color-background": "var(--color-neutral-25)",
        }}
        class={twMerge(
          "@container sidebar flex p-1.5",
          "fixed top-0 bottom-0 w-(--mobile-sidebar-width) touch-pan-y transition-transform will-change-transform md:w-(--sidebar-rendered-width)",
          "z-40 md:z-10",
          "md:translate-x-0",
          isMobileOpen() || isDrawerDragging() ? "translate-x-0" : "-translate-x-full",
        )}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.tagName === "A" || target.closest("a")) setMobileOpen(false);
        }}
        onTouchStart={startDrawerFromSidebar}
        on:touchmove={closeDrawerMoveListener}
        onTouchEnd={stopOpenDrawerDrag}
        onTouchCancel={stopOpenDrawerDrag}
      >
        <span
          aria-hidden="true"
          class="absolute top-1/2 left-full ml-1 h-12 w-1 -translate-y-1/2 rounded-full bg-neutral-300/70 md:hidden"
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
          <Icon name="collapse" class="w-4" />
        </button>

        {/* The grain pseudo-element paints after the blur one, so it also lands
            above in-flow content — the children need a z-index to stay on top. */}
        <div class="relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-background/90 before:backdrop-surface-blur after:surface-noise [&>*]:relative [&>*]:z-10">
          <Navigation />
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle, not a control. */}
        <div
          class={twMerge(
            "group absolute top-2 right-1 bottom-2 z-20 hidden w-1 cursor-col-resize transition-colors hover:bg-primary-200/50 md:block",
            isResizing() ? "bg-primary-200/50 active:bg-primary-200" : "",
          )}
          onMouseDown={startResize}
        >
          <div class="absolute inset-y-0 -right-1 w-3" />
        </div>
      </div>
    </div>
  );
}
