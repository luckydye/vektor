import { mergeProps } from "solid-js";
import { Button } from "./Button.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  confirmLabel: string;
  pendingLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
  form?: string;
  layout?: "split" | "end";
  onCancel?: () => void;
  onConfirm?: () => void;
}

export function DialogFooter(props: Props) {
  const t = useTranslation();

  const merged = mergeProps(
    { tone: "default" as const, layout: "split" as const },
    props,
  );
  // Split fills the width of a phone sheet; on desktop both sit right-aligned.
  const fill = () =>
    `min-h-9 justify-center px-4 ${merged.layout === "split" ? "flex-1 md:flex-none md:min-w-24" : ""}`;

  return (
    <div class="flex items-center justify-end gap-2">
      <Button
        variant="neutral"
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
