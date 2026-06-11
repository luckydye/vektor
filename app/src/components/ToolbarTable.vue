<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  cellMergeIcon,
  closeThickIcon,
  columnDeleteIcon,
  expressionCellIcon,
  highlightIcon,
  pasteIcon,
  plusOverlayIcon,
  rowDeleteIcon,
  scissorsIcon,
  tableColumnAddAfterIcon,
  tableColumnAddBeforeIcon,
  tableDeleteIcon,
  tableHeaderCellIcon,
  tableRowAddAfterIcon,
  tableRowIcon,
  tableSplitCellIcon,
} from "~/src/assets/icons.ts";
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
        <div class="svg-icon icon" v-html="tableColumnAddBeforeIcon" />
        <div class="svg-icon icon-overlay" v-html="plusOverlayIcon" />
      </button>
      <button @click="Actions.run('format:table:addColumnAfter')" class="menu-btn" title="Add Column After" type="button">
        <div class="svg-icon icon" v-html="tableColumnAddAfterIcon" />
        <div class="svg-icon icon-overlay" v-html="plusOverlayIcon" />
      </button>
      <button @click="Actions.run('format:table:deleteColumn')" class="menu-btn menu-btn--danger" title="Delete Column" type="button">
        <div class="svg-icon icon" v-html="columnDeleteIcon" />
        <div class="svg-icon icon-overlay-danger" v-html="closeThickIcon" />
      </button>
    </div>

    <div class="menu-divider"></div>

    <!-- Row Operations -->
    <div class="menu-group">
      <button @click="Actions.run('format:table:addRowBefore')" class="menu-btn" title="Add Row Before" type="button">
        <div class="svg-icon icon" v-html="tableRowIcon" />
        <div class="svg-icon icon-overlay" v-html="plusOverlayIcon" />
      </button>
      <button @click="Actions.run('format:table:addRowAfter')" class="menu-btn" title="Add Row After" type="button">
        <div class="svg-icon icon" v-html="tableRowAddAfterIcon" />
        <div class="svg-icon icon-overlay" v-html="plusOverlayIcon" />
      </button>
      <button @click="Actions.run('format:table:deleteRow')" class="menu-btn menu-btn--danger" title="Delete Row" type="button">
        <div class="svg-icon icon" v-html="rowDeleteIcon" />
        <div class="svg-icon icon-overlay-danger" v-html="closeThickIcon" />
      </button>
      <button @click="cutRow" class="menu-btn" title="Cut Row" type="button">
        <div class="svg-icon icon" v-html="rowDeleteIcon" />
        <div class="svg-icon icon-overlay" v-html="scissorsIcon" />
      </button>
      <button @click="pasteRow" :disabled="!copiedRow" class="menu-btn" :class="{ 'opacity-50': !copiedRow }" title="Paste Row" type="button">
        <div class="svg-icon icon" v-html="rowDeleteIcon" />
        <div class="svg-icon icon-overlay" v-html="pasteIcon" />
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
        <div class="svg-icon icon" v-html="tableHeaderCellIcon" />
      </button>
      <button @click="Actions.run('format:table:mergeCells')" class="menu-btn" title="Merge Cells" type="button">
        <div class="svg-icon icon" v-html="cellMergeIcon" />
      </button>
      <button @click="Actions.run('format:table:splitCell')" class="menu-btn" title="Split Cell" type="button">
        <div class="svg-icon icon" v-html="tableSplitCellIcon" />
      </button>
    </div>

    <div class="menu-divider"></div>

    <!-- Expression Cell -->
    <div class="menu-group">
      <button @click="insertExpressionCell" class="menu-btn" title="Insert Expression Cell" type="button">
        <div class="svg-icon icon" v-html="expressionCellIcon" />
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
          <div class="svg-icon icon" v-html="highlightIcon" />
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
          <div class="svg-icon w-3 h-3" v-html="closeThickIcon" />
        </button>
      </div>
    </div>

    <div class="menu-divider"></div>

    <!-- Delete Table -->
    <div class="menu-group">
      <button @click="Actions.run('format:table:delete')" class="menu-btn menu-btn--danger" title="Delete Table" type="button">
        <div class="svg-icon icon" v-html="tableDeleteIcon" />
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";
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
  @apply relative px-2.5 py-2 text-sm font-medium rounded-sm transition-all;
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
  @apply p-1 rounded-sm transition-colors text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100;
}
</style>
