import { mergeProps } from "solid-js";
import { t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";

interface Props {
  /** Label for the confirming action. */
  confirmLabel: string;
  /** Replaces `confirmLabel` while `pending` — e.g. "Saving…". */
  pendingLabel?: string;
  cancelLabel?: string;
  /** An in-flight action: disables both buttons and swaps the confirm label. */
  pending?: boolean;
  /** Disables confirm alone, for a form that is not yet valid. */
  disabled?: boolean;
  tone?: "default" | "danger";
  /**
   * Submit the `<form>` with this id instead of emitting `confirm`. Lets the
   * form keep its own validation and submit handler while its button lives down
   * here in the pinned footer.
   */
  form?: string;
  /** `split` fills the width 50/50; `end` right-aligns at content width. */
  layout?: "split" | "end";
  onCancel?: () => void;
  onConfirm?: () => void;
}

export function DialogFooter(props: Props) {
  const merged = mergeProps(
    { tone: "default" as const, layout: "split" as const },
    props,
  );
  const fill = () => (merged.layout === "split" ? "flex-1 justify-center" : "");

  return (
    <div
      class={
        merged.layout === "split" ? "flex gap-2" : "flex items-center justify-end gap-2xs"
      }
    >
      <Button
        variant="secondary"
        class={fill()}
        disabled={merged.pending}
        text={merged.cancelLabel ?? t("Cancel")}
        onClick={() => merged.onCancel?.()}
      />
      <Button
        class={fill()}
        tone={merged.tone}
        type={merged.form ? "submit" : "button"}
        form={merged.form}
        disabled={merged.pending || merged.disabled}
        text={
          merged.pending && merged.pendingLabel
            ? merged.pendingLabel
            : merged.confirmLabel
        }
        onClick={() => {
          if (!merged.form) merged.onConfirm?.();
        }}
      />
    </div>
  );
}
