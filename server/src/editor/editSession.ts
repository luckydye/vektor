/**
 * Framework-free seam between the editor's keymap and the edit-session state.
 *
 * The generic editor keymap only needs to call into the UI-owned edit session,
 * so the client registers the implementation here at editor construction. This
 * keeps the base editor independent from the document editing composable.
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
