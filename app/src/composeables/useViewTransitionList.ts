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
 *
 * `keyOf` is required, and it is what makes this safe to use on live data. The
 * lists this animates are rebuilt by a `computed` — `[...map.values()].sort()`,
 * `.slice()`, `.filter()` — so every recompute yields a new array of new
 * objects, and a watcher comparing identity fires on every recompute. With
 * presence in the list that is once per heartbeat, and because a running
 * transition perturbs layout, the transitions never stop: the page flickers and
 * pointer interaction lands on the transition snapshot instead of the live DOM.
 *
 * Comparing the *key sequence* fixes that, and it is also the honest test of
 * whether a transition is wanted: this animates a FLIP move, so it has
 * something to do only when items are added, removed or reordered. A change
 * inside an item is an ordinary re-render.
 */
export function useViewTransitionList<T>(
  source: () => T[],
  keyOf: (item: T) => string,
): Ref<T[]> {
  const items = shallowRef<T[]>(source());
  let keys = items.value.map(keyOf).join(" ");
  // A transition already in flight has snapshotted the old DOM; starting
  // another mid-flight discards the frame it was about to show.
  let running = false;

  watch(source, (next) => {
    const nextKeys = next.map(keyOf).join(" ");
    if (nextKeys === keys) {
      // Same items in the same order: nothing to animate, but the objects may
      // carry fresh content, so pass them through without a transition.
      items.value = next;
      return;
    }
    keys = nextKeys;

    if (running) {
      items.value = next;
      return;
    }
    running = true;
    void withViewTransition(async () => {
      items.value = next;
      await nextTick();
    }).finally(() => {
      running = false;
    });
  });

  return items;
}
