import { createEffect, createSignal, Show } from "solid-js";
import { useDialogRequest } from "#composeables/useDialogs.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";

/** Renders the dialogs raised through `confirmDialog` and `promptDialog`. */
export function DialogHost() {
  const t = useTranslation();
  const { request, settle } = useDialogRequest();
  const [value, setValue] = createSignal("");
  let input: HTMLInputElement | undefined;

  createEffect(() => {
    const current = request();
    if (current?.kind !== "prompt") return;
    setValue(current.defaultValue);
    input?.focus();
    input?.select();
  });

  return (
    <Dialog
      show={!!request()}
      title={request()?.title}
      bodyClass={`overflow-y-auto px-5 pb-5 ${request()?.title ? "pt-1" : "pt-5"}`}
      onClose={() => settle(false)}
      footer={
        <DialogFooter
          form="dialog-host-form"
          tone={request()?.tone}
          confirmLabel={request()?.confirmLabel ?? t("Confirm")}
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
          {request()?.message}
        </p>
        <Show when={request()?.kind === "prompt"}>
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
