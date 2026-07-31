import { type Accessor, createEffect, createSignal, on } from "solid-js";
import { withViewTransition } from "#utils/viewTransition.ts";

/**
 * Renders a derived list through a native View Transition.
 *
 * A View Transition snapshots the DOM, runs its callback, then snapshots again —
 * so the DOM has to reach its new state *inside* the callback. This keeps a
 * mirror of the source and moves it forward inside the transition. Solid
 * applies a signal write synchronously, so unlike the Vue original there is no
 * tick to await: by the time the setter returns, the DOM is in its new state.
 *
 * Render from the returned accessor, not from the source.
 *
 * `keyOf` is required, and it is what makes this safe to use on live data. The
 * lists this animates are rebuilt by a memo — `[...map.values()].sort()`,
 * `.slice()`, `.filter()` — so every recompute yields a new array of new
 * objects, and an effect comparing identity fires on every recompute. With
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
  source: Accessor<T[]>,
  keyOf: (item: T) => string,
): Accessor<T[]> {
  const [items, setItems] = createSignal<T[]>(source(), { equals: false });
  let keys = source().map(keyOf).join(" ");
  // A transition already in flight has snapshotted the old DOM; starting
  // another mid-flight discards the frame it was about to show.
  let running = false;

  createEffect(
    on(
      source,
      (next) => {
        const nextKeys = next.map(keyOf).join(" ");
        if (nextKeys === keys) {
          // Same items in the same order: nothing to animate, but the objects
          // may carry fresh content, so pass them through without a transition.
          setItems(next);
          return;
        }
        keys = nextKeys;

        if (running) {
          setItems(next);
          return;
        }
        running = true;
        void withViewTransition(() => {
          setItems(next);
        }).finally(() => {
          running = false;
        });
      },
      { defer: true },
    ),
  );

  return items;
}
