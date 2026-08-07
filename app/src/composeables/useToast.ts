import { play } from "cuelume";
import type { Accessor } from "solid-js";
import { createStore } from "solid-js/store";

export interface Toast {
  id: number;
  message: string;
  type: "error" | "info" | "success";
  progress?: number;
  action?: ToastAction;
  /**
   * Called when the user presses the toast's cancel button, which is shown only
   * while this is set. Aborting the work is all it does — whoever raised the
   * toast owns what the row says next, and when it leaves.
   */
  cancel?: () => void;
  /**
   * How many identical raises this row stands for. Absent or 1 for a plain
   * toast; the container shows a badge from 2 up.
   */
  count?: number;
  /**
   * Set by `dismiss`, cleared only by `drop`. The container watches this to
   * play the leave animation; the toast is still in the list until `drop`.
   */
  exiting?: boolean;
}

export interface ToastAction {
  label: string;
  completedLabel?: string;
  run: () => void | Promise<void>;
}

/**
 * Module-level on purpose: toasts are one queue for the whole page, raised from
 * anywhere and rendered by a single container. Unlike a per-request cache this
 * is browser-only state — nothing on the server raises a toast — so a shared
 * signal carries no SSR isolation risk.
 */
const [state, setState] = createStore<{ list: Toast[] }>({ list: [] });

/**
 * A store, not a signal of plain objects.
 *
 * `For` keys by reference. Replacing a toast to mark it exiting — or to move a
 * progress bar — handed `For` a different object, so it destroyed the row and
 * built a new one: the enter animation replayed on top of the leave, and an
 * uploading toast re-animated on every tick. A store mutates the item in place,
 * so the element survives its own updates.
 */
const toasts: Accessor<Toast[]> = () => state.list;
let nextId = 0;

/**
 * Pending auto-dismiss timers by toast id. Kept so a repeat raise can restart
 * the timer of the toast it merged into instead of leaving the original one to
 * fire while the count is still climbing.
 */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Start the toast leaving. The container animates it out and then calls `drop`.
 * Kept separate from `drop` so the element survives long enough to animate —
 * nothing else may depend on the toast being gone after this.
 */
function dismiss(id: number) {
  clearTimer(id);
  setState("list", (toast) => toast.id === id, "exiting", true);
}

/** Remove the toast for real. Safe to call twice. */
function drop(id: number) {
  clearTimer(id);
  setState("list", (list) => list.filter((toast) => toast.id !== id));
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

function scheduleDismiss(id: number, duration: number) {
  clearTimer(id);
  if (duration > 0)
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration),
    );
}

/**
 * The visible toast a repeat of this message merges into, if any.
 *
 * Toasts carrying an action or a progress bar are addressed by id by whoever
 * raised them (an upload updates its own row), so they never take part.
 */
function mergeTarget(message: string, type: Toast["type"]): Toast | undefined {
  return state.list.find(
    (toast) =>
      !toast.exiting &&
      toast.message === message &&
      toast.type === type &&
      !toast.action &&
      !toast.cancel &&
      toast.progress === undefined,
  );
}

export function useToast(): {
  toasts: Accessor<Toast[]>;
  show: (
    message: string,
    type?: Toast["type"],
    duration?: number,
    options?: { progress?: number; action?: ToastAction; cancel?: () => void },
  ) => number;
  update: (
    id: number,
    patch: Partial<Omit<Toast, "id">>,
    options?: { duration?: number },
  ) => void;
  dismiss: (id: number) => void;
  drop: (id: number) => void;
  remove: (id: number) => void;
  error: (message: string) => void;
  success: (message: string) => void;
} {
  function show(
    message: string,
    type: Toast["type"] = "info",
    duration = 4000,
    options?: { progress?: number; action?: ToastAction; cancel?: () => void },
  ) {
    // A flood of the same message — one failed request per row of a batch, say —
    // collapses into the row already on screen: bump its count, restart its
    // timer, and stay quiet rather than replaying the sound per repeat.
    if (!options?.action && !options?.cancel && options?.progress === undefined) {
      const existing = mergeTarget(message, type);
      if (existing) {
        setState(
          "list",
          (toast) => toast.id === existing.id,
          "count",
          (count) => (count ?? 1) + 1,
        );
        scheduleDismiss(existing.id, duration);
        return existing.id;
      }
    }

    const id = ++nextId;
    setState("list", state.list.length, {
      id,
      message,
      type,
      progress: options?.progress,
      action: options?.action,
      cancel: options?.cancel,
    });
    scheduleDismiss(id, duration);

    switch (type) {
      case "success":
        play("release");
        break;
      case "error":
        play("bloom");
        break;
    }

    return id;
  }

  function update(
    id: number,
    patch: Partial<Omit<Toast, "id">>,
    options?: { duration?: number },
  ) {
    if (!toasts().some((toast) => toast.id === id)) return;

    setState("list", (toast) => toast.id === id, patch);
    if (options?.duration && options.duration > 0) {
      scheduleDismiss(id, options.duration);
    }
  }

  return {
    toasts,
    show,
    update,
    dismiss,
    drop,
    /**
     * Remove immediately, skipping the leave animation. For callers that
     * replace a toast rather than letting it expire.
     */
    remove: drop,
    error: (message: string) => {
      show(message, "error");
    },
    success: (message: string) => {
      show(message, "success");
    },
  };
}
