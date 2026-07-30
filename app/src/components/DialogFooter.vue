<script setup lang="ts">
import { t } from "#utils/lang.ts";
import Button from "./Button.vue";

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
   * form keep its own validation and `@submit` handler while its button lives
   * down here in the pinned footer.
   */
  form?: string;
  /** `split` fills the width 50/50; `end` right-aligns at content width. */
  layout?: "split" | "end";
}

const props = withDefaults(defineProps<Props>(), {
  tone: "default",
  layout: "split",
});

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();
</script>

<template>
  <div
    :class="layout === 'split' ? 'flex gap-2' : 'flex items-center justify-end gap-2xs'"
  >
    <Button
      variant="secondary"
      :class="layout === 'split' ? 'flex-1 justify-center' : ''"
      :disabled="pending"
      :text="cancelLabel ?? t('Cancel')"
      @click="emit('cancel')"
    />
    <Button
      :class="layout === 'split' ? 'flex-1 justify-center' : ''"
      :tone="tone"
      :type="props.form ? 'submit' : 'button'"
      :form="props.form"
      :disabled="pending || disabled"
      :text="pending && pendingLabel ? pendingLabel : confirmLabel"
      @click="!props.form && emit('confirm')"
    />
  </div>
</template>
