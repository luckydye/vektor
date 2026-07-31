import "@atrium-ui/elements/popover";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { Category, DocumentWithProperties } from "#api/client.ts";
import { api } from "#api/client.ts";
import {
  addIcon,
  categoryIcon,
  chevronRightThinIcon,
  contextMenuMoreIcon,
  deleteEntryIcon,
  documentIcon,
  dragDotsIcon,
  editEntryIcon,
} from "#assets/icons.ts";
import { useCategories } from "#composeables/useCategories.solid.ts";
import { useCategoryDocuments } from "#composeables/useCategoryDocuments.solid.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useRoute } from "#composeables/useRoute.solid.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { useToast } from "#composeables/useToast.solid.ts";
import { propertyValueIncludes, propertyValueToText } from "#documents/properties.ts";
import { getTextColor } from "#utils/color.ts";
import { currentLang, t } from "#utils/lang.ts";
import { spacePath } from "#utils/utils.ts";
import { Dialog } from "./Dialog.tsx";
import { DocumentTreeItem } from "./DocumentTreeItem.tsx";

/**
 * Vue's `defineExpose`, as a callback prop (plan §10).
 *
 * `isEditMode` is a getter so a parent reads it as a value, the way Vue's
 * exposed proxy unwrapped the ref. It stays reactive: the getter reads the
 * signal when the parent reads the property.
 */
export interface DocumentTreeHandle {
  readonly isEditMode: boolean;
  toggleEditMode: () => void;
}

interface Props {
  ref?: (handle: DocumentTreeHandle) => void;
}

type PopoverTriggerEl = HTMLElement & { show?: () => void; hide?: () => void };

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE = 10;

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100";
const FIELD_CLASS =
  "w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium focus-ring";
const DIALOG_BUTTON_CLASS =
  "flex-1 rounded-md px-4 py-2 font-medium text-size-medium transition-colors disabled:opacity-50";

// Load expanded items (categories and documents) from localStorage
function loadExpandedItems(): Set<string> {
  if (typeof window === "undefined") return new Set();

  const stored = localStorage.getItem("wiki-expanded-items");
  if (!stored) return new Set();
  try {
    return new Set(JSON.parse(stored));
  } catch {
    return new Set();
  }
}

function saveExpandedItems(items: Set<string>) {
  if (typeof window === "undefined") return;
  localStorage.setItem("wiki-expanded-items", JSON.stringify([...items]));
}

function documentTitle(doc: DocumentWithProperties): string {
  const title = doc.properties?.title;
  return title ? propertyValueToText(title) : t("Untitled");
}

export function DocumentTree(props: Props) {
  const { currentSpace } = useSpace();
  const { documentSlug: activeDocSlug } = useRoute();
  const toast = useToast();
  const {
    categories,
    hasHiddenCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    reorderCategories,
    isLoading,
  } = useCategories();

  // Defer reading client-only state (localStorage, cached query data) until
  // after hydration so server and client render the same initial markup.
  const [isMounted, setIsMounted] = createSignal(false);
  const [expandedItems, setExpandedItems] = createSignal(new Set<string>());

  const expandedCategorySlugs = createMemo(() =>
    categories()
      .filter((cat) => expandedItems().has(cat.id))
      .map((cat) => cat.slug),
  );

  const { documentsBySlug } = useCategoryDocuments(expandedCategorySlugs);

  const documentTitleCollator = new Intl.Collator(currentLang(), {
    numeric: true,
    sensitivity: "base",
  });

  const categoriesWithDocs = createMemo(() =>
    categories().map((category) => {
      const categoryDocs = [...(documentsBySlug().get(category.slug) || [])].sort(
        (left, right) =>
          documentTitleCollator.compare(documentTitle(left), documentTitle(right)),
      );

      // Root docs are docs that belong to this category and whose parent is not
      // in this category's doc list (so they can't be rendered as a nested child).
      const rootDocs = categoryDocs.filter((doc) => {
        const docCategory = doc.properties?.category;
        const docCollection = doc.properties?.collection;

        // A doc with an explicit different category belongs only to that
        // category's tree, never as a root (or child) here — it was included
        // only for descendant traversal.
        if (
          (docCategory || docCollection) &&
          !propertyValueIncludes(docCategory, category.slug) &&
          !propertyValueIncludes(docCollection, category.slug)
        ) {
          return false;
        }

        if (!doc.parentId) return true;

        const parent = categoryDocs.find((d) => d.id === doc.parentId);
        // If parent is in this category's docs, this doc renders as a child there.
        return !parent;
      });

      return { ...category, docs: categoryDocs, rootDocs };
    }),
  );

  // Category edit mode state
  const [isEditMode, setIsEditMode] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [deletingIds, setDeletingIds] = createSignal(new Set<string>());
  // Category pending deletion (drives the confirmation dialog).
  const [deleteTarget, setDeleteTarget] = createSignal<Category | null>(null);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const isDeleting = createMemo(() => {
    const target = deleteTarget();
    return !!target && deletingIds().has(target.id);
  });
  let draggedCategory: Category | null = null;

  const [formData, setFormData] = createSignal({
    name: "",
    slug: "",
    description: "",
    color: "#4ECDC4",
    icon: "",
  });
  const patchForm = (patch: Partial<ReturnType<typeof formData>>) =>
    setFormData({ ...formData(), ...patch });

  // Context menu state (right-click on desktop, long-press on touch)
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    category: Category;
  } | null>(null);
  let categoryPopoverTrigger: PopoverTriggerEl | undefined;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStart: { x: number; y: number } | null = null;
  let longPressFired = false;

  const canManageCategories = createMemo(() => canEdit(currentSpace()?.userRole));

  function openContextMenu(clientX: number, clientY: number, category: Category) {
    if (!canManageCategories() || isEditMode()) return;

    setContextMenu({ x: clientX, y: clientY, category });
    // The trigger has already moved to the new position — Solid applies the
    // signal write synchronously — so the popover opens where it belongs.
    categoryPopoverTrigger?.show?.();
  }

  function closeContextMenu() {
    categoryPopoverTrigger?.hide?.();
    setContextMenu(null);
  }

  // Open the menu beside the hover "⋯" button with both top edges aligned.
  function handleMenuButton(event: MouseEvent, category: Category) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu(rect.right + 4, rect.top, category);
  }

  function clearLongPress() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  function handleTouchStart(event: TouchEvent, category: Category) {
    if (!canManageCategories() || isEditMode()) return;
    const touch = event.touches[0];
    if (!touch) return;
    longPressFired = false;
    longPressStart = { x: touch.clientX, y: touch.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressFired = true;
      if (longPressStart) {
        openContextMenu(longPressStart.x, longPressStart.y, category);
      }
    }, LONG_PRESS_MS);
  }

  function handleTouchMove(event: TouchEvent) {
    if (longPressTimer === null || !longPressStart) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - longPressStart.x;
    const dy = touch.clientY - longPressStart.y;
    // Cancel the long-press if the finger moves (i.e. the user is scrolling).
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) clearLongPress();
  }

  function handleTouchEnd(event: TouchEvent) {
    // If the long-press just opened the menu, swallow the trailing synthetic
    // click so it doesn't fall through to the backdrop and close the menu.
    if (longPressFired) {
      event.preventDefault();
      longPressFired = false;
    }
    clearLongPress();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && contextMenu()) closeContextMenu();
  }

  function resetForm() {
    setFormData({ name: "", slug: "", description: "", color: "#4ECDC4", icon: "" });
    setFormError(null);
    setEditingId(null);
    setShowAddForm(false);
  }

  function toggleEditMode() {
    setIsEditMode(!isEditMode());
    if (isEditMode()) {
      // Collapse without saving — localStorage still holds the real state
      setExpandedItems(new Set<string>());
    } else {
      // Restore from localStorage
      setExpandedItems(loadExpandedItems());
      resetForm();
    }
  }

  function startEditing(category: Category) {
    setEditingId(category.id);
    setFormData({
      name: category.name,
      slug: category.slug,
      description: category.description || "",
      color: category.color || "#4ECDC4",
      icon: category.icon || "",
    });
    setFormError(null);
  }

  function startCreating() {
    resetForm();
    setShowAddForm(true);
  }

  function cancelEdit() {
    // Don't discard the form (and reset state) out from under an in-flight save.
    if (isSaving()) return;
    resetForm();
  }

  async function handleSave() {
    if (!currentSpace()) return;

    setIsSaving(true);
    setFormError(null);

    const form = formData();
    try {
      if (editingId()) {
        await updateCategory(
          editingId() as string,
          form.name.trim(),
          form.slug.trim(),
          form.description?.trim() || undefined,
          form.color || undefined,
          form.icon?.trim() || undefined,
        );
      } else {
        await createCategory(
          form.name.trim(),
          form.slug.trim(),
          form.description?.trim() || undefined,
          form.color || undefined,
          form.icon?.trim() || undefined,
        );
      }

      resetForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("Failed to save category"));
    } finally {
      setIsSaving(false);
    }
  }

  function handleDragStart(e: DragEvent, category: Category) {
    draggedCategory = category;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  }

  async function handleDrop(e: DragEvent, index: number) {
    e.preventDefault();
    setDragOverIndex(null);

    if (!draggedCategory) return;

    const newOrder = categories().map((c) => c.id);
    const draggedIndex = newOrder.indexOf(draggedCategory.id);

    if (draggedIndex === index) {
      draggedCategory = null;
      return;
    }

    newOrder.splice(draggedIndex, 1);
    newOrder.splice(index, 0, draggedCategory.id);

    try {
      await reorderCategories(newOrder);
    } catch {
      setFormError(t("Failed to reorder categories"));
    } finally {
      draggedCategory = null;
    }
  }

  function requestDelete(category: Category) {
    setDeleteError(null);
    setDeleteTarget(category);
  }

  function cancelDelete() {
    if (isDeleting()) return;
    setDeleteError(null);
    setDeleteTarget(null);
  }

  async function confirmDelete() {
    const category = deleteTarget();
    if (!category) return;

    setDeleteError(null);
    setDeletingIds(new Set(deletingIds()).add(category.id));

    try {
      await deleteCategory(category.id);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("Failed to delete category"));
    } finally {
      const next = new Set(deletingIds());
      next.delete(category.id);
      setDeletingIds(next);
    }
  }

  function toggleItem(itemId: string) {
    const next = new Set(expandedItems());
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    setExpandedItems(next);
    saveExpandedItems(next);
  }

  async function handleDocumentParentChange(event: Event) {
    const { documentId, newParentId } = (event as CustomEvent).detail;

    const space = currentSpace();
    if (!space) throw new Error(t("No space selected"));

    try {
      await api.document.patch(space.id, documentId, { parentId: newParentId });

      // Then, update the category property
      await api.document.patch(space.id, documentId, {
        properties: { category: null },
      });
    } catch (error) {
      if (error instanceof Error) toast.error(t(error.message));
    }
  }

  async function handleDocumentCategoryChange(event: Event) {
    const { documentId, newCategoryId } = (event as CustomEvent).detail;

    const space = currentSpace();
    if (!space) throw new Error(t("No space selected"));

    // Find the category to get its slug
    const targetCategory = categories().find((c) => c.id === newCategoryId);
    if (!targetCategory) throw new Error(t("Target category not found"));

    // First, clear the parentId
    await api.document.patch(space.id, documentId, { parentId: null });

    // Then, update the category property
    await api.document.patch(space.id, documentId, {
      properties: { category: { value: targetCategory.slug } },
    });
  }

  onMount(() => {
    setIsMounted(true);
    setExpandedItems(loadExpandedItems());

    window.addEventListener("document-parent-change", handleDocumentParentChange);
    window.addEventListener("document-category-change", handleDocumentCategoryChange);
    window.addEventListener("keydown", handleKeydown);

    onCleanup(() => {
      window.removeEventListener("document-parent-change", handleDocumentParentChange);
      window.removeEventListener(
        "document-category-change",
        handleDocumentCategoryChange,
      );
      window.removeEventListener("keydown", handleKeydown);
      clearLongPress();
    });
  });

  props.ref?.({
    get isEditMode() {
      return isEditMode();
    },
    toggleEditMode,
  });

  const categoryIndex = (id: string) => categories().findIndex((c) => c.id === id);

  return (
    <div class="document-tree">
      <Show when={!isMounted() || isLoading()}>
        <div class="hidden flex-col space-y-1 px-5xs md:flex">
          {/* Category skeleton */}
          <Index each={[0, 1, 2]}>
            {() => (
              <div class="space-y-1">
                <div class="flex items-center gap-2 rounded-md p-2">
                  <div class="h-6 w-6 flex-none animate-pulse rounded-sm bg-neutral-200" />
                  <div class="h-4 w-24 animate-pulse rounded-sm bg-neutral-200" />
                </div>
                <div class="space-y-1 pl-3">
                  <Index each={[0, 1]}>
                    {() => (
                      <div class="flex items-center gap-2 rounded-md p-2">
                        <div class="h-4 w-4 flex-none animate-pulse rounded-sm bg-neutral-200" />
                        <div class="h-3 w-32 flex-1 animate-pulse rounded-sm bg-neutral-200" />
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            )}
          </Index>
        </div>
      </Show>

      <Show when={isMounted()}>
        {/* Empty state */}
        <Show when={!isLoading() && !isEditMode() && categories().length === 0}>
          <div class="px-4xs">
            <Show
              when={canManageCategories()}
              fallback={
                <p class="px-3 py-4 text-center text-neutral-500 text-size-normal">
                  {hasHiddenCategories()
                    ? t("You don't have access to any categories in this space")
                    : t("No categories yet")}
                </p>
              }
            >
              <div class="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 border-dashed px-4 py-5 text-center">
                <div class="svg-icon h-6 w-6 text-neutral-400" innerHTML={categoryIcon} />
                <div>
                  <p class="font-medium text-neutral-900 text-size-normal">
                    {t("No categories yet")}
                  </p>
                  <p class="mt-0.5 text-neutral-500 text-size-extra-small">
                    {t("Group your documents into categories to organize this space.")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={startCreating}
                  class="mt-1 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 font-medium text-size-normal text-white transition-colors hover:bg-blue-700"
                >
                  <div class="svg-icon h-4 w-4" innerHTML={addIcon} />
                  <span>{t("Create category")}</span>
                </button>
              </div>
            </Show>
          </div>
        </Show>

        {/* Categories List and Documents */}
        <Show when={!isLoading()}>
          <div class="space-y-1 px-4xs">
            <For each={categoriesWithDocs()}>
              {(category) => (
                <div>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: the drag, long-press and context-menu gestures live on the row; the button inside is the control. */}
                  <category-target
                    data-category-id={category.id}
                    data-space-id={currentSpace()?.id}
                    class="block [&[data-drag-over]]:bg-neutral-100"
                    draggable={isEditMode()}
                    onDragStart={(e) => isEditMode() && handleDragStart(e, category)}
                    onDragOver={(e) =>
                      isEditMode() && handleDragOver(e, categoryIndex(category.id))
                    }
                    onDragLeave={() => isEditMode() && setDragOverIndex(null)}
                    onDrop={(e) =>
                      isEditMode() && void handleDrop(e, categoryIndex(category.id))
                    }
                    onTouchStart={(e) => handleTouchStart(e, category)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    onTouchCancel={clearLongPress}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openContextMenu(e.clientX, e.clientY, category);
                    }}
                  >
                    <div
                      class="group/category flex items-center gap-2 rounded-md text-neutral-900 text-size-normal hover:bg-neutral-100 active:bg-neutral-200"
                      classList={{
                        "border border-blue-300 bg-blue-50":
                          dragOverIndex() === categoryIndex(category.id) && isEditMode(),
                        "cursor-move": isEditMode(),
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => !isEditMode() && toggleItem(category.id)}
                        class="flex flex-1 items-center gap-2 px-1 py-1 text-left"
                      >
                        <div
                          class="relative flex h-6 w-6 flex-none items-center justify-center rounded-sm font-semibold text-size-extra-small"
                          style={{
                            "background-color": category.color || "#E5E7EB",
                            color: getTextColor(category.color),
                          }}
                        >
                          <span class="block transition-opacity group-hover/category:opacity-0">
                            {category.icon || category.name.charAt(0).toUpperCase()}
                          </span>

                          <div
                            class="svg-icon absolute top-1/2 left-1/2 z-10 h-4 w-4 flex-none -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity transition-transform group-hover/category:opacity-100"
                            classList={{ "rotate-90": expandedItems().has(category.id) }}
                            innerHTML={chevronRightThinIcon}
                          />
                        </div>

                        <span class="font-medium">{category.name}</span>
                      </button>

                      {/* Hover actions: new document + options menu */}
                      <Show when={!isEditMode() && canManageCategories()}>
                        <div
                          class="mr-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/category:opacity-100 group-hover/category:opacity-100"
                          classList={{
                            "opacity-100": contextMenu()?.category?.id === category.id,
                          }}
                        >
                          <a
                            href={spacePath(
                              currentSpace()?.slug,
                              `/new?category=${category.slug}`,
                            )}
                            class="flex items-center rounded-sm p-1 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
                            title={t("New document in this category")}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div
                              class="svg-icon h-3.5 w-3.5"
                              aria-hidden="true"
                              innerHTML={addIcon}
                            />
                            <span class="sr-only">
                              {t("New document in this category")}
                            </span>
                          </a>
                          <button
                            type="button"
                            class="flex items-center rounded-sm p-1 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
                            classList={{
                              "bg-neutral-200 text-neutral-900":
                                contextMenu()?.category?.id === category.id,
                            }}
                            title={t("Category options")}
                            aria-label={t("Category options")}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMenuButton(e, category);
                            }}
                          >
                            <div
                              class="svg-icon h-3.5 w-3.5"
                              innerHTML={contextMenuMoreIcon}
                            />
                          </button>
                        </div>
                      </Show>

                      {/* Drag handle (shown in rearrange mode) */}
                      <Show when={isEditMode()}>
                        <div
                          class="flex shrink-0 items-center pr-2 text-neutral-400"
                          title={t("Drag to reorder")}
                        >
                          <div class="svg-icon h-4 w-4" innerHTML={dragDotsIcon} />
                        </div>
                      </Show>
                    </div>
                  </category-target>

                  {/* `hidden`, not an unmount: collapsing must not tear down the
                      subtree's drop targets, which the drag layer holds on to. */}
                  <div
                    class="space-y-1 pt-1 pb-1.5"
                    hidden={!(expandedItems().has(category.id) && !isEditMode())}
                  >
                    <For each={category.rootDocs}>
                      {(doc) => (
                        <DocumentTreeItem
                          doc={doc}
                          allDocs={category.docs}
                          activeDocId={activeDocSlug()}
                          expandedItems={expandedItems()}
                          onToggle={toggleItem}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>

            {/* Add Category Button (shown in edit mode) */}
            <Show when={isEditMode()}>
              <button
                type="button"
                onClick={startCreating}
                class="mt-2 flex w-full items-center gap-3 rounded-md px-3 py-2 text-neutral-900 text-size-medium transition-colors duration-200 hover:bg-neutral-100 hover:text-neutral"
              >
                <div class="svg-icon h-4 w-4 shrink-0" innerHTML={addIcon} />
                <span>{t("Add category")}</span>
              </button>
            </Show>
          </div>
        </Show>

        {/* Category Context Menu (options button, right-click, or long-press) */}
        <a-popover-trigger
          ref={categoryPopoverTrigger as never}
          class="fixed z-50 h-px w-px"
          style={{
            left: `${contextMenu()?.x ?? -10000}px`,
            top: `${contextMenu()?.y ?? -10000}px`,
          }}
          on:hide={() => setContextMenu(null)}
        >
          {/* A zero-size anchor the popover positions against; it is opened
              programmatically and is never a target itself. */}
          <button
            slot="trigger"
            type="button"
            class="pointer-events-none block h-px w-px opacity-0"
            tabindex="-1"
          />

          <a-popover
            class="group"
            placements="right-start,left-start"
            on:exit={closeContextMenu}
          >
            <div class="category-context-menu w-max py-1 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
              <Show when={contextMenu()}>
                {(menu) => (
                  // biome-ignore lint/a11y/noStaticElementInteractions: suppressing the native context menu does not make the panel a control.
                  <div
                    class="category-context-panel min-w-[224px] origin-top-left scale-95 rounded-lg border border-neutral-100 bg-background p-5xs shadow-large transition-transform duration-150 group-[&[enabled]]:scale-100 [.category-context-menu[data-placement^='left']_&]:origin-top-right [.category-context-menu[data-placement^='right']_&]:origin-top-left"
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    <div class="truncate px-3xs py-5xs text-neutral-500 text-size-extra-small">
                      {menu().category.name}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        closeContextMenu();
                        window.location.href = spacePath(
                          currentSpace()?.slug,
                          `/new?category=${menu().category.slug}`,
                        );
                      }}
                      class={MENU_ITEM_CLASS}
                    >
                      <div class="svg-icon h-4 w-4 flex-none" innerHTML={documentIcon} />
                      <span>{t("New document")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const category = menu().category;
                        closeContextMenu();
                        startEditing(category);
                      }}
                      class={MENU_ITEM_CLASS}
                    >
                      <div class="svg-icon h-4 w-4 flex-none" innerHTML={editEntryIcon} />
                      <span>{t("Edit category")}</span>
                    </button>

                    <div class="my-5xs h-px bg-neutral-100" />

                    <button
                      type="button"
                      onClick={() => {
                        closeContextMenu();
                        startCreating();
                      }}
                      class={MENU_ITEM_CLASS}
                    >
                      <div class="svg-icon h-4 w-4 flex-none" innerHTML={addIcon} />
                      <span>{t("New category")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeContextMenu();
                        if (!isEditMode()) toggleEditMode();
                      }}
                      class={MENU_ITEM_CLASS}
                    >
                      <div class="svg-icon h-4 w-4 flex-none" innerHTML={dragDotsIcon} />
                      <span>{t("Rearrange categories")}</span>
                    </button>

                    <div class="my-5xs h-px bg-neutral-100" />

                    <button
                      type="button"
                      onClick={() => {
                        const category = menu().category;
                        closeContextMenu();
                        requestDelete(category);
                      }}
                      disabled={deletingIds().has(menu().category.id)}
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-red-600 text-size-normal transition-colors hover:bg-red-50 active:bg-red-100 disabled:opacity-50"
                    >
                      <div
                        class="svg-icon h-4 w-4 flex-none"
                        innerHTML={deleteEntryIcon}
                      />
                      <span>{t("Delete category")}</span>
                    </button>
                  </div>
                )}
              </Show>
            </div>
          </a-popover>
        </a-popover-trigger>

        {/* Create/Edit Category Dialog */}
        <Dialog
          show={showAddForm() || !!editingId()}
          title={editingId() ? t("Edit category") : t("New category")}
          closeOnBackdrop={!isSaving()}
          onUpdateShow={(v) => {
            if (!v) cancelEdit();
          }}
          footer={
            <div class="flex gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={isSaving()}
                class={`${DIALOG_BUTTON_CLASS} border border-neutral-100 bg-background text-neutral-900 hover:bg-neutral-100`}
              >
                {t("Cancel")}
              </button>
              <button
                type="submit"
                form="category-form"
                disabled={isSaving()}
                class={`${DIALOG_BUTTON_CLASS} bg-blue-600 text-white hover:bg-blue-700 disabled:cursor-not-allowed`}
              >
                {isSaving() ? t("Saving...") : editingId() ? t("Update") : t("Create")}
              </button>
            </div>
          }
        >
          <form
            id="category-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
            class="space-y-4"
          >
            <div>
              <label
                for="category-name"
                class="mb-1 block font-medium text-neutral-900 text-size-small"
              >
                {t("Name")}
              </label>
              <input
                id="category-name"
                value={formData().name}
                onInput={(e) => patchForm({ name: e.currentTarget.value })}
                type="text"
                required
                class={FIELD_CLASS}
                placeholder={t("Category name")}
              />
            </div>

            <div>
              <label
                for="category-slug"
                class="mb-1 block font-medium text-neutral-900 text-size-small"
              >
                {t("Slug")}
              </label>
              <input
                id="category-slug"
                value={formData().slug}
                onInput={(e) => patchForm({ slug: e.currentTarget.value })}
                type="text"
                required
                pattern="[a-z0-9-]+"
                class={FIELD_CLASS}
                placeholder="slug-name"
              />
              <p class="mt-1 text-neutral text-size-small">
                {t("Lowercase, numbers, hyphens only")}
              </p>
            </div>

            <div>
              <label
                for="category-description"
                class="mb-1 block font-medium text-neutral-900 text-size-small"
              >
                {t("Description")}
              </label>
              <textarea
                id="category-description"
                value={formData().description}
                onInput={(e) => patchForm({ description: e.currentTarget.value })}
                rows="2"
                class={FIELD_CLASS}
                placeholder={t("Description (optional)")}
              />
            </div>

            <div>
              <label
                for="category-color"
                class="mb-2 block font-medium text-neutral-900 text-size-small"
              >
                {t("Color")}
              </label>
              <div class="flex items-center gap-2">
                <input
                  id="category-color"
                  value={formData().color}
                  onInput={(e) => patchForm({ color: e.currentTarget.value })}
                  type="color"
                  class="h-8 w-16 cursor-pointer rounded-sm border border-neutral-100"
                />
                <input
                  value={formData().color}
                  onInput={(e) => patchForm({ color: e.currentTarget.value })}
                  type="text"
                  placeholder="#4ECDC4"
                  pattern="^#[0-9A-Fa-f]{6}$"
                  class="focus-ring flex-1 rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                />
              </div>
            </div>

            <div>
              <label
                for="category-icon"
                class="mb-1 block font-medium text-neutral-900 text-size-small"
              >
                {t("Icon")}
              </label>
              <input
                id="category-icon"
                value={formData().icon}
                onInput={(e) => patchForm({ icon: e.currentTarget.value })}
                type="text"
                maxlength="10"
                class={FIELD_CLASS}
                placeholder={t("Icon (emoji or text)")}
              />
            </div>

            <Show when={formError()}>
              <div class="rounded-md border border-red-200 bg-red-50 p-3">
                <p class="text-red-600 text-size-small">{formError()}</p>
              </div>
            </Show>
          </form>
        </Dialog>

        {/* Delete Category Confirmation */}
        <Dialog
          show={!!deleteTarget()}
          title={t("Delete category")}
          closeOnBackdrop={!isDeleting()}
          onUpdateShow={(v) => {
            if (!v) cancelDelete();
          }}
          footer={
            <div class="flex gap-2">
              <button
                type="button"
                onClick={cancelDelete}
                disabled={isDeleting()}
                class={`${DIALOG_BUTTON_CLASS} border border-neutral-100 bg-background text-neutral-900 hover:bg-neutral-100`}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={isDeleting()}
                class={`${DIALOG_BUTTON_CLASS} bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed`}
              >
                {isDeleting() ? t("Deleting...") : t("Delete")}
              </button>
            </div>
          }
        >
          <p class="text-neutral-700 text-size-medium">
            {t(
              'Delete "{name}"? Documents in this category will not be deleted.',
            ).replace("{name}", deleteTarget()?.name ?? "")}
          </p>

          <Show when={deleteError()}>
            <div class="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
              <p class="text-red-600 text-size-small">{deleteError()}</p>
            </div>
          </Show>
        </Dialog>
      </Show>
    </div>
  );
}
