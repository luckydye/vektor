import { nextTick, type Ref, shallowRef, watch } from "vue";
import { withViewTransition } from "#utils/viewTransition.ts";

/**
 * Renders a derived list through a native View Transition.
 *
 * A View Transition snapshots the DOM, runs its callback, then snapshots again —
 * so the DOM has to reach its new state *inside* the callback. Vue flushes
 * renders asynchronously, so a list rendered straight from a `computed` is
 * already updated by the time a watcher sees it, and there is nothing left to
 * animate. This keeps a mirror of the source and moves it forward inside the
 * transition, awaiting `nextTick()` so Vue's render lands before the second
 * snapshot.
 *
 * Render from the returned ref, not from the source.
 */
export function useViewTransitionList<T>(source: () => T[]): Ref<T[]> {
  const items = shallowRef<T[]>(source());

  watch(source, (next) => {
    withViewTransition(async () => {
      items.value = next;
      await nextTick();
    });
  });

  return items;
}
