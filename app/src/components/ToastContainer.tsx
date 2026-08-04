import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { type Toast, useToast } from "#composeables/useToast.ts";
import { animateIn, animateOut, EXIT_TIMEOUT_MS } from "#utils/animate.ts";
import { Icon, type IconName } from "./Icon.tsx";

const icons: Record<Toast["type"], IconName> = {
  error: "alert-circle",
  success: "confirmation",
  info: "info",
};

export function ToastContainer() {
  const { toasts, drop } = useToast();
  const elements = new Map<number, HTMLElement>();
  const exiting = new Set<number>();
  const [completedActions, setCompletedActions] = createSignal<Set<number>>(new Set());

  function registerToast(id: number, el: HTMLElement | undefined) {
    if (el) elements.set(id, el);
    else elements.delete(id);
  }

  /**
   * Play a toast out and then remove it.
   *
   * The removal must happen whatever the animation does, so it is raced against
   * a timer: a background tab throttles rAF, and `animateOut` would then resolve
   * far too late (or not until the tab is focused again), pinning the toast.
   */
  async function playOutAndDrop(id: number) {
    if (exiting.has(id)) return;
    exiting.add(id);

    const el = elements.get(id);
    await Promise.race([
      el ? animateOut(el) : Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS)),
    ]);

    exiting.delete(id);
    elements.delete(id);
    drop(id);
  }

  createEffect(() => {
    for (const toast of toasts()) {
      if (toast.exiting) void playOutAndDrop(toast.id);
    }
  });

  // Drop completion marks for toasts that have gone, so a recycled id cannot
  // inherit a previous toast's "done" state.
  createEffect(() => {
    const currentIds = new Set(toasts().map((toast) => toast.id));
    setCompletedActions(
      (previous) => new Set([...previous].filter((id) => currentIds.has(id))),
    );
  });

  async function runAction(toast: Toast) {
    if (!toast.action || completedActions().has(toast.id)) return;
    try {
      await toast.action.run();
      setCompletedActions((previous) => new Set([...previous, toast.id]));
    } catch (error) {
      console.error("Toast action failed", error);
    }
  }

  return (
    <Portal>
      <div
        id="toast-container"
        class="pointer-events-none fixed bottom-20 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2"
      >
        <For each={toasts()}>
          {(toast) => {
            /**
             * Played on mount, not from `ref`.
             *
             * `ref` runs before the node is in the document, and an animation
             * started on a detached element never gets a start time — it holds
             * the element at its first keyframe, which for the enter is
             * `opacity: 0`. The toast then sat there invisible until it
             * expired, and only flickered on the way out, when the leave
             * animation ran on a node that was by then attached.
             */
            onMount(() => {
              const el = elements.get(toast.id);
              if (el) animateIn(el);
            });

            return (
              <div
                ref={(el) => registerToast(toast.id, el)}
                class="pointer-events-auto relative flex min-w-64 items-center gap-2.5 overflow-hidden rounded-lg px-4 py-2.5 font-medium text-size-small shadow-large"
                classList={{
                  "bg-red-600 text-white": toast.type === "error",
                  "bg-neutral-900 text-white": toast.type === "info",
                  "bg-green-600 text-white": toast.type === "success",
                  // Room for the repeat badge in the corner.
                  "pr-9": (toast.count ?? 1) > 1,
                }}
              >
                <Icon class="h-4 w-4 shrink-0" name={icons[toast.type]} />
                <span class="relative z-10">{toast.message}</span>
                {/* Repeats of the same message merge into this row; the badge
                    counts them so a flood stays one toast. */}
                <Show when={(toast.count ?? 1) > 1}>
                  <span
                    class="absolute top-1 right-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1.5 font-semibold text-[11px] tabular-nums leading-none"
                    aria-label={`${toast.count} occurrences`}
                  >
                    {toast.count}
                  </span>
                </Show>
                <Show when={toast.action}>
                  {(action) => (
                    <button
                      type="button"
                      class="relative z-10 ml-auto rounded-md bg-white/15 px-2 py-1 font-semibold text-xs transition-colors hover:bg-white/25"
                      disabled={completedActions().has(toast.id)}
                      onClick={() => void runAction(toast)}
                    >
                      {completedActions().has(toast.id)
                        ? (action().completedLabel ?? action().label)
                        : action().label}
                    </button>
                  )}
                </Show>
                <Show when={toast.progress !== undefined}>
                  <div class="absolute inset-x-0 bottom-0 h-1 bg-white/15">
                    <div
                      class="h-full bg-white/55 transition-all duration-200 ease-out"
                      style={{
                        width: `${Math.max(0, Math.min(1, toast.progress ?? 0)) * 100}%`,
                      }}
                    />
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Portal>
  );
}
