<script setup lang="ts">
// CodeJar reads `window` at module scope, so it must not be imported during
// SSR — the value is pulled in dynamically from onMounted below.
import type { CodeJar } from "codejar";
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "#api/client.ts";
import { ensureLanguage, highlightToHtml } from "#editor/prism.ts";

const LANGUAGE = "javascript";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const codeEl = ref<HTMLElement | null>(null);
const gutterEl = ref<HTMLElement | null>(null);
const lineCount = ref(1);
const activeLine = ref(1);
const saving = ref(false);
const savedAt = ref<number | null>(null);

let jar: CodeJar | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedTimer: ReturnType<typeof setTimeout> | null = null;

const SAVE_DEBOUNCE_MS = 800;

function highlight(element: HTMLElement) {
  const code = element.textContent ?? "";
  element.innerHTML = highlightToHtml(code, LANGUAGE);
  lineCount.value = countLines(code);
}

function countLines(code: string) {
  let lines = 1;
  for (const char of code) {
    if (char === "\n") lines += 1;
  }
  return lines;
}

function syncGutterScroll() {
  if (!codeEl.value || !gutterEl.value) return;
  gutterEl.value.scrollTop = codeEl.value.scrollTop;
}

function syncActiveLine() {
  if (!jar || !codeEl.value) return;
  const selection = window.getSelection();
  if (!selection?.focusNode || !codeEl.value.contains(selection.focusNode)) return;
  const caret = jar.save().start;
  activeLine.value = countLines((codeEl.value.textContent ?? "").slice(0, caret));
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
  } catch (error) {
    // Next edit will retry, but log so failures aren't invisible.
    console.error("Failed to save workflow code", error);
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
  // The grammar has to be in place before CodeJar's first highlight pass,
  // otherwise the initial content renders as plain text.
  const [doc, , codejar] = await Promise.all([
    api.document.get(props.spaceId, props.documentId, { draft: true }),
    ensureLanguage(LANGUAGE),
    import("codejar"),
  ]);

  if (!codeEl.value) return;

  jar = codejar.CodeJar(codeEl.value, highlight, {
    tab: "  ",
    catchTab: true,
    addClosing: true,
    preserveIdent: true,
    spellcheck: false,
  });

  // CodeJar sets `pre-wrap` inline; wrapped lines would desync the gutter, so
  // long lines scroll horizontally instead.
  codeEl.value.style.whiteSpace = "pre";
  codeEl.value.style.overflow = "auto";

  jar.updateCode(doc.content ?? "");
  jar.onUpdate((code) => {
    lineCount.value = countLines(code);
    syncActiveLine();
    scheduleSave(code);
  });

  codeEl.value.addEventListener("scroll", syncGutterScroll, { passive: true });
  codeEl.value.addEventListener("keyup", syncActiveLine);
  codeEl.value.addEventListener("mouseup", syncActiveLine);
  codeEl.value.addEventListener("focus", syncActiveLine);
});

onUnmounted(() => {
  if (saveTimer) clearTimeout(saveTimer);
  if (savedTimer) clearTimeout(savedTimer);
  codeEl.value?.removeEventListener("scroll", syncGutterScroll);
  codeEl.value?.removeEventListener("keyup", syncActiveLine);
  codeEl.value?.removeEventListener("mouseup", syncActiveLine);
  codeEl.value?.removeEventListener("focus", syncActiveLine);
  jar?.destroy();
  jar = null;
});
</script>

<template>
  <div class="workflow-code-editor flex flex-col h-full">
    <div class="cj-header">
      <span>JavaScript</span>
      <span v-if="saving">Saving…</span>
      <span v-else-if="savedAt" class="cj-saved">Saved</span>
    </div>
    <div class="cj-body">
      <div ref="gutterEl" class="cj-gutter" aria-hidden="true">
        <div
          v-for="line in lineCount"
          :key="line"
          class="cj-gutter-line"
          :class="{ 'is-active': line === activeLine }"
        >
          {{ line }}
        </div>
      </div>
      <div
        ref="codeEl"
        class="cj-code code-highlight"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        translate="no"
      />
    </div>
  </div>
</template>

<style>
.workflow-code-editor {
  --cj-font-size: 13px;
  --cj-line-height: 20px;
  --cj-background: #ffffff;
  --cj-foreground: #1f2328;
  --cj-gutter-background: #f9f9f9;
  --cj-gutter-border: #e8e8e8;
  --cj-gutter-foreground: #a0a0a0;
  --cj-gutter-active: #3d3d3d;
  --cj-active-line: rgba(0, 0, 0, 0.035);
  --cj-selection: #cbacd6;
  --cj-caret: #78378f;
  --cj-muted: #6e6e6e;
  background: var(--cj-background);
  color: var(--cj-foreground);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .workflow-code-editor {
    --cj-background: #151515;
    --cj-foreground: #e7e7e7;
    --cj-gutter-background: #151515;
    --cj-gutter-border: #2f2f2f;
    --cj-gutter-foreground: #5a5a5a;
    --cj-gutter-active: #cdcdcd;
    --cj-active-line: rgba(255, 255, 255, 0.045);
    --cj-selection: #4b3a6d;
    --cj-caret: #c099cf;
    --cj-muted: #909090;
  }
}

:root[data-theme="dark"] .workflow-code-editor {
  --cj-background: #151515;
  --cj-foreground: #e7e7e7;
  --cj-gutter-background: #1b1b1b;
  --cj-gutter-border: #2f2f2f;
  --cj-gutter-foreground: #5a5a5a;
  --cj-gutter-active: #cdcdcd;
  --cj-active-line: rgba(255, 255, 255, 0.045);
  --cj-selection: #4b3a6d;
  --cj-caret: #c099cf;
  --cj-muted: #909090;
}

.workflow-code-editor .cj-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--cj-gutter-border);
  background: var(--cj-gutter-background);
  color: var(--cj-muted);
  font-size: var(--text-size-small);
}

.workflow-code-editor .cj-saved {
  color: #10b981;
}

.workflow-code-editor .cj-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--cj-background);
}

.workflow-code-editor .cj-gutter {
  flex: none;
  overflow: hidden;
  padding: 12px 8px 12px 12px;
  border-right: 1px solid var(--cj-gutter-border);
  background: var(--cj-gutter-background);
  color: var(--cj-gutter-foreground);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--cj-font-size);
  line-height: var(--cj-line-height);
  text-align: right;
  user-select: none;
}

.workflow-code-editor .cj-gutter-line {
  height: var(--cj-line-height);
  min-width: 2ch;
  font-variant-numeric: tabular-nums;
}

.workflow-code-editor .cj-gutter-line.is-active {
  color: var(--cj-gutter-active);
}

.workflow-code-editor .cj-code {
  flex: 1;
  min-width: 0;
  padding: 12px 16px;
  outline: none;
  background: var(--cj-background);
  color: var(--cj-foreground);
  caret-color: var(--cj-caret);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--cj-font-size);
  line-height: var(--cj-line-height);
  tab-size: 2;
}

.workflow-code-editor .cj-code::selection,
.workflow-code-editor .cj-code ::selection {
  background: var(--cj-selection);
}

/* Token colors come from the shared rules in editor/css/code.css, which the
   `code-highlight` class on `.cj-code` opts into. */
</style>
