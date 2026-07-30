import { type App, createApp, h, nextTick, reactive } from "vue";

/**
 * The only file in the suite that knows which framework is live.
 *
 * Specs render through `render()` and assert on the DOM. When the port lands,
 * this file grows a Solid branch and `registry.ts` starts returning `.tsx`
 * components — no spec changes. A spec that has to be edited to pass on Solid
 * was testing the wrong thing (plan section 4.2).
 */

export type Props = Record<string, unknown>;

export interface RenderResult {
  /** The element the component was mounted into. Query from here, not `document`. */
  container: HTMLElement;
  /**
   * Whatever the component exposed imperatively — `defineExpose` today, a `ref`
   * callback prop under Solid (plan section 10). `undefined` for components
   * that expose nothing.
   */
  exposed: Record<string, unknown> | undefined;
  /**
   * Re-render with new props, merged over the originals like a parent
   * re-render. **Await it**: Vue flushes renders on the next tick, so a
   * synchronous `update()` would return before the DOM changed and every
   * assertion after it would read the old tree. Solid updates synchronously
   * and resolves immediately, so `await` is correct on both and specs do not
   * change at the cutover.
   */
  update(next: Props): Promise<void>;
  cleanup(): void;
}

const mounted = new Set<() => void>();

/**
 * Mount a component and return its DOM.
 *
 * Props go through a `reactive` object rather than being re-passed on update,
 * so `update()` patches the existing tree the way a parent re-render would
 * instead of tearing down and remounting. Solid's branch will do the same with
 * a signal — that symmetry is why `update()` can stay in the shared interface.
 */
export function render(Component: unknown, props: Props = {}): RenderResult {
  const container = document.createElement("div");
  document.body.append(container);

  const state = reactive({ ...props });
  let exposed: Record<string, unknown> | undefined;
  // Vue treats `ref` on a vnode specially and hands back the exposed object,
  // which is the same handle a Solid `ref` callback prop will provide.
  const captureExposed = (instance: unknown) => {
    exposed = (instance ?? undefined) as Record<string, unknown> | undefined;
  };
  // biome-ignore lint/suspicious/noExplicitAny: the registry is deliberately untyped.
  const app: App = createApp(() =>
    h(Component as any, { ...state, ref: captureExposed }),
  );
  app.mount(container);

  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    app.unmount();
    container.remove();
    mounted.delete(cleanup);
  };
  mounted.add(cleanup);

  return {
    container,
    get exposed() {
      return exposed;
    },
    async update(next: Props) {
      Object.assign(state, next);
      await nextTick();
    },
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
 * Props for a two-way–bound value, in whichever shape the live framework uses.
 *
 * Vue spells this `modelValue` + `onUpdate:modelValue`; Solid will spell it
 * `value` + `onInput` (plan section 10). Specs should never name either
 * directly — that is exactly the kind of detail the swap changes, and a spec
 * that has to be rewritten mid-comparison stops being a before/after check.
 */
export function modelProps(value: unknown, onChange?: (next: never) => void): Props {
  return {
    modelValue: value,
    ...(onChange ? { "onUpdate:modelValue": onChange } : {}),
  };
}
