import { ref } from "vue";

export type SaveMode = "revision" | "suggestion";

/** Whether the user has an active editing session on the current document. */
export const editing = ref(false);

/** Save status for the active document edit session. */
export const saveStatus = ref("");
export const saveError = ref<Error | null>(null);

/**
 * Incremented each time the user explicitly cancels editing (as opposed to
 * saving). DocumentContent watches this to run cancel-specific cleanup
 * (discard unsaved HTML, cancel the debounce).
 */
export const cancelCount = ref(0);

/** Called by DocumentContent on mount to clear any stale state from a previous page. */
export function resetEditingState() {
  editing.value = false;
  saveStatus.value = "";
  saveError.value = null;
}
