import { type Accessor, createSignal } from "solid-js";

export interface DialogOptions {
  title?: string;
  confirmLabel?: string;
  tone?: "default" | "danger";
}

export type DialogRequest = DialogOptions &
  (
    | { kind: "confirm"; message: string; resolve: (value: boolean) => void }
    | {
        kind: "prompt";
        message: string;
        defaultValue: string;
        resolve: (value: string | null) => void;
      }
  );

/**
 * Module-level like the toast queue: dialogs are raised from anywhere, editor
 * plugins included, and rendered by the single `DialogHost`.
 */
const [request, setRequest] = createSignal<DialogRequest | null>(null);

function open(next: DialogRequest) {
  if (request()) throw new Error("A dialog is already open");
  setRequest(next);
}

/** Replaces `window.confirm`; resolves false when dismissed. */
export function confirmDialog(message: string, options?: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => open({ ...options, kind: "confirm", message, resolve }));
}

/** Replaces `window.prompt`; resolves null when dismissed. */
export function promptDialog(
  message: string,
  defaultValue = "",
  options?: DialogOptions,
): Promise<string | null> {
  return new Promise((resolve) =>
    open({ ...options, kind: "prompt", message, defaultValue, resolve }),
  );
}

export function useDialogRequest(): {
  request: Accessor<DialogRequest | null>;
  settle: (confirmed: boolean, value?: string) => void;
} {
  function settle(confirmed: boolean, value = "") {
    const current = request();
    if (!current) throw new Error("No dialog is open");
    setRequest(null);
    if (current.kind === "confirm") current.resolve(confirmed);
    else current.resolve(confirmed ? value : null);
  }
  return { request, settle };
}
