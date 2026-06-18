import { ref } from "vue";

export type SaveMode = "revision" | "suggestion";

/** Whether the user has an active editing session on the current document. */
export const editing = ref(false);

/** Whether Tiptap is fully initialised and ready to save. */
export const editingReady = ref(false);

/** Save status forwarded from useDocument so any component can read it. */
export const saveStatus = ref("");
export const saveError = ref<Error | null>(null);

/**
 * Incremented each time the user explicitly cancels editing (as opposed to
 * saving). DocumentContent watches this to run cancel-specific cleanup
 * (discard unsaved HTML, cancel the debounce).
 */
export const cancelCount = ref(0);

// The save function is registered by DocumentContent once the editor is ready.
let _save: ((mode?: SaveMode) => Promise<void>) | null = null;

export function setSave(fn: (mode?: SaveMode) => Promise<void>) {
  _save = fn;
}

export function save(mode?: SaveMode) {
  return _save?.(mode) ?? Promise.resolve();
}

/** Called by DocumentContent on mount to clear any stale state from a previous page. */
export function resetEditingState() {
  editing.value = false;
  editingReady.value = false;
  saveStatus.value = "";
  saveError.value = null;
  _save = null;
}
