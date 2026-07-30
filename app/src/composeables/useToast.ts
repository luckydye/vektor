import { play } from "cuelume";
import { ref } from "vue";

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

const toasts = ref<Toast[]>([]);
let nextId = 0;

export function useToast() {
  function show(
    message: string,
    type: Toast["type"] = "info",
    duration = 4000,
    options?: { progress?: number; action?: ToastAction },
  ) {
    const id = ++nextId;
    toasts.value = [
      ...toasts.value,
      {
        id,
        message,
        type,
        progress: options?.progress,
        action: options?.action,
      },
    ];
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }

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
    const found = toasts.value.some((toast) => toast.id === id);
    if (!found) return;

    toasts.value = toasts.value.map((toast) =>
      toast.id === id ? { ...toast, ...patch } : toast,
    );
    if (options?.duration && options.duration > 0) {
      setTimeout(() => dismiss(id), options.duration);
    }
  }

  /**
   * Start the toast leaving. The container animates it out and then calls
   * `drop`. Kept separate from `drop` so the element survives long enough to
   * animate — nothing else may depend on the toast being gone after this.
   */
  function dismiss(id: number) {
    toasts.value = toasts.value.map((toast) =>
      toast.id === id ? { ...toast, exiting: true } : toast,
    );
  }

  /** Remove the toast for real. Safe to call twice. */
  function drop(id: number) {
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  /**
   * Remove immediately, skipping the leave animation. For callers that replace
   * a toast rather than letting it expire.
   */
  function remove(id: number) {
    drop(id);
  }

  function error(message: string) {
    show(message, "error");
  }

  function success(message: string) {
    show(message, "success");
  }

  return { toasts, show, update, dismiss, drop, remove, error, success };
}
