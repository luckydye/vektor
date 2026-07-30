<script setup lang="ts">
import { computed } from "vue";

interface Props {
  /** Visual family. Each maps to one `button-*` utility in `styles/theme.css`. */
  variant?: "primary" | "secondary" | "ghost" | "outline";
  /** Colour override layered on top of the variant. */
  tone?: "default" | "danger";
  size?: "medium" | "small";
  text?: string;
  /** Raw SVG markup, rendered inline. Use the default slot for anything richer. */
  icon?: string;
  /** Accessible name and tooltip. Required for icon-only buttons. */
  ariaLabel?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
}

const props = withDefaults(defineProps<Props>(), {
  variant: "primary",
  tone: "default",
  size: "medium",
  type: "button",
});

// Written out in full: Tailwind scans source text, so an interpolated
// `button-${variant}` would never emit the utility.
const VARIANT_CLASS = {
  primary: "button-primary",
  secondary: "button-secondary",
  ghost: "button-ghost",
  outline: "button-outline",
} as const;

const classes = computed(() => [
  VARIANT_CLASS[props.variant],
  props.tone === "danger" && "button-danger",
  props.size === "small" && "button-small",
]);
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled"
    :aria-label="ariaLabel"
    :title="ariaLabel"
  >
    <slot />
    <div v-if="icon" v-html="icon" class="icon" />
    <span v-if="text">{{ text }}</span>
  </button>
</template>
