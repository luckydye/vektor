import * as Y from "yjs";

/**
 * Seeds a canvas Y.Doc from persisted content. The server is the only caller —
 * it is the single source of truth for room state and sends the seeded doc to
 * clients on join; clients never seed their own docs. (Independently-seeded
 * docs assign different (clientID, clock) ids to the same shapes; merging them
 * resolves every per-key conflict last-writer-wins, so peers end up with
 * different winning structures and edits never converge.)
 *
 * Seeding runs under a pinned clientID and a fixed operation sequence so the
 * produced ids are stable across room reloads (a room evicted from memory and
 * reloaded yields the same structure). The doc's real, unique clientID is
 * restored before any live edit so concurrent edits still merge normally.
 */
const SEED_CLIENT_ID = 1;

export const CANVAS_SHAPES_KEY = "canvas.shapes";
export const CANVAS_STROKES_KEY = "canvas.strokes";

type RawShape = {
  id?: unknown;
  type?: unknown;
  frame?: unknown;
  style?: unknown;
  data?: unknown;
  authorId?: unknown;
  locked?: unknown;
  updatedAt?: unknown;
};

type RawStroke = {
  id?: unknown;
  points?: unknown;
  style?: unknown;
  kind?: unknown;
  rotation?: unknown;
  authorId?: unknown;
  locked?: unknown;
  updatedAt?: unknown;
};

// Deterministic fallbacks — never Date.now(), which would differ per party and
// reintroduce the divergence this module exists to prevent. Display-time
// normalization (min sizes, per-type defaults, style merges) happens when the
// maps are READ, so seeding only needs stable raw values.
function seedShape(target: Y.Map<Y.Map<unknown>>, shape: RawShape): void {
  if (typeof shape.id !== "string") return;
  const map = new Y.Map<unknown>();
  map.set("type", typeof shape.type === "string" ? shape.type : "note");
  const rawFrame = shape.frame && typeof shape.frame === "object"
    ? shape.frame as Record<string, unknown>
    : {};
  const frame = new Y.Map<unknown>();
  frame.set("x", typeof rawFrame.x === "number" ? rawFrame.x : 0);
  frame.set("y", typeof rawFrame.y === "number" ? rawFrame.y : 0);
  if (typeof rawFrame.width === "number") frame.set("width", rawFrame.width);
  if (typeof rawFrame.height === "number") frame.set("height", rawFrame.height);
  frame.set("rotation", typeof rawFrame.rotation === "number" ? rawFrame.rotation : 0);
  map.set("frame", frame);
  const rawStyle = shape.style && typeof shape.style === "object"
    ? shape.style as Record<string, unknown>
    : {};
  const style = new Y.Map<unknown>();
  style.set("color", typeof rawStyle.color === "string" ? rawStyle.color : "#fef3c7");
  map.set("style", style);
  const data = new Y.Map<unknown>();
  if (shape.data && typeof shape.data === "object") {
    for (const [key, value] of Object.entries(shape.data)) data.set(key, value);
  }
  map.set("data", data);
  if (typeof shape.authorId === "string") map.set("authorId", shape.authorId);
  if (shape.locked === true) map.set("locked", true);
  map.set("updatedAt", typeof shape.updatedAt === "number" ? shape.updatedAt : 0);
  target.set(shape.id, map);
}

function seedStroke(target: Y.Map<Y.Map<unknown>>, stroke: RawStroke): void {
  if (typeof stroke.id !== "string") return;
  const map = new Y.Map<unknown>();
  map.set("points", Array.isArray(stroke.points) ? stroke.points : []);
  map.set("style", stroke.style && typeof stroke.style === "object" ? stroke.style : {});
  if (stroke.kind === "shape") map.set("kind", "shape");
  if (typeof stroke.rotation === "number") map.set("rotation", stroke.rotation);
  if (typeof stroke.authorId === "string") map.set("authorId", stroke.authorId);
  if (stroke.locked === true) map.set("locked", true);
  map.set("updatedAt", typeof stroke.updatedAt === "number" ? stroke.updatedAt : 0);
  target.set(stroke.id, map);
}

/**
 * Seeds a canvas Y.Doc from a parsed snapshot deterministically. Assumes the
 * target maps are empty (the only real seed path). Runs under SEED_CLIENT_ID so
 * every party produces identical Yjs state, then restores the doc's own
 * clientID for subsequent live edits.
 */
export function seedCanvasDoc(
  ydoc: Y.Doc,
  parsed: { shapes?: unknown; strokes?: unknown } | null | undefined,
  origin: unknown = "seed",
): void {
  if (!parsed) return;
  const shapes = Array.isArray(parsed.shapes) ? parsed.shapes : [];
  const strokes = Array.isArray(parsed.strokes) ? parsed.strokes : [];
  if (shapes.length === 0 && strokes.length === 0) return;

  const liveClientId = ydoc.clientID;
  ydoc.clientID = SEED_CLIENT_ID;
  try {
    ydoc.transact(() => {
      const shapeMap = ydoc.getMap<Y.Map<unknown>>(CANVAS_SHAPES_KEY);
      const strokeMap = ydoc.getMap<Y.Map<unknown>>(CANVAS_STROKES_KEY);
      for (const shape of shapes) {
        if (shape && typeof shape === "object") seedShape(shapeMap, shape as RawShape);
      }
      for (const stroke of strokes) {
        if (stroke && typeof stroke === "object")
          seedStroke(strokeMap, stroke as RawStroke);
      }
    }, origin);
  } finally {
    // Guard the astronomically unlikely case where the doc's own id collides
    // with the seed id — live edits must never share SEED_CLIENT_ID.
    ydoc.clientID = liveClientId === SEED_CLIENT_ID ? SEED_CLIENT_ID + 1 : liveClientId;
  }
}

export function parseCanvasContent(
  content: string | null | undefined,
): { shapes?: unknown; strokes?: unknown } | null {
  if (!content?.trim()) return null;
  try {
    const parsed = JSON.parse(content) as { shapes?: unknown; strokes?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
