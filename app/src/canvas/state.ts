/**
 * The canvas host's reactivity, in about forty lines.
 *
 * The canvas is framework-free (plan section 6), so it needs its own answer to
 * "something changed, re-render". This is that answer, and it is deliberately
 * the crudest one that works: a single revision counter, bumped on any write,
 * with derived values cached until it moves.
 *
 * Coarse invalidation is the right trade here. The alternative — per-value
 * dependency tracking — buys nothing, because the canvas renders one tree from
 * essentially all of its state on every frame anyway. What it would cost is a
 * dependency graph to get wrong. A missed invalidation in a canvas is a stale
 * shape on screen with no error anywhere, which is exactly the bug class worth
 * designing out.
 *
 * The batching matches `CanvasElementBase`: many writes in one turn coalesce
 * into a single microtask render, so a drag that touches six values still
 * paints once.
 */

export interface CanvasStateStore<T extends object> {
  /** Read and write freely; every write bumps the revision and schedules a render. */
  state: T;
  /** Increments on every write. Derived values compare against it. */
  revision: () => number;
  /**
   * Wraps a computation so it runs at most once per revision.
   *
   * Use it for anything a render reads more than once or that allocates —
   * `shapesById` builds a Map over every shape, and the template asks for it
   * per shape.
   */
  derived: <R>(compute: () => R) => () => R;
  /** Bumps the revision by hand, for state that lives outside the proxy. */
  invalidate: () => void;
}

export function createCanvasState<T extends object>(
  initial: T,
  onChange: () => void,
): CanvasStateStore<T> {
  let revision = 0;

  const invalidate = () => {
    revision++;
    onChange();
  };

  const state = new Proxy(initial, {
    set(target, key, value) {
      // Identical writes are common — a pointermove that re-assigns the same
      // hovered id, a Yjs event that replays a value. Bumping on those would
      // re-render for nothing.
      if (Object.is(Reflect.get(target, key), value)) return true;
      Reflect.set(target, key, value);
      invalidate();
      return true;
    },
    deleteProperty(target, key) {
      if (!Reflect.has(target, key)) return true;
      Reflect.deleteProperty(target, key);
      invalidate();
      return true;
    },
  });

  /**
   * A first read at revision 0 must still compute, so the stamp starts at -1
   * rather than 0.
   */
  const derived = <R>(compute: () => R): (() => R) => {
    let cachedAt = -1;
    let cache: R;
    return () => {
      if (cachedAt !== revision) {
        cache = compute();
        cachedAt = revision;
      }
      return cache;
    };
  };

  return { state, revision: () => revision, derived, invalidate };
}

/**
 * Mutation through a proxied value does not go through the `set` trap — pushing
 * to an array or adding to a Set changes it in place. Callers either replace the
 * value (`state.shapes = [...state.shapes, one]`) or say so explicitly with
 * this. Named for what it is, so the two cases read differently at a glance.
 */
export function mutated(store: Pick<CanvasStateStore<object>, "invalidate">): void {
  store.invalidate();
}

/**
 * Vue's `watch`, minus the dependency tracking.
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
    // Vue's default is to skip the first run; `immediate` opts in, and the
    // handful of reactions that seed state from a property rely on it.
    if (!seen && !options?.immediate) return;
    run(value, before);
  };
}

export interface ValueStore<T> {
  get(): T;
  set(value: T): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * A single observable value, for state an extension owns rather than the host.
 *
 * The canvas extensions used a Vue `ref` for this — the pen mode, the shape the
 * shape-tool stamps next, the link-preview cache that fills in asynchronously.
 * None of them needed a reactive library; they needed "tell me when this
 * changes", which is this.
 *
 * Deliberately not the proxy above: these are module-level singletons shared by
 * every canvas on the page, so they carry their own listeners instead of being
 * bound to one host's revision counter.
 */
export function createValueStore<T>(initial: T): ValueStore<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(value: T) {
      if (Object.is(current, value)) return;
      current = value;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
