/**
 * Framework-free seam between the editor's keymap and the Vue edit-session
 * state.
 *
 * `contentExtensions` — and therefore every extension reachable from it — is
 * built on the server to (de)serialize documents. Importing the Vue composables
 * directly from an extension pulled the whole Vue runtime and compiler into the
 * server process (and into each serialization worker) purely to construct a
 * ProseMirror schema. The keymap only needs to *call* into the session, so the
 * client registers the implementation here at editor construction and the
 * extension stays dependency-free.
 */

let cancelHandler: (() => boolean) | null = null;

/**
 * Registers the edit-session cancel behaviour. Called from the client when an
 * editor is created; pass `null` to unregister.
 */
export function setEditSessionCancelHandler(handler: (() => boolean) | null): void {
  cancelHandler = handler;
}

/**
 * Cancels the active edit session. Returns true when the session was cancelled
 * (so the keymap can claim the event), and false when there is nothing to
 * cancel — including on the server, where no handler is ever registered.
 */
export function cancelEditSession(): boolean {
  return cancelHandler?.() ?? false;
}
