import {
  buildTransform,
  computeFitScale,
  type ScreenSize,
  screenToWorld,
} from "./transform.ts";
import type { FitReference, ViewportCamera } from "./types.ts";

export interface ViewportZoomLimits {
  minZoom?: number;
  maxZoom?: number;
}

export interface PanCameraByScreenDeltaOptions {
  camera: ViewportCamera;
  screen: ScreenSize;
  fit: FitReference;
  dxPx: number;
  dyPx: number;
}

export interface ZoomCameraAtPointOptions extends ViewportZoomLimits {
  camera: ViewportCamera;
  screen: ScreenSize;
  fit: FitReference;
  screenX: number;
  screenY: number;
  zoom: number;
}

export interface ViewportControlsOptions extends ViewportZoomLimits {
  target: Window | HTMLElement;
  getCamera: () => ViewportCamera;
  setCamera: (camera: ViewportCamera) => void;
  getScreen: () => ScreenSize;
  getFit: () => FitReference;
  onTouchGestureStart?: () => void;
  onTwoFingerTap?: () => void;
  wheelZoomSpeed?: number;
  pinchZoomSpeed?: number;
}

export interface ViewportControls {
  dispose: () => void;
}

interface TouchGestureState {
  centerX: number;
  centerY: number;
  distance: number;
}

interface LastTouchGesture extends TouchGestureState {
  zoom: number;
}

type TouchStart = {
  clientX: number;
  clientY: number;
  timeStamp: number;
};

type TwoFingerTapCandidate = {
  pointerIds: Set<number>;
  starts: Map<number, TouchStart>;
  released: Set<number>;
  startedAt: number;
  valid: boolean;
};

const TWO_FINGER_TAP_MAX_INTERVAL_MS = 180;
const TWO_FINGER_TAP_MAX_DURATION_MS = 320;
const TWO_FINGER_TAP_MOVE_TOLERANCE_PX = 12;

function targetPoint(target: Window | HTMLElement, clientX: number, clientY: number) {
  if (target instanceof Window) {
    return { x: clientX, y: clientY };
  }

  const rect = target.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

export function panCameraByScreenDelta({
  camera,
  screen,
  fit,
  dxPx,
  dyPx,
}: PanCameraByScreenDeltaOptions): ViewportCamera {
  const transform = buildTransform(camera, screen, fit);
  return {
    zoom: camera.zoom,
    centerX: camera.centerX + dxPx / transform.scale,
    centerY: camera.centerY + dyPx / transform.scale,
  };
}

export function zoomCameraAtPoint({
  camera,
  screen,
  fit,
  screenX,
  screenY,
  zoom,
  minZoom = 0.2,
  maxZoom = 20,
}: ZoomCameraAtPointOptions): ViewportCamera {
  const before = buildTransform(camera, screen, fit);
  const anchor = screenToWorld(screenX, screenY, before);
  const nextZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
  const fitScale = computeFitScale(screen, fit);
  const newScale = fitScale * nextZoom;

  return {
    zoom: nextZoom,
    centerX: anchor.x - (screenX - screen.width / 2) / newScale,
    centerY: anchor.y - (screenY - screen.height / 2) / newScale,
  };
}

export function createViewportControls({
  target,
  getCamera,
  setCamera,
  getScreen,
  getFit,
  onTouchGestureStart,
  onTwoFingerTap,
  minZoom = 0.2,
  maxZoom = 20,
  wheelZoomSpeed = 0.001,
  pinchZoomSpeed = 0.01,
}: ViewportControlsOptions): ViewportControls {
  const touchPointers = new Map<number, PointerEvent>();
  const touchStarts = new Map<number, TouchStart>();
  let lastTouchGesture: LastTouchGesture | null = null;
  let touchGestureActive = false;
  let twoFingerTapCandidate: TwoFingerTapCandidate | null = null;

  function pointerStayedWithinTapTolerance(
    pointerId: number,
    event: Pick<PointerEvent, "clientX" | "clientY">,
    candidate: TwoFingerTapCandidate,
  ) {
    const start = candidate.starts.get(pointerId);
    return Boolean(
      start &&
        Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) <=
          TWO_FINGER_TAP_MOVE_TOLERANCE_PX,
    );
  }

  function updateTwoFingerTapCandidate(e: PointerEvent) {
    const candidate = twoFingerTapCandidate;
    if (!candidate?.pointerIds.has(e.pointerId)) return;
    if (
      e.timeStamp - candidate.startedAt > TWO_FINGER_TAP_MAX_DURATION_MS ||
      !pointerStayedWithinTapTolerance(e.pointerId, e, candidate)
    ) {
      candidate.valid = false;
    }
  }

  function beginTwoFingerTapCandidate(e: PointerEvent) {
    if (touchPointers.size > 2) {
      if (twoFingerTapCandidate) twoFingerTapCandidate.valid = false;
      return;
    }
    if (touchPointers.size !== 2) return;

    const pointerIds = new Set(touchPointers.keys());
    const starts = new Map<number, TouchStart>();
    for (const pointerId of pointerIds) {
      const start = touchStarts.get(pointerId);
      if (start) starts.set(pointerId, start);
    }
    if (starts.size !== 2) return;

    const startedAt = Math.min(
      ...Array.from(starts.values(), (start) => start.timeStamp),
    );
    const latestStartedAt = Math.max(
      ...Array.from(starts.values(), (start) => start.timeStamp),
    );
    const candidate: TwoFingerTapCandidate = {
      pointerIds,
      starts,
      released: new Set(),
      startedAt,
      valid: latestStartedAt - startedAt <= TWO_FINGER_TAP_MAX_INTERVAL_MS,
    };
    for (const [pointerId, pointer] of touchPointers) {
      if (!pointerStayedWithinTapTolerance(pointerId, pointer, candidate)) {
        candidate.valid = false;
      }
    }
    twoFingerTapCandidate = candidate;
    updateTwoFingerTapCandidate(e);
  }

  function touchGestureState(): TouchGestureState | null {
    const pointers = Array.from(touchPointers.values());
    if (pointers.length < 2) return null;

    const [a, b] = pointers;
    const center = targetPoint(
      target,
      (a.clientX + b.clientX) / 2,
      (a.clientY + b.clientY) / 2,
    );
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    return { centerX: center.x, centerY: center.y, distance };
  }

  function beginTouchPointer(e: PointerEvent) {
    if (e.pointerType !== "touch") return;

    touchStarts.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      timeStamp: e.timeStamp,
    });
    touchPointers.set(e.pointerId, e);
    beginTwoFingerTapCandidate(e);
    if (touchPointers.size < 2) return;

    const gesture = touchGestureState();
    if (gesture) {
      touchGestureActive = true;
      lastTouchGesture = { ...gesture, zoom: getCamera().zoom };
      onTouchGestureStart?.();
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function moveTouchPointer(e: PointerEvent) {
    if (e.pointerType !== "touch" || !touchPointers.has(e.pointerId)) return;

    touchPointers.set(e.pointerId, e);
    const gesture = touchGestureState();
    if (!gesture || !touchGestureActive || !lastTouchGesture) return;

    e.preventDefault();
    e.stopPropagation();

    updateTwoFingerTapCandidate(e);
    // Hold the camera still while this can still be a tap. Once either finger
    // crosses the tolerance, the same event falls through and starts pan/zoom
    // from the original two-finger gesture state.
    if (twoFingerTapCandidate?.valid) return;

    const screen = getScreen();
    const fit = getFit();
    const panned = panCameraByScreenDelta({
      camera: getCamera(),
      screen,
      fit,
      dxPx: lastTouchGesture.centerX - gesture.centerX,
      dyPx: lastTouchGesture.centerY - gesture.centerY,
    });
    const zoomed = zoomCameraAtPoint({
      camera: panned,
      screen,
      fit,
      screenX: gesture.centerX,
      screenY: gesture.centerY,
      zoom: lastTouchGesture.zoom * (gesture.distance / lastTouchGesture.distance),
      minZoom,
      maxZoom,
    });
    setCamera(zoomed);
    lastTouchGesture = { ...gesture, zoom: zoomed.zoom };
  }

  function endTouchPointer(e: PointerEvent) {
    if (e.pointerType !== "touch" || !touchPointers.has(e.pointerId)) return;

    const wasGestureActive = touchGestureActive;
    const candidate = twoFingerTapCandidate;
    const wasTwoFingerTapSequence = Boolean(candidate?.pointerIds.has(e.pointerId));
    let completedTwoFingerTap = false;
    if (candidate?.pointerIds.has(e.pointerId)) {
      updateTwoFingerTapCandidate(e);
      if (e.type === "pointercancel") candidate.valid = false;
      candidate.released.add(e.pointerId);
      if (candidate.released.size === candidate.pointerIds.size) {
        completedTwoFingerTap =
          candidate.valid &&
          e.timeStamp - candidate.startedAt <= TWO_FINGER_TAP_MAX_DURATION_MS;
        twoFingerTapCandidate = null;
      }
    }
    touchPointers.delete(e.pointerId);
    touchStarts.delete(e.pointerId);
    if (touchPointers.size >= 2) {
      const gesture = touchGestureState();
      lastTouchGesture = gesture ? { ...gesture, zoom: getCamera().zoom } : null;
    } else {
      touchGestureActive = false;
      lastTouchGesture = null;
    }

    if (wasGestureActive || wasTwoFingerTapSequence) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (completedTwoFingerTap) onTwoFingerTap?.();
  }

  let wheelRafId: number | null = null;
  let pendingDx = 0;
  let pendingDy = 0;
  let pendingZoom = 1;
  let pendingZoomX = 0;
  let pendingZoomY = 0;

  function flushWheel() {
    wheelRafId = null;
    const camera = getCamera();
    const screen = getScreen();
    const fit = getFit();

    let result = camera;
    if (pendingDx !== 0 || pendingDy !== 0) {
      result = panCameraByScreenDelta({
        camera: result,
        screen,
        fit,
        dxPx: pendingDx,
        dyPx: pendingDy,
      });
      pendingDx = 0;
      pendingDy = 0;
    }
    if (pendingZoom !== 1) {
      result = zoomCameraAtPoint({
        camera: result,
        screen,
        fit,
        screenX: pendingZoomX,
        screenY: pendingZoomY,
        zoom: result.zoom * pendingZoom,
        minZoom,
        maxZoom,
      });
      pendingZoom = 1;
    }
    setCamera(result);
  }

  function handleViewportWheel(e: WheelEvent) {
    e.preventDefault();
    const pointer = targetPoint(target, e.clientX, e.clientY);

    if (e.ctrlKey || e.metaKey) {
      // ctrlKey without metaKey = trackpad pinch (browser-synthesised).
      // metaKey (or real ctrl+scroll) = mouse wheel zoom.
      const speed =
        e.ctrlKey && Math.abs(e.deltaY) >= 100 ? wheelZoomSpeed : pinchZoomSpeed;
      pendingZoom *= Math.exp(-e.deltaY * speed);
      pendingZoomX = pointer.x;
      pendingZoomY = pointer.y;
    } else {
      pendingDx += e.deltaX;
      pendingDy += e.deltaY;
    }

    if (wheelRafId === null) {
      wheelRafId = requestAnimationFrame(flushWheel);
    }
  }

  function preventNativeViewportGesture(e: Event) {
    e.preventDefault();
  }

  target.addEventListener("pointerdown", beginTouchPointer as EventListener, {
    capture: true,
    passive: false,
  });
  target.addEventListener("pointermove", moveTouchPointer as EventListener, {
    capture: true,
    passive: false,
  });
  target.addEventListener("pointerup", endTouchPointer as EventListener, {
    capture: true,
    passive: false,
  });
  target.addEventListener("pointercancel", endTouchPointer as EventListener, {
    capture: true,
    passive: false,
  });
  target.addEventListener("wheel", handleViewportWheel as EventListener, {
    capture: true,
    passive: false,
  });
  target.addEventListener("gesturestart", preventNativeViewportGesture, {
    passive: false,
  });
  target.addEventListener("gesturechange", preventNativeViewportGesture, {
    passive: false,
  });
  target.addEventListener("gestureend", preventNativeViewportGesture, { passive: false });

  return {
    dispose() {
      target.removeEventListener("pointerdown", beginTouchPointer as EventListener, {
        capture: true,
      });
      target.removeEventListener("pointermove", moveTouchPointer as EventListener, {
        capture: true,
      });
      target.removeEventListener("pointerup", endTouchPointer as EventListener, {
        capture: true,
      });
      target.removeEventListener("pointercancel", endTouchPointer as EventListener, {
        capture: true,
      });
      target.removeEventListener("wheel", handleViewportWheel as EventListener, {
        capture: true,
      });
      target.removeEventListener("gesturestart", preventNativeViewportGesture);
      target.removeEventListener("gesturechange", preventNativeViewportGesture);
      target.removeEventListener("gestureend", preventNativeViewportGesture);
      touchPointers.clear();
      touchStarts.clear();
      touchGestureActive = false;
      lastTouchGesture = null;
      twoFingerTapCandidate = null;
      if (wheelRafId !== null) {
        cancelAnimationFrame(wheelRafId);
        wheelRafId = null;
      }
    },
  };
}
