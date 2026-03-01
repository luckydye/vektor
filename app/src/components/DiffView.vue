<!--
Displays inline diff by parsing a git patch.

Usage:
<DiffView :patch="patchString" />

Shows changes as:
- Green background: Lines added in the revision
- Red background: Lines removed from the revision
- Normal: Context lines
-->

<script setup lang="ts">
import { computed } from "vue";
import { parsePatch } from "diff";

interface Props {
  patch: string;
}

const props = defineProps<Props>();

const lines = computed(() => {
  const result: Array<{ type: "add" | "remove" | "context"; content: string }> = [];

  try {
    const patches = parsePatch(props.patch);

    for (const file of patches) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          const lineChar = line[0];
          const content = line.slice(1);

          if (lineChar === "+") {
            result.push({ type: "add", content });
          } else if (lineChar === "-") {
            result.push({ type: "remove", content });
          } else if (lineChar !== "\\") {
            result.push({ type: "context", content });
          }
        }
      }
    }
  } catch (error) {
    console.error("Failed to parse patch:", error);
  }

  return result;
});
</script>

<template>
  <div class="space-y-0">
    <div
      v-for="(line, index) in lines"
      :key="index"
      :class="{
        'whitespace-pre-wrap wrap-break-word block py-0.5': true,
        'bg-red-100 text-red-700': line.type === 'remove',
        'bg-green-100 text-green-700': line.type === 'add',
        'text-neutral-900': line.type === 'context',
      }"
      v-html="line.content"
    ></div>
  </div>
</template>