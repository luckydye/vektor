/**
 * What is left of the canvas host's state handling.
 *
 * The canvas draws immediate-mode: every frame rebuilds the whole tree from
 * whatever the state says right now, and lit-html diffs it into the DOM. State
 * is a plain object on the controller — writing a field does nothing on its
 * own, exactly like writing a local — and the entry points that change it ask
 * for a frame when they are done. There is nothing here that tracks, caches or
 * subscribes.
 *
 * Renders coalesce onto a microtask in `CanvasHostElement`, so a drag that
 * touches six values still paints once.
 */

/**
 * A `watch`, minus the dependency tracking.
 *
 * Reactions are re-declared on every flush and fire when the value they are
 * given differs from last time. Declaring them in a list that runs top to
 * bottom — rather than registering callbacks once — means the set of active
 * reactions is always readable in one place, and ordering between them is
 * explicit instead of emergent.
 *
 * Comparison is by identity, which is why the state holds immutable values:
 * selection is replaced with a new Set rather than mutated in place.
 */
export function createWatchers() {
  const previous = new Map<string, unknown>();

  return function watch<T>(
    key: string,
    value: T,
    run: (value: T, previous: T | undefined) => void,
    options?: { immediate?: boolean },
  ): void {
    const seen = previous.has(key);
    const before = previous.get(key) as T | undefined;
    previous.set(key, value);
    if (seen && Object.is(before, value)) return;
    // The default is to skip the first run; `immediate` opts in, and the
    // handful of reactions that seed state from a property rely on it.
    if (!seen && !options?.immediate) return;
    run(value, before);
  };
}

/**
 * Index a list by id, rebuilt only when the list itself is replaced.
 *
 * Not a reactive cache. The key is the array's identity, so the index is
 * correct the instant a caller swaps the list in — there is no revision
 * counter to bump and no frame boundary to be on the wrong side of. The canvas
 * replaces `shapes` and `strokes` rather than mutating them in place, which is
 * what makes identity enough.
 *
 * Worth the machinery for exactly these two: the template asks for a shape by
 * id once per shape, so rebuilding the map per lookup is quadratic.
 */
export function indexById<T extends { id: string }>(): (
  items: readonly T[],
) => ReadonlyMap<string, T> {
  let source: readonly T[] | null = null;
  let index: ReadonlyMap<string, T> = new Map();
  return (items) => {
    if (items !== source) {
      source = items;
      index = new Map(items.map((item) => [item.id, item]));
    }
    return index;
  };
}

/**
 * Who to repaint when page-level canvas state changes.
 *
 * A few values are shared by every canvas on the page rather than owned by one
 * host — the pen mode, the shape the shape tool stamps next, in-flight uploads,
 * link previews that resolve later. A host does not need to know which of them
 * changed, only that it should draw again, so there is one registry of live
 * canvases instead of a listener set per value.
 */
const liveCanvases = new Set<() => void>();

export function registerCanvas(repaint: () => void): () => void {
  liveCanvases.add(repaint);
  return () => {
    liveCanvases.delete(repaint);
  };
}

interface SharedValue<T> {
  get(): T;
  set(value: T): void;
}

/**
 * A page-level value that repaints every canvas when it changes.
 *
 * Not an observable: nothing subscribes and nothing propagates. Writing marks
 * the canvases dirty, exactly as writing to a host's own state does, and the
 * next frame reads the new value along with everything else.
 */
export function shared<T>(initial: T): SharedValue<T> {
  let current = initial;
  return {
    get: () => current,
    set(value: T) {
      if (Object.is(current, value)) return;
      current = value;
      for (const repaint of [...liveCanvases]) repaint();
    },
  };
}
