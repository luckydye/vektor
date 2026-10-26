/**
 * Lays a node-and-edge diagram out in layers, so a model can describe a
 * flowchart or architecture without computing coordinates: nodes are ranked
 * along the edges, ordered to cross less, aligned with what they connect to,
 * and sized to their text. Edges that skip layers get lanes of their own.
 */

import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import { layoutLine, layoutMarkdown } from "#canvas/raster/text.ts";
import { GEO_PARAGRAPH_GAP, type GeoKind, geoLabelBox } from "#canvas/render/shapeGeometry.ts";

const NODE_FIELDS = ["id", "text", "type", "fill", "stroke", "strokeWidth", "dash", "radius", "fontSize", "textColor", "padding", "w", "h"];
const EDGE_FIELDS = ["id", "type", "from", "to", "via", "route", "startHead", "endHead", "stroke", "strokeWidth", "dash", "label", "fontSize"];
const DIAGRAM_FIELDS = ["id", "in", "x", "y", "direction", "gap", "spacing", "nodes", "edges", "route", "style"];

interface Context {
  faces: ReadonlyMap<FontFace, Font>;
  at: string;
  fail: (message: string) => never;
  exists: (id: string) => boolean;
  /** The size of the frame named by `in`, for centring. */
  frameSize: (id: string) => { width: number; height: number };
}

type Spec = Record<string, unknown>;
type Size = { width: number; height: number };

function checked(spec: unknown, fields: readonly string[], what: string, context: Context): Spec {
  if (!spec || typeof spec !== "object") context.fail(`${context.at}: each ${what} must be an object.`);
  for (const key of Object.keys(spec)) {
    if (!fields.includes(key)) {
      context.fail(`${context.at}: "${key}" is not a ${what} field. Fields: ${fields.join(", ")}.`);
    }
  }
  return spec as Spec;
}

/**
 * A shape big enough that its own label area holds its text: a diamond's is half
 * its box, so it grows twice as much. A given `w` or `h` is kept.
 */
export function sizeForText(
  shape: { kind: GeoKind; text: string; fontSize: number; padding: number; w?: number; h?: number },
  faces: ReadonlyMap<FontFace, Font>,
): Size {
  const { kind, padding } = shape;
  const box = (width: number, height: number) => geoLabelBox({ kind, padding }, { x: 0, y: 0, width, height, rotation: 0 });
  const wrap = shape.w === undefined ? (kind === "rect" ? 260 : 200) : box(shape.w, 1000).width;
  const text = layoutMarkdown(shape.text, { size: shape.fontSize, color: "#000", paragraphGap: GEO_PARAGRAPH_GAP }, wrap, faces);
  const share = (box(1000, 1000).width + padding * 2) / 1000;
  let width = shape.w ?? Math.ceil(Math.max(150, (text.width + padding * 2) / share + 8));
  let height = shape.h ?? Math.ceil(Math.max(64, text.height + padding * 2 + 8));
  while (shape.h === undefined && box(width, height).height < text.height + 8) height += 4;
  if (shape.w === undefined && (kind === "ellipse" || kind === "diamond")) width = Math.max(width, height);
  return { width, height };
}

/** Element specs for `add`, nodes then arrows, and the box they fill. */
export function layoutDiagram(raw: Spec, context: Context) {
  const spec = checked(raw, DIAGRAM_FIELDS, "diagram", context);
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) context.fail(`${context.at}: a diagram needs nodes.`);
  const frame = typeof spec.in === "string" ? context.frameSize(spec.in) : null;
  for (const axis of ["x", "y"] as const) {
    if (spec[axis] !== undefined && typeof spec[axis] !== "number") context.fail(`${context.at}: ${axis} must be a number.`);
    if (spec[axis] === undefined && !frame) context.fail(`${context.at}: a diagram needs ${axis}, or "in" to centre it in a frame.`);
  }
  const down = spec.direction === "down";
  if (spec.direction !== undefined && spec.direction !== "down" && spec.direction !== "right") {
    context.fail(`${context.at}: direction must be right or down.`);
  }
  const baseGap = typeof spec.gap === "number" ? spec.gap : 90;
  const spacing = typeof spec.spacing === "number" ? spec.spacing : 40;
  const style = spec.style ? checked(spec.style, NODE_FIELDS.filter((key) => key !== "id" && key !== "text"), "style", context) : {};
  const nodes = spec.nodes.map((node) => ({ ...style, ...checked(node, NODE_FIELDS, "node", context) }));
  // Edge labels follow the node text size, a step smaller.
  const labelSize = typeof style.fontSize === "number" ? Math.max(14, Math.round(style.fontSize * 0.8)) : undefined;
  const edges = (Array.isArray(spec.edges) ? spec.edges : []).map((edge): Spec => ({
    ...(labelSize ? { fontSize: labelSize } : {}),
    ...checked(edge, EDGE_FIELDS, "edge", context),
  }));
  const ids = nodes.map((node, index) => {
    if (typeof node.id !== "string" || !node.id) context.fail(`${context.at}: node ${index + 1} needs an id.`);
    return node.id;
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  if (index.size !== ids.length) context.fail(`${context.at}: node ids must be unique.`);
  for (const edge of edges) {
    for (const end of [edge.from, edge.to]) {
      if (typeof end !== "string" || !(index.has(end) || context.exists(end))) {
        context.fail(`${context.at}: edge ${String(edge.from)} → ${String(edge.to)} names no node "${String(end)}".`);
      }
    }
  }

  const sizes: Size[] = nodes.map((node) =>
    sizeForText(
      {
        kind: (node.type === "circle" ? "ellipse" : (node.type ?? "rect")) as GeoKind,
        text: typeof node.text === "string" ? node.text : "",
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 18,
        padding: typeof node.padding === "number" ? node.padding : 12,
        w: typeof node.w === "number" ? node.w : undefined,
        h: typeof node.h === "number" ? node.h : undefined,
      },
      context.faces,
    ),
  );

  // Longest-path ranks, ignoring edges that close a cycle.
  const inner = edges.filter((edge) => index.has(edge.from as string) && index.has(edge.to as string));
  const visited = ids.map(() => 0);
  const forward: [number, number][] = [];
  const visit = (node: number) => {
    visited[node] = 1;
    for (const edge of inner.filter((candidate) => index.get(candidate.from as string) === node)) {
      const target = index.get(edge.to as string) as number;
      if (visited[target] === 1) continue;
      forward.push([node, target]);
      if (visited[target] === 0) visit(target);
    }
    visited[node] = 2;
  };
  ids.forEach((_, node) => {
    if (visited[node] === 0) visit(node);
  });
  const rank = ids.map(() => 0);
  for (let pass = 0; pass < ids.length; pass++) {
    for (const [from, to] of forward) rank[to] = Math.max(rank[to], rank[from] + 1);
  }

  // An edge across several layers gets a lane slot in each layer it passes, so
  // ordering keeps it clear of the nodes there and its arrow can route through.
  const LANE = 24;
  const slots: Size[] = [...sizes];
  const lanes = new Map<string, number[]>();
  const links: [number, number][] = [];
  for (const [from, to] of forward) {
    let previous = from;
    const chain: number[] = [];
    for (let layer = rank[from] + 1; layer < rank[to]; layer++) {
      const slot = slots.length;
      slots.push(down ? { width: LANE, height: 0 } : { width: 0, height: LANE });
      rank[slot] = layer;
      chain.push(slot);
      links.push([previous, slot]);
      previous = slot;
    }
    links.push([previous, to]);
    if (chain.length > 0) lanes.set(`${from}>${to}`, chain);
  }
  const layers: number[][] = [];
  slots.forEach((_, slot) => {
    layers[rank[slot]] ??= [];
    layers[rank[slot]].push(slot);
  });

  // Order within layers: barycentre sweeps, then swapping neighbours while it
  // removes crossings.
  const position = new Map<number, number>();
  const place = () => layers.forEach((layer) => layer.forEach((slot, i) => position.set(slot, i)));
  place();
  const neighbours = (slot: number, upward: boolean) =>
    links.filter(([from, to]) => (upward ? to === slot : from === slot)).map(([from, to]) => (upward ? from : to));
  for (let sweep = 0; sweep < 8; sweep++) {
    const upward = sweep % 2 === 0;
    for (const layer of upward ? layers.slice(1) : layers.slice(0, -1).reverse()) {
      const weight = (slot: number) => {
        const linked = neighbours(slot, upward);
        return linked.length ? linked.reduce((sum, other) => sum + (position.get(other) ?? 0), 0) / linked.length : (position.get(slot) ?? 0);
      };
      layer.sort((a, b) => weight(a) - weight(b));
      place();
    }
  }
  const crossings = () => {
    let count = 0;
    for (let i = 0; i < links.length; i++) {
      for (let j = i + 1; j < links.length; j++) {
        const [a, b] = links[i];
        const [c, d] = links[j];
        if (rank[a] !== rank[c] || a === c || b === d) continue;
        const first = (position.get(a) ?? 0) - (position.get(c) ?? 0);
        const second = (position.get(b) ?? 0) - (position.get(d) ?? 0);
        if (first * second < 0) count++;
      }
    }
    return count;
  };
  let best = crossings();
  for (let round = 0; round < 12 && best > 0; round++) {
    let improved = false;
    for (const layer of layers) {
      for (let i = 0; i < layer.length - 1; i++) {
        [layer[i], layer[i + 1]] = [layer[i + 1], layer[i]];
        place();
        const count = crossings();
        if (count < best) {
          best = count;
          improved = true;
        } else {
          [layer[i], layer[i + 1]] = [layer[i + 1], layer[i]];
          place();
        }
      }
    }
    if (!improved) break;
  }

  // Each slot's centre across the layers: pulled toward its neighbours' centres
  // so chains run straight, then pushed apart where slots would overlap.
  const along = (size: Size) => (down ? size.width : size.height);
  const across = (size: Size) => (down ? size.height : size.width);
  const centre = new Map<number, number>();
  for (const layer of layers) {
    let cursor = 0;
    for (const slot of layer) {
      centre.set(slot, cursor + along(slots[slot]) / 2);
      cursor += along(slots[slot]) + spacing;
    }
  }
  const settle = (layer: number[], wanted: (slot: number) => number) => {
    const tops = layer.map((slot) => wanted(slot) - along(slots[slot]) / 2);
    for (let i = 1; i < layer.length; i++) {
      tops[i] = Math.max(tops[i], tops[i - 1] + along(slots[layer[i - 1]]) + spacing);
    }
    // Pull back what the push left too far from where it wanted to be.
    for (let i = layer.length - 2; i >= 0; i--) {
      const limit = tops[i + 1] - spacing - along(slots[layer[i]]);
      tops[i] = Math.min(Math.max(tops[i], wanted(layer[i]) - along(slots[layer[i]]) / 2), limit);
    }
    layer.forEach((slot, i) => centre.set(slot, tops[i] + along(slots[slot]) / 2));
  };
  for (let pass = 0; pass < 8; pass++) {
    const upward = pass % 2 === 0;
    for (const layer of upward ? layers.slice(1) : layers.slice(0, -1).reverse()) {
      settle(layer, (slot) => {
        const linked = neighbours(slot, upward);
        return linked.length
          ? linked.reduce((sum, other) => sum + (centre.get(other) ?? 0), 0) / linked.length
          : (centre.get(slot) ?? 0);
      });
    }
  }

  // The gap after a layer leaves room for the labels of the edges leaving it.
  const gaps = layers.map((_, layer) => {
    const labels = edges.filter((edge) => {
      const from = index.get(edge.from as string);
      return from !== undefined && rank[from] === layer && typeof edge.label === "string" && edge.label;
    });
    const room = Math.max(
      0,
      ...labels.map((edge) => {
        const size = typeof edge.fontSize === "number" ? edge.fontSize : 14;
        const label = layoutLine(edge.label as string, { face: "regular", size, color: "#000" }, context.faces, 240);
        // Labels sit mid-edge, and an edge must stay visible around its label.
        return ((down ? label.height : label.width) + 16) / 0.7 + 12;
      }),
    );
    return Math.max(baseGap, room);
  });

  const depths = layers.map((layer) => Math.max(...layer.map((slot) => across(slots[slot]))));
  const lowest = Math.min(...slots.map((slot, i) => (centre.get(i) ?? 0) - along(slot) / 2));
  const highest = Math.max(...slots.map((slot, i) => (centre.get(i) ?? 0) + along(slot) / 2));
  const extent = {
    main: depths.reduce((sum, depth) => sum + depth, 0) + gaps.slice(0, -1).reduce((sum, gap) => sum + gap, 0),
    cross: highest - lowest,
  };
  const size = down ? { width: extent.cross, height: extent.main } : { width: extent.main, height: extent.cross };
  // Loops run in lanes outside the nodes, before the first or after the last in
  // each layer: whichever side neither end has a node on. The centring leaves room.
  const clear = (node: number, before: boolean) =>
    !layers[rank[node]].some(
      (other) => other < ids.length && other !== node && ((centre.get(other) ?? 0) < (centre.get(node) ?? 0)) === before,
    );
  const loopSides = new Map<Spec, boolean>();
  for (const edge of edges) {
    const from = index.get(edge.from as string);
    const to = index.get(edge.to as string);
    if (from === undefined || to === undefined || from === to || rank[to] > rank[from]) continue;
    loopSides.set(edge, !(clear(from, false) && clear(to, false)) && clear(from, true) && clear(to, true));
  }
  const loopsBefore = [...loopSides.values()].filter(Boolean).length;
  const loopsAfter = loopSides.size - loopsBefore;
  const room = (count: number) => (count > 0 ? 36 + 28 * count : 0);
  const loopRoom = room(loopsBefore) + room(loopsAfter);
  const origin = {
    x: typeof spec.x === "number" ? spec.x : ((frame?.width ?? 0) - size.width - (down ? loopRoom : 0)) / 2 + (down ? room(loopsBefore) : 0),
    y: typeof spec.y === "number" ? spec.y : ((frame?.height ?? 0) - size.height - (down ? 0 : loopRoom)) / 2 + (down ? 0 : room(loopsBefore)),
  };
  const point = (main: number, cross: number) => ({
    x: Math.round(origin.x + (down ? cross : main)),
    y: Math.round(origin.y + (down ? main : cross)),
  });

  const elements: Spec[] = [];
  const lanePoints = new Map<number, { x: number; y: number }[]>();
  let main = 0;
  layers.forEach((layer, layerIndex) => {
    const depth = depths[layerIndex];
    const gapBefore = layerIndex > 0 ? gaps[layerIndex - 1] : baseGap;
    for (const slot of layer) {
      const slotSize = slots[slot];
      const cross = (centre.get(slot) ?? 0) - along(slotSize) / 2 - lowest;
      if (slot >= ids.length) {
        // Bends between layers, not along the nodes' edges.
        const middle = cross + along(slotSize) / 2;
        lanePoints.set(slot, [point(main - gapBefore / 2, middle), point(main + depth + gaps[layerIndex] / 2, middle)]);
        continue;
      }
      const { fontSize, text, type, w: _w, h: _h, ...rest } = nodes[slot];
      elements.push({
        ...rest,
        type: type ?? "rect",
        text: text ?? "",
        ...(fontSize === undefined ? {} : { fontSize }),
        ...(spec.in === undefined ? {} : { in: spec.in }),
        ...point(main + (depth - across(slotSize)) / 2, cross),
        w: slotSize.width,
        h: slotSize.height,
      });
    }
    main += depth + gaps[layerIndex];
  });
  // Loops back against the flow run in lanes outside the diagram, below it for
  // a rightward flow, so they never cross the nodes.
  const placedNodes = new Map(elements.map((element) => [element.id as string, element]));
  const centreOf = (id: string) => {
    const node = placedNodes.get(id) as { x: number; y: number; w: number; h: number };
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  };
  const loopCount = { before: 0, after: 0 };
  for (const edge of edges) {
    const from = index.get(edge.from as string);
    const to = index.get(edge.to as string);
    const chain = lanes.get(`${from}>${to}`);
    const via = chain?.flatMap((slot) => lanePoints.get(slot) ?? []);
    const inside = from !== undefined && to !== undefined;
    // Forward edges leave and enter on the sides facing the flow.
    const flowing = inside && rank[to] > rank[from];
    const back = inside && !flowing && from !== to;
    let ends = {};
    let loop = {};
    if (flowing) {
      ends = {
        from: { id: edge.from, anchor: down ? "bottom" : "right" },
        to: { id: edge.to, anchor: down ? "top" : "left" },
      };
    } else if (back) {
      const before = loopSides.get(edge) === true;
      const side = down ? (before ? "left" : "right") : before ? "top" : "bottom";
      const lane = 36 + 28 * loopCount[before ? "before" : "after"]++;
      const a = centreOf(edge.from as string);
      const b = centreOf(edge.to as string);
      const extent = down ? size.width : size.height;
      const start = down ? origin.x : origin.y;
      const outside = before ? start - lane : start + extent + lane;
      ends = { from: { id: edge.from, anchor: side }, to: { id: edge.to, anchor: side } };
      loop = {
        route: "elbow",
        via: down ? [[outside, a.y], [outside, b.y]] : [[a.x, outside], [b.x, outside]],
      };
    }
    elements.push({
      type: "arrow",
      route: spec.route ?? "curve",
      ...ends,
      ...edge,
      ...ends,
      ...loop,
      ...(spec.in === undefined ? {} : { in: spec.in }),
      ...(via ? { via: via.map((at) => [at.x, at.y]) } : {}),
    });
  }
  // The reported box takes in the loop lanes either side.
  if (down) {
    origin.x -= room(loopsBefore);
    size.width += loopRoom;
  } else {
    origin.y -= room(loopsBefore);
    size.height += loopRoom;
  }
  return {
    elements,
    bounds: { x: Math.round(origin.x), y: Math.round(origin.y), w: Math.round(size.width), h: Math.round(size.height) },
  };
}
