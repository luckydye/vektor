/**
 * Vector point editing for a geo: its outline becomes a "path" whose points are
 * dragged, inserted on a segment, and deleted, with bezier handles pulled out
 * by Alt. Points are stored 0..1 across the frame, so the shape keeps resizing
 * and rotating as a box; the frame is refitted to the points when editing ends.
 */

import {
  geoOutline,
  geoStyle,
  type StoredPathPoint,
  storedPathPoints,
} from "#canvas/render/shapeGeometry.ts";
import { flattenPath } from "#canvas/render/vector.ts";
import type {
  CanvasExtensionHost,
  CanvasPoint,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { pointOnRotatedShape } from "#canvas/runtime/geometry.ts";
import type {
  CanvasEditMode,
  CanvasEditModeSession,
  CanvasEditPointer,
  CanvasOverlayItem,
} from "#canvas/runtime/plugins.ts";

const GRAB = 8;
const ACCENT = "#2563eb";

type Grip = { kind: "node" | "in" | "out"; index: number };

/** The geo's outline as normalized path points, whatever kind it is now. */
function asPath(shape: CanvasShape): { points: StoredPathPoint[]; closed: boolean } {
  const style = geoStyle(shape.data);
  if (style.kind === "path") {
    return { points: storedPathPoints(shape.data), closed: shape.data.closed !== false };
  }
  const { width, height } = shape.frame;
  const outline = geoOutline(style.kind, shape.frame, shape.data);
  const local = (point: CanvasPoint) => ({ x: point.x / width, y: point.y / height });
  return {
    points: outline.nodes.map((node) => ({
      ...local(node),
      in: node.in && local(node.in),
      out: node.out && local(node.out),
    })),
    closed: outline.closed,
  };
}

function splitCubic(a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint, t: number) {
  const lerp = (p: CanvasPoint, q: CanvasPoint) => ({
    x: p.x + (q.x - p.x) * t,
    y: p.y + (q.y - p.y) * t,
  });
  const ab = lerp(a, b);
  const bc = lerp(b, c);
  const cd = lerp(c, d);
  const abc = lerp(ab, bc);
  const bcd = lerp(bc, cd);
  return { aOut: ab, in: abc, at: lerp(abc, bcd), out: bcd, dIn: cd };
}

/** Drops absent handles: stored data has no `undefined`. */
function storable(point: StoredPathPoint): StoredPathPoint {
  return {
    x: point.x,
    y: point.y,
    ...(point.in ? { in: point.in } : {}),
    ...(point.out ? { out: point.out } : {}),
  };
}

export function beginPointEdit(shape: CanvasShape, host: CanvasExtensionHost) {
  const initial = asPath(shape);
  if (geoStyle(shape.data).kind !== "path") {
    host.updateData(shape.id, {
      kind: "path",
      points: initial.points.map(storable),
      closed: initial.closed,
    });
  }
  let selected: number | null = null;
  let grip: Grip | null = null;
  let last: CanvasPoint | null = null;

  const points = (session: CanvasEditModeSession) =>
    storedPathPoints(session.shape().data);
  const closed = (session: CanvasEditModeSession) => session.shape().data.closed !== false;
  const write = (next: StoredPathPoint[]) =>
    host.updateData(shape.id, { points: next.map(storable) });

  const distance = (session: CanvasEditModeSession, a: CanvasPoint, b: CanvasPoint) => {
    const scale = session.scale();
    return Math.hypot((a.x - b.x) * scale.x, (a.y - b.y) * scale.y);
  };

  const gripAt = (session: CanvasEditModeSession, at: CanvasPoint): Grip | null => {
    const nodes = points(session);
    if (selected !== null) {
      const node = nodes[selected];
      for (const kind of ["in", "out"] as const) {
        const handle = node?.[kind];
        if (handle && distance(session, handle, at) <= GRAB) return { kind, index: selected };
      }
    }
    const index = nodes.findIndex((node) => distance(session, node, at) <= GRAB);
    return index >= 0 ? { kind: "node", index } : null;
  };

  /** Splits the segment under `at`, keeping its curve, and returns the new point's index. */
  const insertAt = (session: CanvasEditModeSession, at: CanvasPoint): number | null => {
    const nodes = points(session);
    const count = closed(session) ? nodes.length : nodes.length - 1;
    for (let i = 0; i < count; i++) {
      const a = nodes[i];
      const d = nodes[(i + 1) % nodes.length];
      const b = a.out ?? a;
      const c = d.in ?? d;
      let best = { t: 0, distance: Number.POSITIVE_INFINITY };
      for (let step = 1; step < 64; step++) {
        const t = step / 64;
        const point = splitCubic(a, b, c, d, t).at;
        const gap = distance(session, point, at);
        if (gap < best.distance) best = { t, distance: gap };
      }
      if (best.distance > GRAB) continue;
      const curved = Boolean(a.out || d.in);
      const split = splitCubic(a, b, c, d, best.t);
      const next = nodes.map((node) => ({ ...node }));
      if (curved) {
        next[i] = { ...next[i], out: split.aOut };
        next[(i + 1) % nodes.length] = { ...next[(i + 1) % nodes.length], in: split.dIn };
      }
      const inserted = curved
        ? { ...split.at, in: split.in, out: split.out }
        : { ...split.at };
      next.splice(i + 1, 0, inserted);
      write(next);
      return i + 1;
    }
    return null;
  };

  const overlay = (session: CanvasEditModeSession) => {
    const nodes = points(session);
    const items: CanvasOverlayItem[] = [
      {
        kind: "path",
        unit: "screen",
        points: flattenPath(nodes, closed(session), 0.002),
        width: 1.5,
        color: ACCENT,
      },
    ];
    const node = selected === null ? undefined : nodes[selected];
    for (const handle of [node?.in, node?.out]) {
      if (!node || !handle) continue;
      items.push({ kind: "path", unit: "screen", points: [node, handle], width: 1, color: ACCENT });
      items.push({ kind: "circle", unit: "screen", center: handle, radius: 3.5, fill: "#ffffff", stroke: ACCENT, strokeWidth: 1.5 });
    }
    nodes.forEach((point, index) => {
      items.push({
        kind: "circle",
        unit: "screen",
        center: point,
        radius: 4.5,
        fill: index === selected ? ACCENT : "#ffffff",
        stroke: ACCENT,
        strokeWidth: 1.5,
      });
    });
    session.setOverlay(items);
  };

  const mode: CanvasEditMode = {
    onPointerDown(input: CanvasEditPointer, session) {
      const at = input.local;
      last = at;
      grip = gripAt(session, at);
      if (grip?.kind === "node") {
        selected = grip.index;
        if (input.event.altKey) {
          const nodes = points(session);
          const node = nodes[grip.index];
          if (node.in || node.out) {
            nodes[grip.index] = { x: node.x, y: node.y };
            write(nodes);
            grip = null;
          } else {
            // Alt-dragging a corner pulls out mirrored handles from it.
            nodes[grip.index] = { ...node, in: { ...node }, out: { ...node } };
            write(nodes);
            grip = { kind: "out", index: grip.index };
          }
        }
      } else if (!grip) {
        const index = insertAt(session, at);
        if (index !== null) {
          selected = index;
          grip = { kind: "node", index };
        } else if (!input.inside) {
          session.exit();
          return;
        } else {
          selected = null;
        }
      }
      overlay(session);
    },
    onPointerMove(input, session) {
      if (!grip || !last) return;
      const at = input.local;
      const dx = at.x - last.x;
      const dy = at.y - last.y;
      last = at;
      const nodes = points(session);
      const node = nodes[grip.index];
      if (!node) return;
      const shift = (point: CanvasPoint | undefined) =>
        point && { x: point.x + dx, y: point.y + dy };
      if (grip.kind === "node") {
        nodes[grip.index] = { x: node.x + dx, y: node.y + dy, in: shift(node.in), out: shift(node.out) };
      } else {
        const other = grip.kind === "in" ? "out" : "in";
        const moved = { ...at };
        // Keep the handles opposite each other, so the point stays smooth.
        const mirrored = node[other] && { x: node.x * 2 - moved.x, y: node.y * 2 - moved.y };
        nodes[grip.index] = { ...node, [grip.kind]: moved, [other]: mirrored };
      }
      write(nodes);
      overlay(session);
    },
    onPointerUp() {
      grip = null;
      last = null;
    },
    onHover(input, session) {
      session.setCursor(input && gripAt(session, input.local) ? "pointer" : null);
    },
    onKey(event, session) {
      if (event.key === "Enter") {
        session.exit();
        return true;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selected !== null) {
        const nodes = points(session);
        if (nodes.length <= (closed(session) ? 3 : 2)) return true;
        nodes.splice(selected, 1);
        selected = null;
        write(nodes);
        overlay(session);
        return true;
      }
      return false;
    },
    onView: overlay,
    onExit() {
      refit(host, shape.id);
    },
  };
  const session = host.beginEditMode(shape.id, mode);
  if (session) overlay(session);
}

/** Moves the frame onto the edited points, so selection and resizing hug the outline. */
function refit(host: CanvasExtensionHost, id: string) {
  const shape = host.shape(id);
  if (!shape) return;
  const { width, height } = shape.frame;
  const nodes = storedPathPoints(shape.data);
  const flat = flattenPath(
    nodes.map((node) => ({
      x: node.x * width,
      y: node.y * height,
      in: node.in && { x: node.in.x * width, y: node.in.y * height },
      out: node.out && { x: node.out.x * width, y: node.out.y * height },
    })),
    shape.data.closed !== false,
    0.5,
  );
  if (flat.length === 0) return;
  const x0 = Math.min(...flat.map((point) => point.x));
  const y0 = Math.min(...flat.map((point) => point.y));
  const w = Math.max(1, Math.max(...flat.map((point) => point.x)) - x0);
  const h = Math.max(1, Math.max(...flat.map((point) => point.y)) - y0);
  if (Math.abs(x0) < 0.5 && Math.abs(y0) < 0.5 && Math.abs(w - width) < 0.5 && Math.abs(h - height) < 0.5) {
    return;
  }
  const center = pointOnRotatedShape(shape.frame, { x: x0 + w / 2, y: y0 + h / 2 });
  const map = (point: CanvasPoint) => ({
    x: (point.x * width - x0) / w,
    y: (point.y * height - y0) / h,
  });
  host.updateShape(id, {
    frame: { x: center.x - w / 2, y: center.y - h / 2, width: w, height: h },
    data: {
      points: nodes.map((node) =>
        storable({ ...map(node), in: node.in && map(node.in), out: node.out && map(node.out) }),
      ),
    },
  });
}
