<script setup>
import { computed, onMounted, onUnmounted, ref, Teleport } from "vue";
import { api } from "#api/client.ts";
import { useCategories } from "#composeables/useCategories.ts";
import { useCategoryDocuments } from "#composeables/useCategoryDocuments.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueIncludes } from "#utils/documentProperties.ts";
import { getTextColor, spacePath } from "#utils/utils.ts";
import {
  categoryIcon,
  chevronRightThinIcon,
  documentIcon,
  dotsVerticalIcon,
  dragDotsIcon,
  editOutlineIcon,
  plusIcon,
  plusSmallIcon,
  trashCanIcon,
} from "~/src/assets/icons.ts";
import Dialog from "./Dialog.vue";
import DocumentTreeItem from "./DocumentTreeItem.vue";

const { currentSpace } = useSpace();
const { documentSlug: activeDocSlug } = useRoute();
const {
  categories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  isLoading,
} = useCategories();

// Load expanded items (categories and documents) from localStorage
function loadExpandedItems() {
  if (typeof window === "undefined") return new Set();

  const stored = localStorage.getItem(`wiki-expanded-items`);

  if (stored) {
    try {
      return new Set(JSON.parse(stored));
    } catch {
      return new Set();
    }
  }
  return new Set();
}

// Save expanded items to localStorage
function saveExpandedItems(items) {
  if (typeof window === "undefined") return;

  localStorage.setItem(`wiki-expanded-items`, JSON.stringify(Array.from(items)));
}

const isMounted = ref(false);
const expandedItems = ref(new Set());

// Get slugs of expanded categories
const expandedCategorySlugs = computed(() => {
  return categories.value
    .filter((cat) => expandedItems.value.has(cat.id))
    .map((cat) => cat.slug);
});

// Use the composable with all expanded category slugs
const { documentsBySlug } = useCategoryDocuments(expandedCategorySlugs);

const categoriesWithDocs = computed(() => {
  return categories.value.map((category) => {
    const categoryDocs = documentsBySlug.value.get(category.slug) || [];

    // Root docs are docs that belong to this category and whose parent is not in this
    // category's doc list (so they can't be rendered as a nested child).
    const rootDocs = categoryDocs.filter((doc) => {
      const docCategory = doc.properties?.category;
      const docCollection = doc.properties?.collection;

      // A doc with an explicit different category belongs only to that category's tree,
      // never as a root (or child) here — it was included only for descendant traversal.
      if (
        (docCategory || docCollection) &&
        !propertyValueIncludes(docCategory, category.slug) &&
        !propertyValueIncludes(docCollection, category.slug)
      ) {
        return false;
      }

      if (!doc.parentId) return true;

      const parent = categoryDocs.find((d) => d.id === doc.parentId);
      // If parent is in this category's docs, this doc will be rendered as a child there.
      return !parent;
    });

    return {
      ...category,
      docs: categoryDocs,
      rootDocs,
    };
  });
});

// Category edit mode state
const isEditMode = ref(false);
const editingId = ref(null);
const showAddForm = ref(false);
const draggedCategory = ref(null);
const dragOverIndex = ref(null);
const isSaving = ref(false);
const formError = ref(null);
const deletingIds = ref(new Set());
// Category pending deletion (drives the confirmation dialog).
const deleteTarget = ref(null);
const deleteError = ref(null);
const isDeleting = computed(
  () => !!deleteTarget.value && deletingIds.value.has(deleteTarget.value.id),
);

const formData = ref({
  name: "",
  slug: "",
  description: "",
  color: "#4ECDC4",
  icon: "",
});

// Context menu state (opened via right-click on desktop or long-press on touch)
const contextMenu = ref(null);
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE = 10;
let longPressTimer = null;
let longPressStart = null;
let longPressFired = false;

const canManageCategories = computed(() => canEdit(currentSpace.value?.userRole));

function openContextMenu(clientX, clientY, category) {
  if (!canManageCategories.value || isEditMode.value) return;

  // Clamp to the viewport so the menu never renders off-screen.
  const MENU_WIDTH = 224;
  const MENU_HEIGHT = 240;
  const x = Math.min(clientX, window.innerWidth - MENU_WIDTH - 8);
  const y = Math.min(clientY, window.innerHeight - MENU_HEIGHT - 8);

  contextMenu.value = { x: Math.max(8, x), y: Math.max(8, y), category };
}

function closeContextMenu() {
  contextMenu.value = null;
}

// Open the menu anchored under the hover "⋯" button, right-aligned to it.
function handleMenuButton(event, category) {
  const rect = event.currentTarget.getBoundingClientRect();
  const MENU_WIDTH = 224;
  openContextMenu(rect.right - MENU_WIDTH, rect.bottom + 4, category);
}

function clearLongPress() {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressStart = null;
}

function handleTouchStart(event, category) {
  if (!canManageCategories.value || isEditMode.value) return;
  const touch = event.touches[0];
  if (!touch) return;
  longPressFired = false;
  longPressStart = { x: touch.clientX, y: touch.clientY };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressFired = true;
    openContextMenu(longPressStart.x, longPressStart.y, category);
  }, LONG_PRESS_MS);
}

function handleTouchMove(event) {
  if (longPressTimer === null || !longPressStart) return;
  const touch = event.touches[0];
  if (!touch) return;
  const dx = touch.clientX - longPressStart.x;
  const dy = touch.clientY - longPressStart.y;
  // Cancel the long-press if the finger moves (i.e. the user is scrolling).
  if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) {
    clearLongPress();
  }
}

function handleTouchEnd(event) {
  // If the long-press just opened the menu, swallow the trailing synthetic click
  // so it doesn't fall through to the backdrop and immediately close the menu.
  if (longPressFired) {
    event.preventDefault();
    longPressFired = false;
  }
  clearLongPress();
}

// Context menu actions --------------------------------------------------------

function contextNewDocument(category) {
  closeContextMenu();
  window.location.href = spacePath(
    currentSpace.value?.slug,
    `/new?category=${category.slug}`,
  );
}

function contextEditCategory(category) {
  closeContextMenu();
  startEditing(category);
}

function contextNewCategory() {
  closeContextMenu();
  startCreating();
}

function contextRearrange() {
  closeContextMenu();
  if (!isEditMode.value) toggleEditMode();
}

function contextDeleteCategory(category) {
  closeContextMenu();
  requestDelete(category);
}

function handleKeydown(event) {
  if (event.key === "Escape" && contextMenu.value) {
    closeContextMenu();
  }
}

function toggleEditMode() {
  isEditMode.value = !isEditMode.value;
  if (isEditMode.value) {
    // Collapse without saving — localStorage still holds the real state
    expandedItems.value.clear();
  } else {
    // Restore from localStorage
    expandedItems.value = loadExpandedItems();
    resetForm();
  }
}

function resetForm() {
  formData.value = {
    name: "",
    slug: "",
    description: "",
    color: "#4ECDC4",
    icon: "",
  };
  formError.value = null;
  editingId.value = null;
  showAddForm.value = false;
}

function startEditing(category) {
  editingId.value = category.id;
  formData.value = {
    name: category.name,
    slug: category.slug,
    description: category.description || "",
    color: category.color || "#4ECDC4",
    icon: category.icon || "",
  };
  formError.value = null;
}

function startCreating() {
  resetForm();
  showAddForm.value = true;
}

function cancelEdit() {
  // Don't discard the form (and reset state) out from under an in-flight save.
  if (isSaving.value) return;
  resetForm();
}

async function handleSave() {
  if (!currentSpace.value) {
    return;
  }

  isSaving.value = true;
  formError.value = null;

  try {
    if (editingId.value) {
      await updateCategory(
        editingId.value,
        formData.value.name.trim(),
        formData.value.slug.trim(),
        formData.value.description?.trim() || undefined,
        formData.value.color || undefined,
        formData.value.icon?.trim() || undefined,
      );
    } else {
      await createCategory(
        formData.value.name.trim(),
        formData.value.slug.trim(),
        formData.value.description?.trim() || undefined,
        formData.value.color || undefined,
        formData.value.icon?.trim() || undefined,
      );
    }

    resetForm();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : "Failed to save category";
  } finally {
    isSaving.value = false;
  }
}

function handleDragStart(e, category) {
  draggedCategory.value = category;
  e.dataTransfer.effectAllowed = "move";
}

function handleDragOver(e, index) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  dragOverIndex.value = index;
}

function handleDragLeave() {
  dragOverIndex.value = null;
}

async function handleDrop(e, index) {
  e.preventDefault();
  dragOverIndex.value = null;

  if (!draggedCategory.value) return;

  const newOrder = categories.value.map((c) => c.id);
  const draggedIndex = newOrder.indexOf(draggedCategory.value.id);

  if (draggedIndex === index) {
    draggedCategory.value = null;
    return;
  }

  newOrder.splice(draggedIndex, 1);
  newOrder.splice(index, 0, draggedCategory.value.id);

  try {
    await reorderCategories(newOrder);
  } catch (err) {
    formError.value = "Failed to reorder categories";
  } finally {
    draggedCategory.value = null;
  }
}

function requestDelete(category) {
  deleteError.value = null;
  deleteTarget.value = category;
}

function cancelDelete() {
  if (isDeleting.value) return;
  deleteError.value = null;
  deleteTarget.value = null;
}

async function confirmDelete() {
  const category = deleteTarget.value;
  if (!category) return;

  deleteError.value = null;
  deletingIds.value.add(category.id);

  try {
    await deleteCategory(category.id);
    deleteTarget.value = null;
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : "Failed to delete category";
  } finally {
    deletingIds.value.delete(category.id);
  }
}

function toggleItem(itemId) {
  if (expandedItems.value.has(itemId)) {
    expandedItems.value.delete(itemId);
  } else {
    expandedItems.value.add(itemId);
  }
  saveExpandedItems(expandedItems.value);
}

async function handleDocumentParentChange(event) {
  const { documentId, newParentId } = event.detail;

  if (!currentSpace.value) {
    throw new Error("No space selected");
  }

  await api.document.patch(currentSpace.value.id, documentId, {
    parentId: newParentId,
  });

  // Then, update the category property
  await api.document.patch(currentSpace.value.id, documentId, {
    properties: {
      category: null,
    },
  });
}

async function handleDocumentCategoryChange(event) {
  const { documentId, newCategoryId } = event.detail;

  if (!currentSpace.value) {
    throw new Error("No space selected");
  }

  // Find the category to get its slug
  const targetCategory = categories.value.find((c) => c.id === newCategoryId);
  if (!targetCategory) {
    throw new Error("Target category not found");
  }

  // First, clear the parentId
  await api.document.patch(currentSpace.value.id, documentId, {
    parentId: null,
  });

  // Then, update the category property
  await api.document.patch(currentSpace.value.id, documentId, {
    properties: {
      category: {
        value: targetCategory.slug,
      },
    },
  });
}

onMounted(() => {
  // Defer reading client-only state (localStorage, cached query data) until after
  // hydration so server and client render the same initial markup.
  isMounted.value = true;
  expandedItems.value = loadExpandedItems();

  window.addEventListener("document-parent-change", handleDocumentParentChange);
  window.addEventListener("document-category-change", handleDocumentCategoryChange);
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("document-parent-change", handleDocumentParentChange);
  window.removeEventListener("document-category-change", handleDocumentCategoryChange);
  window.removeEventListener("keydown", handleKeydown);
  clearLongPress();
});

defineExpose({ isEditMode, toggleEditMode });
</script>

<template>
  <div class="document-tree">
    <div v-if="!isMounted || isLoading" class="px-5xs space-y-1 hidden md:flex flex-col">
      <!-- Category skeleton -->
      <div v-for="i in 3" :key="`cat-skeleton-${i}`" class="space-y-1">
        <!-- Category header -->
        <div class="flex items-center gap-2 p-2 rounded-md">
          <div class="w-6 h-6 bg-neutral-200 rounded-sm flex-none animate-pulse" />
          <div class="h-4 bg-neutral-200 rounded-sm w-24 animate-pulse" />
        </div>
        <!-- Documents under category -->
        <div class="pl-3 space-y-1">
          <div v-for="j in 2" :key="`doc-skeleton-${i}-${j}`" class="flex items-center gap-2 p-2 rounded-md">
            <div class="w-4 h-4 bg-neutral-200 rounded-sm animate-pulse flex-none" />
            <div class="h-3 bg-neutral-200 rounded-sm w-32 animate-pulse flex-1" />
          </div>
        </div>
      </div>
    </div>

    <template v-if="isMounted">
    <!-- Empty state -->
    <div v-if="!isLoading && !isEditMode && categories.length === 0" class="px-4xs">
      <div
        v-if="canManageCategories"
        class="flex flex-col items-center text-center gap-2 rounded-lg border border-dashed border-neutral-200 px-4 py-5"
      >
        <div class="svg-icon w-6 h-6 text-neutral-400" v-html="categoryIcon" />
        <div>
          <p class="text-size-medium font-medium text-neutral-900">No categories yet</p>
          <p class="text-size-small text-neutral-500 mt-0.5">Group your documents into categories to organize this space.</p>
        </div>
        <button
          type="button"
          @click="startCreating"
          class="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
        >
          <div class="svg-icon w-4 h-4" v-html="plusSmallIcon" />
          <span>Create category</span>
        </button>
      </div>
      <p v-else class="px-3 py-4 text-center text-size-medium text-neutral-500">No categories yet</p>
    </div>

    <!-- Categories List and Documents -->
    <div v-if="!isLoading" class="px-4xs space-y-1">
      <!-- Category Items -->
      <div v-for="category in categoriesWithDocs" :key="category.id">
        <category-target
          :data-category-id="category.id"
          class="block [&[data-drag-over]]:bg-neutral-100"
          :draggable="isEditMode"
          @dragstart="isEditMode && handleDragStart($event, category)"
          @dragover="isEditMode && handleDragOver($event, categories.findIndex(c => c.id === category.id))"
          @dragleave="isEditMode && handleDragLeave()"
          @drop="isEditMode && handleDrop($event, categories.findIndex(c => c.id === category.id))"
          @touchstart.passive="handleTouchStart($event, category)"
          @touchmove.passive="handleTouchMove($event)"
          @touchend="handleTouchEnd($event)"
          @touchcancel="clearLongPress()"
        >
          <div class="group/category flex items-center gap-2 text-size-medium text-neutral-900 hover:bg-neutral-100 active:bg-neutral-200 rounded-md"
            :class="{
              'bg-blue-50 border border-blue-300': dragOverIndex === categories.findIndex(c => c.id === category.id) && isEditMode,
              'cursor-move': isEditMode
            }"
          >
            <button @click="!isEditMode && toggleItem(category.id)" class="flex items-center gap-2 flex-1 text-left px-1.5 py-1.5">
              <div class="flex-none relative w-6 h-6 rounded-sm flex items-center justify-center text-size-small font-semibold" :style="{
                backgroundColor: category.color || '#E5E7EB',
                color: getTextColor(category.color)
              }">
                <span class="block group-hover/category:opacity-0 transition-opacity">{{ category.icon || category.name.charAt(0).toUpperCase() }}</span>
                
                <div class="opacity-0 group-hover/category:opacity-100 transition-opacity svg-icon flex-none w-4 h-4 transition-transform absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10"
                    :class="{ 'rotate-90': expandedItems.has(category.id) }" v-html="chevronRightThinIcon" />
              </div>

              <span class="font-medium">{{ category.name }}</span>
            </button>

            <!-- Hover actions: new document + options menu (hidden in edit mode, editors only) -->
            <div
              v-if="!isEditMode && canManageCategories"
              class="flex items-center gap-0.5 shrink-0 mr-2 opacity-0 group-hover/category:opacity-100 transition-opacity"
              :class="{ 'opacity-100': contextMenu?.category?.id === category.id }"
            >
              <a
                :href="spacePath(currentSpace?.slug, `/new?category=${category.slug}`)"
                class="p-1 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 rounded-sm transition-colors flex items-center"
                title="New document in this category"
                @click.stop
              >
                <div class="svg-icon w-3.5 h-3.5" v-html="plusSmallIcon" />
              </a>
              <button
                type="button"
                class="p-1 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200 rounded-sm transition-colors flex items-center"
                :class="{ 'text-neutral-900 bg-neutral-200': contextMenu?.category?.id === category.id }"
                title="Category options"
                aria-label="Category options"
                @click.stop="handleMenuButton($event, category)"
              >
                <div class="svg-icon w-3.5 h-3.5" v-html="dotsVerticalIcon" />
              </button>
            </div>

            <!-- Drag handle (shown in rearrange mode) -->
            <div v-if="isEditMode" class="flex items-center shrink-0 pr-2 text-neutral-400" title="Drag to reorder">
              <div class="svg-icon w-4 h-4" v-html="dragDotsIcon" />
            </div>
          </div>
        </category-target>

        <div v-show="expandedItems.has(category.id) && !isEditMode" class="space-y-1 pt-1 pb-1.5">
          <DocumentTreeItem v-for="doc in category.rootDocs" :key="doc.id" :doc="doc" :all-docs="category.docs"
            :active-doc-id="activeDocSlug" :expanded-items="expandedItems" @toggle="toggleItem" />
        </div>
      </div>

      <!-- Add Category Button (shown in edit mode) -->
      <button
        v-if="isEditMode"
        @click="startCreating"
        class="w-full flex items-center gap-3 px-3 py-2 text-size-medium text-neutral-900 hover:text-neutral hover:bg-neutral-100 rounded-md transition-colors duration-200 mt-2"
      >
        <div class="svg-icon w-4 h-4 shrink-0" v-html="plusSmallIcon" />
        <span>Add category</span>
      </button>
    </div>

    <!-- Category Context Menu (right-click on desktop, long-press on touch) -->
    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="fixed inset-0 z-50"
        @click="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      >
        <div
          class="absolute min-w-[224px] bg-background border border-neutral-100 rounded-lg p-5xs shadow-large"
          :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
          @click.stop
          @contextmenu.prevent.stop
        >
          <div class="px-3xs py-5xs text-size-small text-neutral-500 truncate">{{ contextMenu.category.name }}</div>

          <button
            type="button"
            @click="contextNewDocument(contextMenu.category)"
            class="flex items-center gap-2.5 px-3xs py-5xs w-full text-left text-size-medium text-neutral-900 rounded-md transition-colors hover:bg-primary-50 active:bg-primary-100"
          >
            <div class="svg-icon w-4 h-4 flex-none" v-html="documentIcon" />
            <span>New document</span>
          </button>
          <button
            type="button"
            @click="contextEditCategory(contextMenu.category)"
            class="flex items-center gap-2.5 px-3xs py-5xs w-full text-left text-size-medium text-neutral-900 rounded-md transition-colors hover:bg-primary-50 active:bg-primary-100"
          >
            <div class="svg-icon w-4 h-4 flex-none" v-html="editOutlineIcon" />
            <span>Edit category</span>
          </button>

          <div class="my-5xs h-px bg-neutral-100" />

          <button
            type="button"
            @click="contextNewCategory()"
            class="flex items-center gap-2.5 px-3xs py-5xs w-full text-left text-size-medium text-neutral-900 rounded-md transition-colors hover:bg-primary-50 active:bg-primary-100"
          >
            <div class="svg-icon w-4 h-4 flex-none" v-html="plusIcon" />
            <span>New category</span>
          </button>
          <button
            type="button"
            @click="contextRearrange()"
            class="flex items-center gap-2.5 px-3xs py-5xs w-full text-left text-size-medium text-neutral-900 rounded-md transition-colors hover:bg-primary-50 active:bg-primary-100"
          >
            <div class="svg-icon w-4 h-4 flex-none" v-html="dragDotsIcon" />
            <span>Rearrange categories</span>
          </button>

          <div class="my-5xs h-px bg-neutral-100" />

          <button
            type="button"
            @click="contextDeleteCategory(contextMenu.category)"
            :disabled="deletingIds.has(contextMenu.category.id)"
            class="flex items-center gap-2.5 px-3xs py-5xs w-full text-left text-size-medium text-red-600 rounded-md transition-colors hover:bg-red-50 active:bg-red-100 disabled:opacity-50"
          >
            <div class="svg-icon w-4 h-4 flex-none" v-html="trashCanIcon" />
            <span>Delete category</span>
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Create/Edit Category Dialog -->
    <Dialog
      :show="showAddForm || !!editingId"
      :title="editingId ? 'Edit Category' : 'New Category'"
      :close-on-backdrop="!isSaving"
      @update:show="(v) => { if (!v) cancelEdit(); }"
    >
      <form id="category-form" @submit.prevent="handleSave" class="space-y-4">
        <div>
          <label class="block text-size-small font-medium text-neutral-900 mb-1">Name</label>
          <input
            v-model="formData.name"
            type="text"
            required
            class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Category name"
          />
        </div>

        <div>
          <label class="block text-size-small font-medium text-neutral-900 mb-1">Slug</label>
          <input
            v-model="formData.slug"
            type="text"
            required
            pattern="[a-z0-9-]+"
            class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="slug-name"
          />
          <p class="mt-1 text-size-small text-neutral">Lowercase, numbers, hyphens only</p>
        </div>

        <div>
          <label class="block text-size-small font-medium text-neutral-900 mb-1">Description</label>
          <textarea
            v-model="formData.description"
            rows="2"
            class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Description (optional)"
          />
        </div>

        <div>
          <label class="block text-size-small font-medium text-neutral-900 mb-2">Color</label>
          <div class="flex gap-2 items-center">
            <input
              v-model="formData.color"
              type="color"
              class="h-8 w-16 border border-neutral-100 rounded-sm cursor-pointer"
            />
            <input
              v-model="formData.color"
              type="text"
              placeholder="#4ECDC4"
              pattern="^#[0-9A-Fa-f]{6}$"
              class="flex-1 px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label class="block text-size-small font-medium text-neutral-900 mb-1">Icon</label>
          <input
            v-model="formData.icon"
            type="text"
            maxlength="10"
            class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Icon (emoji or text)"
          />
        </div>

        <div v-if="formError" class="p-3 bg-red-50 border border-red-200 rounded-md">
          <p class="text-size-small text-red-600">{{ formError }}</p>
        </div>
      </form>

      <template #footer>
        <div class="flex gap-2">
          <button
            type="button"
            @click="cancelEdit"
            :disabled="isSaving"
            class="flex-1 px-4 py-2 text-size-medium font-medium text-neutral-900 bg-background border border-neutral-100 rounded-md hover:bg-neutral-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="category-form"
            :disabled="isSaving"
            class="flex-1 px-4 py-2 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ isSaving ? 'Saving...' : (editingId ? 'Update' : 'Create') }}
          </button>
        </div>
      </template>
    </Dialog>

    <!-- Delete Category Confirmation -->
    <Dialog
      :show="!!deleteTarget"
      title="Delete category"
      :close-on-backdrop="!isDeleting"
      @update:show="(v) => { if (!v) cancelDelete(); }"
    >
      <p class="text-size-medium text-neutral-700">
        Delete <span class="font-semibold text-neutral-900">"{{ deleteTarget?.name }}"</span>?
        Documents in this category will not be deleted.
      </p>

      <div v-if="deleteError" class="mt-3 p-3 bg-red-50 border border-red-200 rounded-md">
        <p class="text-size-small text-red-600">{{ deleteError }}</p>
      </div>

      <template #footer>
        <div class="flex gap-2">
          <button
            type="button"
            @click="cancelDelete"
            :disabled="isDeleting"
            class="flex-1 px-4 py-2 text-size-medium font-medium text-neutral-900 bg-background border border-neutral-100 rounded-md hover:bg-neutral-100 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            @click="confirmDelete"
            :disabled="isDeleting"
            class="flex-1 px-4 py-2 text-size-medium font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {{ isDeleting ? 'Deleting...' : 'Delete' }}
          </button>
        </div>
      </template>
    </Dialog>
    </template>
  </div>
</template>
