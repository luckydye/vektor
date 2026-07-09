<script setup lang="ts">
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { basicSetup, EditorView } from "codemirror";
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "#api/client.ts";

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

function getThemeExtension() {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "13px",
        backgroundColor: "var(--color-background)",
        color: "var(--color-forground)",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "monospace",
        backgroundColor: "var(--color-background)",
      },
      ".cm-content": {
        padding: "12px 0",
        backgroundColor: "var(--color-background)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-neutral-50)",
        borderRight: "1px solid var(--color-neutral-200)",
        color: "var(--color-neutral-500)",
      },
      ".cm-gutter": {
        backgroundColor: "var(--color-neutral-50)",
        color: "var(--color-neutral-500)",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--color-neutral-100)",
      },
      ".cm-selectionMatch": {
        backgroundColor: "var(--color-primary-200)",
      },
      "&.cm-focused .cm-cursor": {
        borderLeftColor: "var(--color-primary-500)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "var(--color-primary-200)",
        },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "var(--color-primary-100)",
        outline: "none",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--color-neutral-100)",
        border: "1px solid var(--color-neutral-200)",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
      },
      ".cm-tooltip-autocomplete": {
        backgroundColor: "var(--color-background)",
        border: "1px solid var(--color-neutral-200)",
      },
      ".cm-completionList": {
        backgroundColor: "var(--color-background)",
      },
      ".cm-completionItem": {
        color: "var(--color-forground)",
        padding: "2px 8px",
      },
      ".cm-completionItem-selected": {
        backgroundColor: "var(--color-primary-100)",
        color: "var(--color-primary-700)",
      },
      ".cm-completionItem-label": {
        color: "var(--color-forground)",
      },
      ".cm-completionItem-detail": {
        color: "var(--color-neutral-500)",
      },
      ".cm-completionInfo": {
        backgroundColor: "var(--color-neutral-100)",
        border: "1px solid var(--color-neutral-200)",
        color: "var(--color-neutral-700)",
      },
      ".cm-panel": {
        backgroundColor: "var(--color-neutral-50)",
        borderTop: "1px solid var(--color-neutral-200)",
      },
      ".cm-searchMatch": {
        backgroundColor: "var(--color-primary-200)",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: "var(--color-primary-500)",
      },
    },
    { dark: false },
  );
}

async function saveContent(code: string) {
  if (saving.value) return;
  saving.value = true;
  try {
    await api.document.putCode(props.spaceId, props.documentId, code);
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
      getThemeExtension(),
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
    <div
      class="flex items-center justify-between px-3 py-2 border-b border-neutral-200 bg-neutral-50 text-size-small text-neutral-400 shrink-0"
    >
      <span>JavaScript</span>
      <span v-if="saving">Saving…</span>
      <span v-else-if="savedAt" class="text-emerald-500">Saved</span>
    </div>
    <div ref="container" class="flex-1 min-h-0 overflow-hidden" />
  </div>
</template>
