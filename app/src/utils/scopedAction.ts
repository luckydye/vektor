import { onCleanup } from "solid-js";
import { type ActionOptions, Actions } from "#utils/actions.ts";

// Lives apart from `actions.ts` because that module is reachable from the server
// document path (via `editor/extensions.ts`), which must not import solid-js —
// `server-frontend-imports.spec.ts` enforces it.
/**
 * Registers an action for as long as the current reactive owner lives — use it
 * for anything that only makes sense in a context, so a document action cannot
 * outlive its document and keep haunting the command palette and context menu
 * of the home page.
 *
 * Cleanup compares the stored options against the ones registered here: ids are
 * global, and several owners may register the same id (e.g. one DocumentActions
 * per header layout). Without the check, the one leaving last would delete the
 * registration the one arriving already replaced it with.
 */
export function registerScopedAction(id: string, options: ActionOptions) {
  Actions.register(id, options);
  onCleanup(() => {
    if (Actions.get(id) === options) Actions.unregister(id);
  });
  return id;
}
