<script setup lang="ts">
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { EditorView, basicSetup } from "codemirror";
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "../api/client.ts";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const container = ref<HTMLElement | null>(null);
let editor: EditorView | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const saving = ref(false);
const savedAt = ref<number | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | null = null;

const SAVE_DEBOUNCE_MS = 800;

async function saveContent(code: string) {
  if (saving.value) return;
  saving.value = true;
  try {
    await fetch(`/api/v1/spaces/${props.spaceId}/documents/${props.documentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: code }),
    });
    savedAt.value = Date.now();
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedAt.value = null;
    }, 2000);
  } catch {
    // Silently ignore — next edit will retry
  } finally {
    saving.value = false;
  }
}

function scheduleSave(code: string) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveContent(code);
  }, SAVE_DEBOUNCE_MS);
}

onMounted(async () => {
  const doc = await api.document.get(props.spaceId, props.documentId, { draft: true });
  const initialCode = doc.content ?? "";

  if (!container.value) return;

  editor = new EditorView({
    doc: initialCode,
    extensions: [
      basicSetup,
      javascript(),
      keymap.of([indentWithTab]),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
        ".cm-content": { padding: "12px 0" },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave(update.state.doc.toString());
        }
      }),
    ],
    parent: container.value,
  });
});

onUnmounted(() => {
  if (saveTimer) clearTimeout(saveTimer);
  if (savedTimer) clearTimeout(savedTimer);
  editor?.destroy();
  editor = null;
});
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center justify-between px-3 py-2 border-b border-neutral-200 bg-neutral-50 text-xs text-neutral-400 shrink-0">
      <span>JavaScript</span>
      <span v-if="saving">Saving…</span>
      <span v-else-if="savedAt" class="text-emerald-500">Saved</span>
    </div>
    <div ref="container" class="flex-1 min-h-0 overflow-hidden" />
  </div>
</template>
