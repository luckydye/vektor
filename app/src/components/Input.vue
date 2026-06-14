<script setup lang="ts">
import { ref } from "vue";

interface Props {
  placeholder?: string;
  modelValue?: string;
  type?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: "Placeholder",
  modelValue: "",
  type: "text",
  disabled: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const isFocused = ref(false);

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  emit("update:modelValue", target.value);
};

const handleFocus = () => {
  isFocused.value = true;
};

const handleBlur = () => {
  isFocused.value = false;
};
</script>

<template>
  <div class="inline-flex p-[4px] bg-neutral-100 rounded-md w-full">
    <div
      class="relative flex items-center h-[36px] px-xs bg-background border rounded-sm transition-colors w-full"
      :class="{
        'border-black/15': !isFocused,
        'border-primary-500': isFocused
      }"
    >
      <input
        :value="modelValue"
        :placeholder="placeholder"
        :type="type"
        :disabled="disabled"
        @input="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
        class="w-full bg-transparent text-[14px] outline-none placeholder:opacity-30 font-normal disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  </div>
</template>
