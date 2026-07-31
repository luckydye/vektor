import { play } from "cuelume";
import { type Accessor, createSignal } from "solid-js";

export interface Toast {
  id: number;
  message: string;
  type: "error" | "info" | "success";
  progress?: number;
  action?: ToastAction;
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
const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 0;

export function useToast(): {
  toasts: Accessor<Toast[]>;
  show: (
    message: string,
    type?: Toast["type"],
    duration?: number,
    options?: { progress?: number; action?: ToastAction },
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
  /**
   * Start the toast leaving. The container animates it out and then calls
   * `drop`. Kept separate from `drop` so the element survives long enough to
   * animate — nothing else may depend on the toast being gone after this.
   */
  function dismiss(id: number) {
    setToasts((list) =>
      list.map((toast) => (toast.id === id ? { ...toast, exiting: true } : toast)),
    );
  }

  /** Remove the toast for real. Safe to call twice. */
  function drop(id: number) {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }

  function show(
    message: string,
    type: Toast["type"] = "info",
    duration = 4000,
    options?: { progress?: number; action?: ToastAction },
  ) {
    const id = ++nextId;
    setToasts((list) => [
      ...list,
      { id, message, type, progress: options?.progress, action: options?.action },
    ]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);

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

    setToasts((list) =>
      list.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)),
    );
    if (options?.duration && options.duration > 0) {
      setTimeout(() => dismiss(id), options.duration);
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
