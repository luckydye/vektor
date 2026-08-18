import { createEffect, createSignal, on, Show } from "solid-js";
import { t } from "#utils/lang.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";

const FORM_ID = "delete-space-form";

interface Props {
  /** The space awaiting deletion, or null while the dialog is closed. */
  space?: { id: string; name: string; slug: string } | null;
  onCancel?: () => void;
  // Awaited: a rejection has to keep the dialog open and land in the error line,
  // since the card behind it is already gone from the caller's point of view.
  onConfirm?: (spaceId: string) => void | Promise<void>;
}

/**
 * Shared by the space's own settings and the spaces overview, where an instance
 * admin can delete a space they never opened. The slug has to be typed out
 * either way: nothing in the app brings the space back.
 */
export function DeleteSpaceDialog(props: Props) {
  const [typed, setTyped] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");

  // A different space in the same dialog starts over, so what was typed for the
  // last one can never confirm this one.
  createEffect(
    on(
      () => props.space?.id,
      () => {
        setTyped("");
        setError("");
      },
    ),
  );

  const slug = () => props.space?.slug ?? "";
  const matches = () => typed().trim() === slug();

  async function handleConfirm() {
    const spaceId = props.space?.id;
    if (!spaceId || !matches() || pending()) return;

    setPending(true);
    setError("");
    try {
      await props.onConfirm?.(spaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Failed to delete the space"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={!!props.space}
      title={t("Delete Space")}
      closeOnBackdrop={!pending()}
      onUpdateShow={(value) => {
        if (!value) props.onCancel?.();
      }}
      footer={
        <DialogFooter
          tone="danger"
          form={FORM_ID}
          confirmLabel={t("Delete Space")}
          pendingLabel={t("Deleting...")}
          pending={pending()}
          disabled={!matches()}
          onCancel={() => props.onCancel?.()}
        />
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(event) => {
          event.preventDefault();
          void handleConfirm();
        }}
        class="space-y-3xs"
      >
        <p class="text-neutral-600 text-size-medium">
          {t("Delete {name}? All documents and data will be archived.").replace(
            "{name}",
            props.space?.name ?? "",
          )}
        </p>

        <div>
          <label
            for="delete-space-slug"
            class="mb-1 block text-neutral-600 text-size-medium"
          >
            {t("Type")}{" "}
            <code class="rounded-sm bg-neutral-100 px-1.5 py-0.5 font-mono text-size-medium">
              {slug()}
            </code>{" "}
            {t("to confirm:")}
          </label>
          <input
            id="delete-space-slug"
            type="text"
            autocomplete="off"
            placeholder={t("Type space slug")}
            value={typed()}
            disabled={pending()}
            onInput={(event) => setTyped(event.currentTarget.value)}
            class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
          />
        </div>

        <Show when={error()}>
          <div class="rounded-md border border-red-200 bg-red-50 p-3">
            <p class="text-red-600 text-size-small">{error()}</p>
          </div>
        </Show>
      </form>
    </Dialog>
  );
}
