<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Teleport } from "vue";
import { useCategories } from "../composeables/useCategories.ts";
import { useCategoryDocuments } from "../composeables/useCategoryDocuments.ts";
import { getTextColor } from "../utils/utils.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { api } from "../api/client.ts";
import DocumentTreeItem from "./DocumentTreeItem.vue";

const { currentSpace } = useSpace();
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

const expandedItems = ref(loadExpandedItems());

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

    // Root docs are:
    // 1. Docs with no parent
    // 2. Docs whose parent is not in this category's document list
    const rootDocs = categoryDocs.filter((doc) => {
      if (!doc.parentId) return true;

      const parent = categoryDocs.find((d) => d.id === doc.parentId);
      if (!parent) return true;

      // If the parent is in the same category, this doc is not a root
      // It will be rendered as a child by DocumentTreeItem
      const parentCategory = parent.properties?.category || parent.properties?.collection;
      const docCategory = doc.properties?.category || doc.properties?.collection;

      // If both have the same category (or both have no category), doc is not a root
      if (parentCategory === docCategory) {
        return false;
      }

      // If categories differ, this doc breaks away to be a root in its own category
      return true;
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

const formData = ref({
  name: "",
  slug: "",
  description: "",
  color: "#4ECDC4",
  icon: "",
});

function toggleEditMode() {
  isEditMode.value = !isEditMode.value;
  if (isEditMode.value) {
    // Collapse all categories when entering edit mode
    expandedItems.value.clear();
    saveExpandedItems(expandedItems.value);
  } else {
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

async function handleDelete(category) {
  if (!confirm(`Delete "${category.name}"? Documents will not be deleted.`)) return;

  deletingIds.value.add(category.id);

  try {
    await deleteCategory(category.id);
  } catch (err) {
    formError.value = err instanceof Error ? err.message : "Failed to delete category";
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

function getActiveDocSlug() {
  const currentPath = window.location.pathname;
  const spaceAwareMatch = currentPath.match(/^\/[^/]+\/doc\/([^/]+)$/);
  const legacyMatch = currentPath.match(/^\/doc\/([^/]+)$/);

  if (spaceAwareMatch) {
    return spaceAwareMatch[1];
  }
  if (legacyMatch) {
    return legacyMatch[1];
  }
  return null;
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
  await api.documentProperty.delete(currentSpace.value.id, documentId, "category");
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
  await api.documentProperty.put(currentSpace.value.id, documentId, {
    key: "category",
    value: targetCategory.slug,
  });
}

onMounted(() => {
  window.addEventListener("document-parent-change", handleDocumentParentChange);
  window.addEventListener("document-category-change", handleDocumentCategoryChange);
});

onUnmounted(() => {
  window.removeEventListener("document-parent-change", handleDocumentParentChange);
  window.removeEventListener("document-category-change", handleDocumentCategoryChange);
});
</script>

<template>
  <div class="document-tree">
    <!-- Categories Header with Edit Button -->
    <div class="flex items-center justify-between gap-3xs px-3xs mb-2">
      <h3 class="text-xs font-medium text-neutral-900 uppercase tracking-wider opacity-50">
        Categories
      </h3>
      <button
        @click="toggleEditMode"
        class="p-1 text-neutral-900 hover:text-neutral rounded transition-colors"
        :title="isEditMode ? 'Done editing' : 'Edit categories'"
      >
        <svg v-if="!isEditMode" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
      </button>
    </div>

    <div v-if="!isEditMode && categories.length === 0" class="px-3 py-4 text-center">
      <p class="text-sm text-neutral-500">No categories yet</p>
    </div>

    <!-- Categories List and Documents -->
    <div class="px-2 space-y-1">
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
        >
          <div class="flex items-center gap-2 text-sm text-neutral-900 hover:bg-neutral-100 active:bg-neutral-200 rounded-md"
            :class="{
              'bg-blue-50 border border-blue-300': dragOverIndex === categories.findIndex(c => c.id === category.id) && isEditMode,
              'cursor-move': isEditMode
            }"
          >
            <button @click="toggleItem(category.id)" class="flex items-center gap-2 flex-1 text-left px-1 py-2">
              <svg class="flex-none w-4 h-4 transition-transform"
                :class="{ 'rotate-90': expandedItems.has(category.id) }" fill="none" stroke="currentColor"
                viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>

              <div class="flex-none w-6 h-6 rounded flex items-center justify-center text-xs font-semibold" :style="{
                backgroundColor: category.color || '#E5E7EB',
                color: getTextColor(category.color)
              }">
                {{ category.icon || category.name.charAt(0).toUpperCase() }}
              </div>

              <span class="font-medium">{{ category.name }}</span>
            </button>

            <!-- Edit/Delete Buttons (shown in edit mode) -->
            <div v-if="isEditMode" class="flex items-center gap-1 shrink-0 pr-2">
              <button
                @click="startEditing(category)"
                class="p-1 text-neutral-900 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                title="Edit"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                @click="handleDelete(category)"
                :disabled="deletingIds.has(category.id)"
                class="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                title="Delete"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </category-target>

        <div v-if="expandedItems.has(category.id) && !isEditMode" class="pl-4 space-y-1">
          <DocumentTreeItem v-for="doc in category.rootDocs" :key="doc.id" :doc="doc" :all-docs="category.docs"
            :active-doc-id="getActiveDocSlug()" :expanded-items="expandedItems" @toggle="toggleItem" />
        </div>
      </div>

      <!-- Add Category Button (shown in edit mode) -->
      <button
        v-if="isEditMode"
        @click="startCreating"
        class="w-full flex items-center gap-3 px-3 py-2 text-sm text-neutral-900 hover:text-neutral hover:bg-neutral-100 rounded-md transition-colors duration-200 mt-2"
      >
        <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        <span>Add category</span>
      </button>
    </div>

    <!-- Create/Edit Dialog Overlay (Teleported to body) -->
    <Teleport to="body">
      <div v-if="showAddForm || editingId" class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div class="bg-background rounded-lg shadow-xl p-6 w-full max-w-md" @click.stop>
          <form @submit.prevent="handleSave" class="space-y-4">
            <div class="text-sm font-semibold text-neutral-900">
              {{ editingId ? 'Edit Category' : 'New Category' }}
            </div>

            <div>
              <label class="block text-xs font-medium text-neutral-900 mb-1">Name</label>
              <input
                v-model="formData.name"
                type="text"
                required
                class="w-full px-3 py-2 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Category name"
              />
            </div>

            <div>
              <label class="block text-xs font-medium text-neutral-900 mb-1">Slug</label>
              <input
                v-model="formData.slug"
                type="text"
                required
                pattern="[a-z0-9-]+"
                class="w-full px-3 py-2 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="slug-name"
              />
              <p class="mt-1 text-xs text-neutral">Lowercase, numbers, hyphens only</p>
            </div>

            <div>
              <label class="block text-xs font-medium text-neutral-900 mb-1">Description</label>
              <textarea
                v-model="formData.description"
                rows="2"
                class="w-full px-3 py-2 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Description (optional)"
              />
            </div>

            <div>
              <label class="block text-xs font-medium text-neutral-900 mb-2">Color</label>
              <div class="flex gap-2 items-center">
                <input
                  v-model="formData.color"
                  type="color"
                  class="h-8 w-16 border border-neutral-200 rounded cursor-pointer"
                />
                <input
                  v-model="formData.color"
                  type="text"
                  placeholder="#4ECDC4"
                  pattern="^#[0-9A-Fa-f]{6}$"
                  class="flex-1 px-3 py-2 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label class="block text-xs font-medium text-neutral-900 mb-1">Icon</label>
              <input
                v-model="formData.icon"
                type="text"
                maxlength="10"
                class="w-full px-3 py-2 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Icon (emoji or text)"
              />
            </div>

            <div v-if="formError" class="p-3 bg-red-50 border border-red-200 rounded-md">
              <p class="text-xs text-red-600">{{ formError }}</p>
            </div>

            <div class="flex gap-2 pt-2">
              <button
                type="button"
                @click="cancelEdit"
                :disabled="isSaving"
                class="flex-1 px-4 py-2 text-sm font-medium text-neutral-900 bg-background border border-neutral-200 rounded-md hover:bg-neutral-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                :disabled="isSaving"
                class="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {{ isSaving ? 'Saving...' : (editingId ? 'Update' : 'Create') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
</template>
