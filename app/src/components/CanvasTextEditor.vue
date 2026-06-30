<script setup lang="ts">
import { Editor } from "@tiptap/core";
import { onMounted, onUnmounted, ref, watch } from "vue";
import {
  Bold,
  BulletList,
  Document,
  HardBreak,
  Italic,
  Link,
  ListItem,
  OrderedList,
  Paragraph,
  Text,
} from "../editor/extensions/baseExtensions.ts";
import { messageMarkdownToHtml, tiptapJsonToMarkdown } from "../utils/messageMarkdown.ts";

const props = defineProps<{
  modelValue: string;
  shapeId: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  blur: [content: string];
  focus: [];
}>();

const editorRef = ref<HTMLElement | null>(null);
let editor: Editor | null = null;
let lastEmittedValue = props.modelValue;

function focus() {
  editor?.commands.focus();
}

onMounted(() => {
  if (!editorRef.value) return;
  editor = new Editor({
    element: editorRef.value,
    content: messageMarkdownToHtml(props.modelValue),
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      Bold,
      Italic,
      Link,
      BulletList,
      OrderedList,
      ListItem,
    ],
    editorProps: {
      attributes: {
        class: "canvas-shape-text",
        "data-shape-text": props.shapeId,
        spellcheck: "false",
      },
      handleDOMEvents: {
        focus: () => {
          emit("focus");
          return false;
        },
        blur: () => {
          if (editor) emit("blur", tiptapJsonToMarkdown(editor.getJSON()));
          return false;
        },
      },
    },
    onUpdate: ({ editor: e }) => {
      const markdown = tiptapJsonToMarkdown(e.getJSON());
      lastEmittedValue = markdown;
      emit("update:modelValue", markdown);
    },
  });
});

onUnmounted(() => {
  editor?.destroy();
  editor = null;
});

watch(
  () => props.modelValue,
  (value) => {
    if (!editor || value === lastEmittedValue) return;
    lastEmittedValue = value;
    editor.commands.setContent(messageMarkdownToHtml(value), { emitUpdate: false });
  },
);

defineExpose({ focus });
</script>

<template>
  <div ref="editorRef" class="canvas-shape-textwrap" />
</template>

<style scoped>
:deep(.canvas-shape-text) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  background: transparent;
  padding: 10px 12px;
  color: var(--canvas-text);
  font: inherit;
  font-size: 15px;
  line-height: 1.35;
  outline: none;
  overflow: hidden;
  -webkit-user-select: text;
  user-select: text;
}

:deep(.canvas-shape-text p) {
  margin: 0;
}

:deep(.canvas-shape-text ul) {
  list-style-type: disc;
  padding-left: 1.5rem;
  margin: 0.25rem 0;
}

:deep(.canvas-shape-text ol) {
  list-style-type: decimal;
  padding-left: 1.5rem;
  margin: 0.25rem 0;
}

:deep(.canvas-shape-text li) {
  display: list-item;
  margin: 0.125rem 0;
}

:deep(.canvas-shape-text li > p) {
  display: inline;
}
</style>
