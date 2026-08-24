import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { type Toast, useToast } from "#composeables/useToast.ts";
import { animateIn, animateOut, EXIT_TIMEOUT_MS } from "#utils/animate.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

const icons: Record<Toast["type"], IconName> = {
  error: "alert-circle",
  success: "confirmation",
  info: "info",
};

export function ToastContainer() {
  const t = useTranslation();

  const { toasts, drop } = useToast();
  const elements = new Map<number, HTMLElement>();
  const exiting = new Set<number>();
  const [completedActions, setCompletedActions] = createSignal<Set<number>>(new Set());

  function registerToast(id: number, el: HTMLElement | undefined) {
    if (el) elements.set(id, el);
    else elements.delete(id);
  }

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
            onMount(() => {
              const el = elements.get(toast.id);
              if (el) animateIn(el);
            });

            return (
              <div
                ref={(el) => registerToast(toast.id, el)}
                // A failure has to be announced, not just drawn.
                role={toast.type === "error" ? "alert" : "status"}
                class="pointer-events-auto relative flex min-w-64 items-center gap-2.5 overflow-hidden rounded-lg px-4 py-2.5 font-medium text-size-small shadow-large"
                classList={{
                  "bg-red-600 text-white": toast.type === "error",
                  "bg-neutral-900 text-white": toast.type === "info",
                  "bg-green-600 text-white": toast.type === "success",
                  "pr-9": (toast.count ?? 1) > 1,
                }}
              >
                <Icon class="h-4 w-4 shrink-0" name={icons[toast.type]} />
                <span class="relative z-10">{toast.message}</span>
                <Show when={(toast.count ?? 1) > 1}>
                  <span
                    aria-hidden="true"
                    class="absolute top-1 right-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1.5 font-semibold text-[11px] tabular-nums leading-none"
                  >
                    {toast.count}
                  </span>
                  <span class="sr-only">{`${toast.count} occurrences`}</span>
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
                <Show when={toast.cancel}>
                  <IconButton
                    class="relative z-10 ml-auto text-white/70 enabled:active:bg-white/30 enabled:hover:bg-white/20 enabled:hover:text-white"
                    icon="cancel"
                    label={t("Cancel")}
                    onClick={() => toast.cancel?.()}
                  />
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
