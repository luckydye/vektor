import { createComponent, createSignal } from "solid-js";
import { render as solidRender } from "solid-js/web";

/**
 * How specs mount a component.
 *
 * This carried a Vue branch as well until the cutover, so the suite could be
 * run against either renderer and the specs left untouched. Vue is gone, so
 * only the Solid path remains; the shape of the API is unchanged, which is why
 * no spec moved when the branch did.
 */

export type Props = Record<string, unknown>;

export interface RenderResult {
  /** The element the component was mounted into. Query from here, not `document`. */
  container: HTMLElement;
  /**
   * Whatever the component exposed imperatively, through a `ref` callback prop
   * (plan section 10). `undefined` for components that expose nothing.
   */
  exposed: Record<string, unknown> | undefined;
  /**
   * Re-render with new props, merged over the originals like a parent
   * re-render. Solid applies the update synchronously, so this resolves
   * immediately; it stays a promise because every spec already awaits it.
   */
  update(next: Props): Promise<void>;
  cleanup(): void;
}

const mounted = new Set<() => void>();

/**
 * Mount a component and return its DOM.
 *
 * Props go through one mutable source — a signal — rather than being re-passed
 * on update, so `update()` patches the existing tree the way a parent
 * re-render would instead of tearing down and remounting.
 */
export function render(Component: unknown, props: Props = {}): RenderResult {
  const container = document.createElement("div");
  document.body.append(container);

  return renderSolid(Component as (props: Props) => unknown, props, container);
}

function renderSolid(
  Component: (props: Props) => unknown,
  props: Props,
  container: HTMLElement,
) {
  const [current, setCurrent] = createSignal<Props>({ ...props });
  const mountedKeys = new Set(Object.keys(props));
  let exposed: Record<string, unknown> | undefined;

  // A Proxy, so the key set stays dynamic. Two things have to be right at
  // once: `get` keeps the read reactive so `update()` patches rather than
  // remounts, and `getOwnPropertyDescriptor` must return a real *getter*
  // descriptor — `mergeProps` copies descriptors, and one with no getter makes
  // every prop arrive as undefined. Plain `Object.defineProperty` getters were
  // not enough either: a key first passed to `update()` did not exist when the
  // component called `mergeProps`, so it stayed invisible.
  const refCallback = (instance: unknown) => {
    exposed = (instance ?? undefined) as Record<string, unknown> | undefined;
  };
  const reactiveProps = new Proxy({} as Props, {
    get: (_target, key: string) => (key === "ref" ? refCallback : current()[key]),
    has: (_target, key: string) => key === "ref" || key in current(),
    ownKeys: () => [...new Set([...Object.keys(current()), "ref"])],
    getOwnPropertyDescriptor: (_target, key: string) => ({
      get: () => (key === "ref" ? refCallback : current()[key]),
      enumerable: true,
      configurable: true,
    }),
  });

  // `solidRender`'s own disposer, not one from an outer `createRoot`: render
  // creates its own root, and a `Portal` inside it attaches to `document.body`.
  // Disposing an outer root leaves that portal content behind, so every dialog
  // spec then queries a body full of previous tests' dialogs.
  let dispose = () => {};
  const mount = () => {
    dispose = solidRender(() => createComponent(Component, reactiveProps), container);
  };
  mount();

  return finish(container, {
    dispose: () => {
      dispose();
      container.remove();
    },
    // Solid applies updates synchronously; the await exists so specs read the
    // same on both sides.
    update: async (next: Props) => {
      setCurrent((previous) => ({ ...previous, ...next }));
      // `mergeProps` fixes its key set when the component runs, so a prop
      // appearing for the first time in `update()` is invisible to the
      // defaults merge and never reaches the DOM. A real parent cannot do this
      // — its JSX key set is fixed at compile time — so rather than bend every
      // component around a test-only shape, remount when it happens. Updates
      // to keys that were present at mount still patch in place, which is what
      // the "without remounting" specs actually pin down.
      if (Object.keys(next).some((key) => !mountedKeys.has(key))) {
        for (const key of Object.keys(next)) mountedKeys.add(key);
        dispose();
        container.replaceChildren();
        mount();
      }
    },
    getExposed: () => exposed,
  });
}

function finish(
  container: HTMLElement,
  handlers: {
    dispose: () => void;
    update: (next: Props) => Promise<void>;
    getExposed: () => Record<string, unknown> | undefined;
  },
): RenderResult {
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    handlers.dispose();
    mounted.delete(cleanup);
  };
  mounted.add(cleanup);

  return {
    container,
    get exposed() {
      return handlers.getExposed();
    },
    update: handlers.update,
    cleanup,
  };
}

/**
 * Unmount everything still mounted. Call from an `afterEach`; happy-dom keeps
 * one document per file, so a leaked mount leaks into the next spec.
 */
export function cleanupAll(): void {
  for (const dispose of [...mounted]) dispose();
}

/**
 * Props for a two-way–bound value.
 *
 * Solid spells this `value` + `onInput` (plan section 10). It stays a helper
 * rather than being inlined: specs naming the binding directly is what made
 * the Vue-to-Solid swap invisible to them, and the same indirection protects
 * the next one.
 */
export function modelProps(value: unknown, onChange?: (next: never) => void): Props {
  return { value, ...(onChange ? { onInput: onChange } : {}) };
}
