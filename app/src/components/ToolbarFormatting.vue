<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { Actions } from "../utils/actions.ts";
import {
  registerFormattingActions,
  unregisterFormattingActions,
} from "../utils/formattingActions.ts";
import {
  toggleImageFullWidth,
  resetImageSize,
  isImageSelected,
  getImageAttributes,
} from "../editor/commands/imageCommands.ts";

const getEditor = () => {
  return globalThis.__editor;
};

const menuRef = ref(null);
const shouldShow = ref(false);
const menuStyle = ref({});
const isPinned = ref(true);
const textColorInput = ref(null);
const bgColorInput = ref(null);
const isInteractingWithMenu = ref(false);
const isEditMode = ref(false);
const isInColumnLayout = ref(false);
const currentColumnCount = ref(2);
const isImageActive = ref(false);
const currentImageWidth = ref(null);
const currentImageDisplay = ref(null);
const headingDropdownOpen = ref(false);
const headingButtonRef = ref(null);

const currentHeadingLevel = ref(0); // 0 means paragraph

function updateCurrentHeadingLevel() {
  for (let level = 1; level <= 6; level++) {
    if (getEditor().isActive("heading", { level })) {
      currentHeadingLevel.value = level;
      return;
    }
  }
  currentHeadingLevel.value = 0;
}

function setHeading(level) {
  if (level === 0) {
    Actions.run("format:heading:paragraph");
  } else {
    Actions.run(`format:heading:${level}`);
  }
  headingDropdownOpen.value = false;
}

const headingDropdownStyle = computed(() => {
  if (!headingButtonRef.value || !headingDropdownOpen.value) {
    return {};
  }
  const rect = headingButtonRef.value.getBoundingClientRect();
  return {
    position: "fixed",
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    zIndex: 9999,
  };
});

const currentTextColor = ref("#000000");
const currentBgColor = ref("transparent");

function updateCurrentColors() {
  const attrs = getEditor().getAttributes("textStyle");
  currentTextColor.value = attrs.color || "#000000";
  currentBgColor.value = attrs.backgroundColor || "transparent";
}

function setLink() {
  Actions.run("format:link");
}

function setTextColor(event) {
  getEditor().chain().focus().setColor(event.target.value).run();
}

function setBgColor(event) {
  getEditor().chain().focus().setBackgroundColor(event.target.value).run();
}

function clearBgColor() {
  Actions.run("format:color:clear");
}

function togglePin() {
  isPinned.value = !isPinned.value;
  localStorage.setItem("toolbar-pinned", String(isPinned.value));
  updatePosition();
}

function checkVisibility() {
  const editor = getEditor();

  // If editor is not available or destroyed, unregister actions and hide toolbar
  if (!editor || editor.isDestroyed) {
    if (isEditMode.value) {
      isEditMode.value = false;
      unregisterFormattingActions();
    }
    shouldShow.value = false;
    return;
  }

  isInColumnLayout.value = editor.isActive("columnLayout");
  isImageActive.value = isImageSelected(editor);
  updateCurrentHeadingLevel();
  updateCurrentColors();

  // When pinned, always show the toolbar
  if (isPinned.value) {
    shouldShow.value = true;
    updatePosition();
    if (isInColumnLayout.value) {
      updateColumnLayoutInfo();
    }
    return;
  }

  if (isInColumnLayout.value) {
    shouldShow.value = true;
    updatePosition();
    updateColumnLayoutInfo();
    return;
  }

  if (isImageActive.value) {
    shouldShow.value = true;
    updatePosition();
    updateImageInfo();
    return;
  }

  const { state } = getEditor();
  const { selection } = state;
  const { from, to } = selection;

  if (from === to) {
    shouldShow.value = false;
    return;
  }

  const selectedText = state.doc.textBetween(from, to, " ");
  if (selectedText.trim().length === 0) {
    shouldShow.value = false;
    return;
  }

  shouldShow.value = true;
  updatePosition();
}

function updateColumnLayoutInfo() {
  const attrs = getEditor().getAttributes("columnLayout");
  currentColumnCount.value = attrs.columns || 2;
}

function updateImageInfo() {
  const attrs = getImageAttributes(getEditor());
  currentImageWidth.value = attrs?.width || null;
  currentImageDisplay.value = attrs?.display || null;
}

function toggleFullWidth() {
  toggleImageFullWidth(getEditor());
  updateImageInfo();
}

function resetImage() {
  resetImageSize(getEditor());
  updateImageInfo();
}

function canIndentListItem() {
  const editor = getEditor();
  return editor.can().sinkListItem("listItem") || editor.can().sinkListItem("taskItem");
}

function canOutdentListItem() {
  const editor = getEditor();
  return editor.can().liftListItem("listItem") || editor.can().liftListItem("taskItem");
}

function setColumnCount(newCount) {
  const { state } = getEditor();
  const { selection } = state;
  const { $from } = selection;

  // Find the column layout node
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "columnLayout") {
      const pos = $from.before(d);
      const currentColumns = node.content.childCount;

      const { tr } = state;

      if (newCount > currentColumns) {
        // Add columns
        for (let i = currentColumns; i < newCount; i++) {
          const columnNode = getEditor().schema.nodes.columnItem.create(
            null,
            getEditor().schema.nodes.paragraph.create(),
          );
          tr.insert(pos + node.nodeSize - 1, columnNode);
        }
      } else if (newCount < currentColumns) {
        // Remove columns from the end
        let offset = 0;
        for (let i = 0; i < currentColumns; i++) {
          const child = node.child(i);
          if (i >= newCount) {
            tr.delete(pos + 1 + offset, pos + 1 + offset + child.nodeSize);
          } else {
            offset += child.nodeSize;
          }
        }
      }

      // Update the columns attribute
      tr.setNodeMarkup(pos, null, { columns: newCount });
      getEditor().view.dispatch(tr);
      currentColumnCount.value = newCount;
      return;
    }
  }
}

function deleteColumnLayout() {
  Actions.run("format:columns:delete");
}

function updatePosition() {
  if (!shouldShow.value) return;

  if (isPinned.value) {
    menuStyle.value = {};
    return;
  }

  const { state, view } = getEditor();
  const { selection } = state;
  const { from } = selection;

  const $from = state.doc.resolve(from);

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const toolbarHeight = 48;
  const padding = 8;

  const nodeDepth = $from.depth;
  const nodeStartPos = $from.start(nodeDepth);
  const nodeCoords = view.coordsAtPos(nodeStartPos);

  let left = nodeCoords.left;
  let top = nodeCoords.top - toolbarHeight;

  if (top < padding) {
    top = padding;
  }

  const menuWidth = menuRef.value?.offsetWidth ?? 600;
  const maxLeft = viewportWidth - menuWidth - padding;

  if (left < padding) {
    left = padding;
  } else if (left > maxLeft) {
    left = Math.max(padding, maxLeft);
  }

  if (top + toolbarHeight > viewportHeight - padding) {
    top = viewportHeight - toolbarHeight - padding;
  }

  menuStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
  };
}

function handleKeyDown(event) {
  if (event.key === "Escape" && shouldShow.value) {
    shouldShow.value = false;
    isInteractingWithMenu.value = false;
    event.preventDefault();
  }
}

function handleMenuMouseDown() {
  isInteractingWithMenu.value = true;
}

function handleMenuMouseUp() {
  setTimeout(() => {
    isInteractingWithMenu.value = false;
  }, 100);
}

function handleClickOutside(event) {
  if (menuRef.value && !menuRef.value.contains(event.target)) {
    setTimeout(() => {
      isInteractingWithMenu.value = false;
      headingDropdownOpen.value = false;
    }, 100);
  }
}

// Handle color picker events from Actions
function handleTextColorOpen() {
  textColorInput.value?.click();
}

function handleBgColorOpen() {
  bgColorInput.value?.click();
}

// Handle edit mode changes
function handleEditModeStart() {
  if (!isEditMode.value) {
    isEditMode.value = true;
    registerFormattingActions();
  }
}

function handleEditModeEnd() {
  if (isEditMode.value) {
    isEditMode.value = false;
    unregisterFormattingActions();
  }
  shouldShow.value = false;
  headingDropdownOpen.value = false;
  isInteractingWithMenu.value = false;
  isImageActive.value = false;
}

onMounted(() => {
  const savedPinState = localStorage.getItem("toolbar-pinned");
  if (savedPinState !== null) {
    isPinned.value = savedPinState === "true";
  }

  window.addEventListener("editor-update", checkVisibility);

  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("pointerup", handleClickOutside);
  document.addEventListener("scroll", updatePosition, { passive: true, capture: true });
  window.addEventListener("resize", updatePosition, { passive: true });

  // Listen for edit mode events
  window.addEventListener("edit-mode-start", handleEditModeStart);
  window.addEventListener("editor-ready", handleEditModeStart);
  window.addEventListener("edit-mode-cancel", handleEditModeEnd);

  // Subscribe to color picker events
  Actions.subscribe("format:color:text:open", handleTextColorOpen);
  Actions.subscribe("format:color:background:open", handleBgColorOpen);
});

onBeforeUnmount(() => {
  // Unregister formatting actions if still in edit mode
  if (isEditMode.value) {
    unregisterFormattingActions();
  }

  window.removeEventListener("edit-mode-start", handleEditModeStart);
  window.removeEventListener("editor-ready", handleEditModeStart);
  window.removeEventListener("edit-mode-cancel", handleEditModeEnd);

  window.removeEventListener("editor-update", checkVisibility);

  document.removeEventListener("keydown", handleKeyDown);
  document.removeEventListener("pointerup", handleClickOutside);
  document.removeEventListener("scroll", updatePosition);
  window.removeEventListener("resize", updatePosition);
});
</script>

<template>
  <div
    v-if="shouldShow"
    ref="menuRef"
    :class="['floating-menu', { 'floating-menu--pinned': isPinned }]"
    :style="menuStyle"
    @mousedown="handleMenuMouseDown"
    @mouseup="handleMenuMouseUp"
  >
    <!-- Image Actions (shown when image is selected) -->
    <div v-if="isImageActive" class="toolbar-section">
      <div class="menu-group">
        <button
          @click="toggleFullWidth"
          :class="['menu-btn', { active: currentImageDisplay === 'full' }]"
          title="Toggle Full Width (drag corner to resize)"
          type="button"
        >
          <svg class="icon" fill="currentColor" viewBox="0 0 24 24">
            <path d="M21 15h2v2h-2v-2zm0-4h2v2h-2v-2zm2 8h-2v2c1 0 2-1 2-2zM13 3h2v2h-2V3zm8 4h2v2h-2V7zm0-4v2h2c0-1-1-2-2-2zM1 7h2v2H1V7zm16-4h2v2h-2V3zm0 16h2v2h-2v-2zM3 3C2 3 1 4 1 5h2V3zm6 0h2v2H9V3zM5 3h2v2H5V3zm-4 8v8c0 1.1.9 2 2 2h12V11H1zm2 8l2.5-3.21 1.79 2.15 2.5-3.22L13 19H3z"/>
          </svg>
        </button>
        <button
          @click="resetImage"
          class="menu-btn"
          title="Reset Image Size"
          type="button"
        >
          <svg class="icon" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Formatting Toolbar -->
    <div class="toolbar-section">
      <!-- Heading Dropdown -->
      <div class="menu-group">
        <button
          ref="headingButtonRef"
          @click.stop="headingDropdownOpen = !headingDropdownOpen"
          @mousedown.stop
          class="menu-btn heading-dropdown-trigger"
          title="Heading Level"
          type="button"
        >
          <span class="text-xs font-semibold">{{ currentHeadingLevel === 0 ? 'P' : `H${currentHeadingLevel}` }}</span>
          <Icon name="chevron-down" class="ml-0.5" />
        </button>
        <Teleport to="body">
          <div v-if="headingDropdownOpen" class="heading-dropdown" :style="headingDropdownStyle">
            <button
                @click="setHeading(0)"
                :class="['heading-option', { active: currentHeadingLevel === 0 }]"
                type="button"
            >
                Paragraph
            </button>
            <button
                v-for="level in [2, 3, 4]"
                :key="level"
                @click="setHeading(level)"
                :class="['heading-option', { active: currentHeadingLevel === level }]"
                type="button"
            >
                <span :class="`heading-preview-${level}`">Heading {{ level }}</span>
            </button>
            </div>
        </Teleport>
      </div>

      <div class="menu-divider"></div>

      <!-- Text Formatting -->
      <div class="menu-group">
        <button
          @click="Actions.run('format:bold')"
          :class="['menu-btn', { active: getEditor().isActive('bold') }]"
          title="Bold"
          type="button"
        >
          <Icon name="bold" class="icon" />
        </button>
        <button
          @click="Actions.run('format:italic')"
          :class="['menu-btn', { active: getEditor().isActive('italic') }]"
          title="Italic"
          type="button"
        >
          <Icon name="italic" class="icon" />
        </button>
        <button
          @click="Actions.run('format:underline')"
          :class="['menu-btn', { active: getEditor().isActive('underline') }]"
          title="Underline"
          type="button"
        >
          <Icon name="underline" class="icon" />
        </button>
        <button
          @click="Actions.run('format:strikethrough')"
          :class="['menu-btn', { active: getEditor().isActive('strike') }]"
          title="Strikethrough"
          type="button"
        >
          <Icon name="strikethrough" class="icon" />
        </button>
      </div>

      <div class="menu-divider"></div>

      <!-- Lists -->
      <div class="menu-group">
        <button
          @click="Actions.run('format:list:bullet')"
          :class="['menu-btn', { active: getEditor().isActive('bulletList') }]"
          title="Bullet List"
          type="button"
        >
          <Icon name="list-unordered" class="icon" />
        </button>
        <button
          @click="Actions.run('format:list:ordered')"
          :class="['menu-btn', { active: getEditor().isActive('orderedList') }]"
          title="Numbered List"
          type="button"
        >
          <Icon name="list-ordered" class="icon" />
        </button>
        <button
          @click="Actions.run('format:list:task')"
          :class="['menu-btn', { active: getEditor().isActive('taskList') }]"
          title="Task List"
          type="button"
        >
          <Icon name="list-check" class="icon" />
        </button>
        <button
          @click="Actions.run('format:list:indent')"
          :class="['menu-btn']"
          :disabled="!canIndentListItem()"
          title="Indent List Item"
          type="button"
        >
          <Icon name="indent" class="icon" />
        </button>
        <button
          @click="Actions.run('format:list:outdent')"
          :class="['menu-btn']"
          :disabled="!canOutdentListItem()"
          title="Outdent List Item"
          type="button"
        >
          <Icon name="outdent" class="icon" />
        </button>
      </div>

      <div class="menu-divider"></div>

      <!-- Text Alignment -->
      <div class="menu-group">
        <button
          @click="Actions.run('format:align:left')"
          :class="['menu-btn', { active: getEditor().isActive({ textAlign: 'left' }) }]"
          title="Align Left"
          type="button"
        >
          <Icon name="align-left" class="icon" />
        </button>
        <button
          @click="Actions.run('format:align:center')"
          :class="['menu-btn', { active: getEditor().isActive({ textAlign: 'center' }) }]"
          title="Align Center"
          type="button"
        >
          <Icon name="align-center" class="icon" />
        </button>
        <button
          @click="Actions.run('format:align:right')"
          :class="['menu-btn', { active: getEditor().isActive({ textAlign: 'right' }) }]"
          title="Align Right"
          type="button"
        >
          <Icon name="align-right" class="icon" />
        </button>
        <button
          @click="Actions.run('format:align:justify')"
          :class="['menu-btn', { active: getEditor().isActive({ textAlign: 'justify' }) }]"
          title="Justify"
          type="button"
        >
          <Icon name="align-justify" class="icon" />
        </button>
      </div>

      <div class="menu-divider"></div>

      <!-- Link -->
      <div class="menu-group">
        <button
          @click="setLink"
          :class="['menu-btn', { active: getEditor().isActive('link') }]"
          title="Link (Ctrl+K)"
          type="button"
        >
          <Icon name="link" class="icon" />
        </button>
      </div>

      <div class="menu-divider"></div>

      <!-- Text Color -->
      <div class="menu-group">
        <div class="color-picker-wrapper">
          <button
            class="menu-btn color-trigger"
            :class="{ active: currentTextColor !== '#000000' }"
            title="Text Color"
            type="button"
            @click="textColorInput?.click()"
          >
            <Icon name="text-color" class="icon" />
            <span class="color-bar" :style="{ backgroundColor: currentTextColor }"></span>
          </button>
          <input
            ref="textColorInput"
            type="color"
            :value="currentTextColor"
            @input="setTextColor"
            class="hidden-color-input"
          />
          <button
            v-if="currentTextColor !== '#000000'"
            @click="getEditor().chain().focus().unsetColor().run()"
            class="color-clear-btn"
            title="Clear Text Color"
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>

        <!-- Background Color -->
        <div class="color-picker-wrapper">
          <button
            class="menu-btn color-trigger"
            :class="{ active: currentBgColor !== 'transparent' }"
            title="Background Color"
            type="button"
            @click="bgColorInput?.click()"
          >
            <Icon name="highlight" class="icon" />
            <span class="color-bar" :style="{ backgroundColor: currentBgColor }"></span>
          </button>
          <input
            ref="bgColorInput"
            type="color"
            :value="currentBgColor === 'transparent' ? '#ffff00' : currentBgColor"
            @input="setBgColor"
            class="hidden-color-input"
          />
          <button
            v-if="currentBgColor !== 'transparent'"
            @click="clearBgColor"
            class="color-clear-btn"
            title="Clear Background Color"
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
    </div>

    <!-- Column Layout Actions (shown when in column layout) -->
    <div v-if="isInColumnLayout" class="toolbar-section hidden! lg:flex!">
        <div class="menu-group">
        <button
            @click="Actions.run('format:columns:2')"
            :class="['menu-btn', { active: currentColumnCount === 2 }]"
            title="2 Columns"
            type="button"
        >
            <Icon name="columns-2" />
        </button>
        <button
            @click="Actions.run('format:columns:3')"
            :class="['menu-btn', { active: currentColumnCount === 3 }]"
            title="3 Columns"
            type="button"
        >
            <Icon name="columns-3" />
        </button>
        <button
            @click="Actions.run('format:columns:4')"
            :class="['menu-btn', { active: currentColumnCount === 4 }]"
            title="4 Columns"
            type="button"
        >
            <Icon name="columns-4" />
        </button>
        </div>

        <div class="menu-divider"></div>

        <!-- Delete Column Layout -->
        <div class="menu-group">
        <button
            @click="Actions.run('format:columns:delete')"
            class="menu-btn menu-btn--danger"
            title="Delete Column Layout"
            type="button"
        >
            <svg class="icon" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
        </button>
        </div>
    </div>

    <!-- Pin Button -->
    <div class="toolbar-section">
      <button
        @click="togglePin"
        class="menu-btn"
        :title="isPinned ? 'Unpin Toolbar' : 'Pin Toolbar to Top'"
        type="button"
      >
        <Icon v-if="isPinned" name="pin-filled" class="icon" />
        <Icon v-else name="pin" class="icon" />
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";
@reference "../styles/utils.css";
@reference "../styles/theme.css";

.floating-menu {
  @apply fixed z-50 flex flex-wrap items-start gap-2 h-[42px] content-start;
}

.floating-menu--pinned {
  @apply fixed h-0 top-[21px] w-[calc(100%-var(--sidebar-width)-100px)] justify-start mb-10;
}

.toolbar-section {
  @apply flex items-center gap-0.5 rounded-md p-1 max-w-[95vw] overflow-x-auto;
  @apply bg-neutral-200 shadow-lg;
}

.menu-group {
  @apply flex items-center gap-0.5;
}

.menu-btn .icon {
    min-width: 1.5em;
    height: 1.5em;
}

.menu-btn {
  @apply relative px-2.5 py-2 text-sm font-medium rounded transition-all;
  @apply text-neutral-700;
  @apply hover:bg-neutral-100;
  @apply min-w-[2rem] flex items-center justify-center;
}

.menu-btn.active {
  @apply bg-blue-500 text-white;
}

.menu-btn.active:hover {
  @apply bg-blue-600;
}

.menu-btn--danger {
  @apply text-red-600;
  @apply hover:bg-red-50;
}

.menu-btn--danger:hover {
  @apply text-red-700;
}

.menu-divider {
  @apply w-px h-6 bg-neutral-300 mx-1;
}

.icon-overlay {
  @apply w-3 h-3 absolute -top-0.5 -right-0.5;
  @apply text-green-600;
  filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.3));
}

.icon-overlay-danger {
  @apply w-3 h-3 absolute -top-0.5 -right-0.5;
  @apply text-red-600;
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
  @apply p-1 rounded transition-colors;
  @apply text-neutral-500 hover:text-neutral-700;
  @apply hover:bg-neutral-100;
}

.heading-dropdown-trigger {
  @apply flex items-center gap-0.5 min-w-[3rem];
}

.heading-dropdown {
  @apply bg-background rounded-md shadow-lg border border-neutral-100;
  @apply py-1 w-[140px];
}

.heading-option {
  @apply w-full px-3 py-1.5 text-left text-sm;
  @apply hover:bg-neutral-100 transition-colors;
}

.heading-option.active {
  @apply bg-blue-50 text-blue-600;
}

.heading-preview-1 { @apply text-lg font-bold; }
.heading-preview-2 { @apply text-base font-bold; }
.heading-preview-3 { @apply text-sm font-semibold; }
.heading-preview-4 { @apply text-sm font-medium; }
.heading-preview-5 { @apply text-xs font-medium; }
.heading-preview-6 { @apply text-xs font-normal; }
</style>
