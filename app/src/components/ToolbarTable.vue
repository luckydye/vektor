<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Actions } from "../utils/actions.ts";

const getEditor = () => globalThis.__editor;

const menuRef = ref(null);
const shouldShow = ref(false);
const menuStyle = ref({});
const cellBackgroundColor = ref("transparent");
const cellBgColorInput = ref(null);
const copiedRow = ref(null);

function checkVisibility() {
  const editor = getEditor();
  if (!editor || editor.isDestroyed) {
    shouldShow.value = false;
    return;
  }

  if (editor.isActive("table")) {
    shouldShow.value = true;
    updatePosition();
    updateCellBackgroundColor();
  } else {
    shouldShow.value = false;
  }
}

function updateCellBackgroundColor() {
  const attrs = getEditor().getAttributes("tableCell");
  cellBackgroundColor.value = attrs.backgroundColor || "transparent";
}

function setCellBackground(event) {
  getEditor()
    .chain()
    .focus()
    .setCellAttribute("backgroundColor", event.target.value)
    .run();
}

function clearCellBackground() {
  getEditor().chain().focus().setCellAttribute("backgroundColor", null).run();
}

function insertExpressionCell() {
  getEditor().chain().focus().insertExpressionCell({ formula: "=" }).run();
}

function cutRow() {
  const { state } = getEditor();
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "tableRow") {
      copiedRow.value = node.toJSON();
      getEditor().chain().focus().deleteRow().run();
      return;
    }
  }
}

function pasteRow() {
  if (!copiedRow.value) return;
  const { state, view } = getEditor();
  const { tr, selection, schema } = state;
  const { $from } = selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "tableRow") {
      const copiedRowNode = schema.nodeFromJSON(copiedRow.value);
      const insertPos = $from.after(d);
      tr.insert(insertPos, copiedRowNode);
      view.dispatch(tr);
      return;
    }
  }
}

function updatePosition() {
  if (!shouldShow.value) return;

  const { state, view } = getEditor();
  const { from } = state.selection;
  const $from = state.doc.resolve(from);

  let tableDepth = null;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "table") {
      tableDepth = depth;
      break;
    }
  }

  if (tableDepth === null) return;

  const tablePos = $from.before(tableDepth);
  const coords = view.coordsAtPos(tablePos);
  const padding = 8;
  const viewportWidth = window.innerWidth;
  const menuWidth = menuRef.value?.offsetWidth ?? 400;
  const maxLeft = viewportWidth - menuWidth - padding;

  const left = Math.min(Math.max(coords.left, padding), maxLeft);

  menuStyle.value = {
    left: `${left}px`,
    top: `${coords.top}px`,
  };
}

function handleEditModeEnd() {
  shouldShow.value = false;
}

onMounted(() => {
  window.addEventListener("editor-update", checkVisibility);
  window.addEventListener("edit-mode-cancel", handleEditModeEnd);
  document.addEventListener("scroll", updatePosition, { passive: true, capture: true });
  window.addEventListener("resize", updatePosition, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("editor-update", checkVisibility);
  window.removeEventListener("edit-mode-cancel", handleEditModeEnd);
  document.removeEventListener("scroll", updatePosition);
  window.removeEventListener("resize", updatePosition);
});
</script>

<template>
  <div
    v-if="shouldShow"
    ref="menuRef"
    class="table-toolbar"
    :style="menuStyle"
  >
    <!-- Column Operations -->
    <div class="menu-group">
      <button @click="Actions.run('format:table:addColumnBefore')" class="menu-btn" title="Add Column Before" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M13 3H6c-.55 0-1 .45-1 1v16c0 .55.45 1 1 1h7V3zm2 0v18h3c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1h-3zm-4 7h-2v2h2v-2z"/></svg>
        <svg class="icon-overlay" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
      <button @click="Actions.run('format:table:addColumnAfter')" class="menu-btn" title="Add Column After" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M11 3H4c-.55 0-1 .45-1 1v16c0 .55.45 1 1 1h7V3zm2 0v18h7c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1h-7zm-2 7H9v2h2v-2z"/></svg>
        <svg class="icon-overlay" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
      <button @click="Actions.run('format:table:deleteColumn')" class="menu-btn menu-btn--danger" title="Delete Column" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M13 3H6c-.55 0-1 .45-1 1v16c0 .55.45 1 1 1h7V3zm2 0v18h3c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1h-3z"/></svg>
        <svg class="icon-overlay-danger" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>

    <div class="menu-divider"></div>

    <!-- Row Operations -->
    <div class="menu-group">
      <button @click="Actions.run('format:table:addRowBefore')" class="menu-btn" title="Add Row Before" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M3 13v7c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-7H3zm7-2V9h2v2h-2z"/></svg>
        <svg class="icon-overlay" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
      <button @click="Actions.run('format:table:addRowAfter')" class="menu-btn" title="Add Row After" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M3 4v7h18V4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1zm7 5H9v2h2V9z"/></svg>
        <svg class="icon-overlay" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
      <button @click="Actions.run('format:table:deleteRow')" class="menu-btn menu-btn--danger" title="Delete Row" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M3 13v7c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-7H3zm0-2h18V4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v7z"/></svg>
        <svg class="icon-overlay-danger" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
      <button @click="cutRow" class="menu-btn" title="Cut Row" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M3 13v7c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-7H3zm0-2h18V4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v7z"/></svg>
        <svg class="icon-overlay" fill="currentColor" viewBox="0 0 24 24"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/></svg>
      </button>
      <button @click="pasteRow" :disabled="!copiedRow" class="menu-btn" :class="{ 'opacity-50': !copiedRow }" title="Paste Row" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M3 13v7c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-7H3zm0-2h18V4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v7z"/></svg>
        <svg class="icon-overlay" fill="currentColor" viewBox="0 0 24 24"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></svg>
      </button>
    </div>

    <div class="menu-divider"></div>

    <!-- Cell Operations -->
    <div class="menu-group">
      <button
        @click="getEditor().chain().focus().toggleHeaderCell().run()"
        :class="['menu-btn', { active: getEditor().isActive('tableHeader') }]"
        title="Toggle Header Cell"
        type="button"
      >
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M3 4v16h18V4H3zm16 14H5V8h14v10z"/><path d="M7 10h10v2H7z"/></svg>
      </button>
      <button @click="Actions.run('format:table:mergeCells')" class="menu-btn" title="Merge Cells" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M17 17.25V14h2v5h-5v-2h3.25L14 13.75l1.41-1.41L18.66 15.5V12h2v5.25M7 6.75V10H5V5h5v2H6.75L10 10.25 8.59 11.66 5.34 8.5V12H3V6.75M11 19v-2h2v2h-2m0-14V3h2v2h-2M3 11v2h2v-2H3m16 0v2h2v-2h-2z"/></svg>
      </button>
      <button @click="Actions.run('format:table:splitCell')" class="menu-btn" title="Split Cell" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M19 14v5h-5v-2h3.25L14 13.75l1.41-1.41L18.66 15.5V12h2v2M5 10h5v2H6.75L10 15.25 8.59 16.66 5.34 13.5V17H3v-5h2M3 3h8v2H3V3m10 0h8v2h-8V3M3 19h8v2H3v-2m10 0h8v2h-8v-2z"/></svg>
      </button>
    </div>

    <div class="menu-divider"></div>

    <!-- Expression Cell -->
    <div class="menu-group">
      <button @click="insertExpressionCell" class="menu-btn" title="Insert Expression Cell" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-6 14h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      </button>
    </div>

    <div class="menu-divider"></div>

    <!-- Cell Background Color -->
    <div class="menu-group">
      <div class="color-picker-wrapper">
        <button
          class="menu-btn color-trigger"
          :class="{ active: cellBackgroundColor !== 'transparent' }"
          title="Cell Background Color"
          type="button"
          @click="cellBgColorInput?.click()"
        >
          <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M16.56 8.94L7.62 0 6.21 1.41l2.38 2.38-5.15 5.15c-.59.59-.59 1.54 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10L10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5z"/></svg>
          <span class="color-bar" :style="{ backgroundColor: cellBackgroundColor }"></span>
        </button>
        <input
          ref="cellBgColorInput"
          type="color"
          :value="cellBackgroundColor === 'transparent' ? '#ffffff' : cellBackgroundColor"
          @input="setCellBackground"
          class="hidden-color-input"
        />
        <button
          v-if="cellBackgroundColor !== 'transparent'"
          @click="clearCellBackground"
          class="color-clear-btn"
          title="Clear Cell Background"
          type="button"
        >
          <svg fill="currentColor" viewBox="0 0 24 24" class="w-3 h-3"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </div>

    <div class="menu-divider"></div>

    <!-- Delete Table -->
    <div class="menu-group">
      <button @click="Actions.run('format:table:delete')" class="menu-btn menu-btn--danger" title="Delete Table" type="button">
        <svg class="icon" fill="currentColor" viewBox="0 0 24 24"><path d="M10 3.5H7V6h3V3.5zm4 0v2.5h3V3.5h-3zM7 11h3V8H7v3zm4 0h3V8h-3v3zm-4 4h3v-3H7v3zm4 0h3v-3h-3v3zm-4 4h3v-3H7v3zm4 0h3v-3h-3v3zM17 8v3h3V8h-3zm0 7h3v-3h-3v3zm-3-11.5C14 2.67 13.33 2 12.5 2h-1C10.67 2 10 2.67 10 3.5V3H6c-.55 0-1 .45-1 1v1H3v2h2v11c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V7h2V5h-2V4c0-.55-.45-1-1-1h-4v-.5z"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";
@reference "../styles/utils.css";
@reference "../styles/theme.css";

.table-toolbar {
  @apply fixed z-40 flex items-center gap-0.5 rounded-md p-1;
  @apply bg-neutral-200 shadow-lg;
  transform: translateY(calc(-100% - 0.5rem));
}

.menu-group {
  @apply flex items-center gap-0.5;
}

.menu-btn {
  @apply relative px-2.5 py-2 text-sm font-medium rounded transition-all;
  @apply text-neutral-700 hover:bg-neutral-100;
  @apply min-w-[2rem] flex items-center justify-center;
}

.menu-btn .icon {
  min-width: 1.5em;
  height: 1.5em;
}

.menu-btn.active {
  @apply bg-blue-500 text-white;
}

.menu-btn.active:hover {
  @apply bg-blue-600;
}

.menu-btn--danger {
  @apply text-red-600 hover:bg-red-50 hover:text-red-700;
}

.menu-divider {
  @apply w-px h-6 bg-neutral-300 mx-1;
}

.icon-overlay {
  @apply w-3 h-3 absolute -top-0.5 -right-0.5 text-green-600;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.3));
}

.icon-overlay-danger {
  @apply w-3 h-3 absolute -top-0.5 -right-0.5 text-red-600;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.3));
}

.color-picker-wrapper {
  @apply relative flex items-center gap-0.5;
}

.color-trigger {
  @apply flex-col gap-0.5 pt-1.5 pb-1;
}

.color-bar {
  @apply w-full h-0.5 rounded-full;
}

.hidden-color-input {
  @apply absolute invisible w-0 h-0;
}

.color-clear-btn {
  @apply p-1 rounded transition-colors text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100;
}
</style>
