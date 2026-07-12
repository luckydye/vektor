import { ref } from "vue";
import { play } from "cuelume";

export interface Toast {
  id: number;
  message: string;
  type: "error" | "info" | "success";
  progress?: number;
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

export function useToast() {
  function show(
    message: string,
    type: Toast["type"] = "info",
    duration = 4000,
    options?: { progress?: number },
  ) {
    const id = ++nextId;
    toasts.value = [...toasts.value, { id, message, type, progress: options?.progress }];
    if (duration > 0) {
      setTimeout(() => remove(id), duration);
    }

    play("success");
    
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
      setTimeout(() => remove(id), options.duration);
    }
  }

  function remove(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function error(message: string) {
    show(message, "error");
  }

  function success(message: string) {
    show(message, "success");
  }

  return { toasts, show, update, remove, error, success };
}
