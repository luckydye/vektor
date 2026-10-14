import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { type DialogRequest, useDialogRequest } from "#composeables/useDialogs.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";

/** Renders the dialogs raised through `confirmDialog` and `promptDialog`. */
export function DialogHost() {
  const t = useTranslation();
  const { request, settle } = useDialogRequest();
  const [value, setValue] = createSignal("");
  // Settling clears the request at once; the closing dialog keeps showing it.
  const shown = createMemo<DialogRequest | null>(
    (previous) => request() ?? previous,
    request(),
  );
  let input: HTMLInputElement | undefined;

  createEffect(() => {
    const current = request();
    if (current?.kind !== "prompt") return;
    setValue(current.defaultValue);
    const field = input;
    const layer = field?.closest<HTMLElement & { updateComplete: Promise<boolean> }>(
      "a-blur",
    );
    if (!field || !layer) throw new Error("Prompt input is not mounted");
    // The layer stays inert, refusing focus, until its own update enables it.
    void layer.updateComplete.then(() => {
      field.focus();
      field.select();
    });
  });

  return (
    <Dialog
      show={!!request()}
      title={shown()?.title}
      bodyClass={`overflow-y-auto px-5 pb-5 ${shown()?.title ? "pt-1" : "pt-5"}`}
      onClose={() => settle(false)}
      footer={
        <DialogFooter
          form="dialog-host-form"
          tone={shown()?.tone}
          confirmLabel={shown()?.confirmLabel ?? t("Confirm")}
          onCancel={() => settle(false)}
        />
      }
    >
      <form
        id="dialog-host-form"
        class="space-y-3xs"
        onSubmit={(event) => {
          event.preventDefault();
          settle(true, value());
        }}
      >
        <p class="whitespace-pre-line text-neutral-700 text-size-medium">
          {shown()?.message}
        </p>
        <Show when={shown()?.kind === "prompt"}>
          <input
            ref={input}
            type="text"
            autocomplete="off"
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
            class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
          />
        </Show>
      </form>
    </Dialog>
  );
}
