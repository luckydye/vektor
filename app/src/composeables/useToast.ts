import { ref } from "vue";

export interface Toast {
  id: number;
  message: string;
  type: "error" | "info" | "success";
}

const toasts = ref<Toast[]>([]);
let nextId = 0;

export function useToast() {
  function show(message: string, type: Toast["type"] = "info", duration = 4000) {
    const id = ++nextId;
    toasts.value = [...toasts.value, { id, message, type }];
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, duration);
  }

  function error(message: string) {
    show(message, "error");
  }

  function success(message: string) {
    show(message, "success");
  }

  return { toasts, show, error, success };
}
