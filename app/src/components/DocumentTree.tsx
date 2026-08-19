import "@atrium-ui/elements/expandable";
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
import { twMerge } from "tailwind-merge";
import { canEdit } from "#acl/permissions.ts";
import type { Category, DocumentWithProperties } from "#api/client.ts";
import { api } from "#api/client.ts";
import { useCategories } from "#composeables/useCategories.ts";
import { useCategoryDocuments } from "#composeables/useCategoryDocuments.ts";
import { usePersistedState } from "#composeables/usePersistedState.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { propertyValueIncludes, propertyValueToText } from "#documents/properties.ts";
import { documentTitle } from "#documents/title.ts";
import { currentLang, t } from "#utils/lang.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { slugify } from "#utils/slug.ts";
import { spacePath } from "#utils/utils.ts";
import { CategoryBadge } from "./CategoryBadge.tsx";
import { Dialog } from "./Dialog.tsx";
import { DocumentTreeItem } from "./DocumentTreeItem.tsx";
import { Icon } from "./Icon.tsx";

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

const EXPANDED_ITEMS_CODEC = {
  parse: (raw: string) => new Set<string>(JSON.parse(raw)),
  serialize: (items: Set<string>) => JSON.stringify([...items]),
};

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

  const [isMounted, setIsMounted] = createSignal(false);
  const {
    value: expandedItems,
    commit: commitExpandedItems,
    set: setExpandedItems,
    restore: restoreExpandedItems,
  } = usePersistedState<Set<string>>({
    key: "wiki-expanded-items",
    fallback: new Set(),
    ...EXPANDED_ITEMS_CODEC,
  });

  const expandedCategorySlugs = createMemo(() =>
    categories()
      .filter((cat) => expandedItems().has(cat.id))
      .map((cat) => cat.slug),
  );

  const { documentsBySlug, isSlugLoading } = useCategoryDocuments(expandedCategorySlugs);

  const documentTitleCollator = new Intl.Collator(currentLang(), {
    numeric: true,
    sensitivity: "base",
  });

  function categoryDocuments(category: Category) {
    const docs = [...(documentsBySlug().get(category.slug) || [])].sort((left, right) =>
      documentTitleCollator.compare(documentTitle(left), documentTitle(right)),
    );

    const rootDocs = docs.filter((doc) => {
      const docCategory = doc.properties?.category;
      const docCollection = doc.properties?.collection;

      if (
        (docCategory || docCollection) &&
        !propertyValueIncludes(docCategory, category.slug) &&
        !propertyValueIncludes(docCollection, category.slug)
      ) {
        return false;
      }

      if (!doc.parentId) return true;

      const parent = docs.find((d) => d.id === doc.parentId);
      return !parent;
    });

    return { docs, rootDocs };
  }

  const [isEditMode, setIsEditMode] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [dragOverIndex, setDragOverIndex] = createSignal<number | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [deletingIds, setDeletingIds] = createSignal(new Set<string>());
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
    categoryPopoverTrigger?.show?.();
  }

  function closeContextMenu() {
    categoryPopoverTrigger?.hide?.();
    setContextMenu(null);
  }

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
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) clearLongPress();
  }

  function handleTouchEnd(event: TouchEvent) {
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
      setExpandedItems(new Set<string>());
    } else {
      restoreExpandedItems();
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
    if (isSaving()) return;
    resetForm();
  }

  async function handleSave() {
    if (!currentSpace()) return;

    setIsSaving(true);
    setFormError(null);

    const form = formData();
    const name = form.name.trim();
    try {
      if (editingId()) {
        await updateCategory(
          editingId() as string,
          name,
          form.slug.trim(),
          form.description?.trim() || undefined,
          form.color || undefined,
          form.icon?.trim() || undefined,
        );
      } else {
        await createCategory(
          name,
          slugify(name),
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

  const isCategoryOpen = (category: Category) =>
    expandedItems().has(category.id) && !isEditMode();

  function toggleItem(itemId: string) {
    const next = new Set(expandedItems());
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    commitExpandedItems(next);
  }

  async function handleDocumentParentChange(event: Event) {
    const { documentId, newParentId } = (event as CustomEvent).detail;

    const space = currentSpace();
    if (!space) throw new Error(t("No space selected"));

    try {
      await api.document.patch(space.id, documentId, { parentId: newParentId });

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

    const targetCategory = categories().find((c) => c.id === newCategoryId);
    if (!targetCategory) throw new Error(t("Target category not found"));

    await api.document.patch(space.id, documentId, { parentId: null });

    await api.document.patch(space.id, documentId, {
      properties: { category: { value: targetCategory.slug } },
    });
  }

  createEffect(() => {
    if (!canManageCategories()) return;
    registerScopedAction("category:create", {
      title: t("Create Category"),
      description: t("Group documents into a new category"),
      run: async () => startCreating(),
    });
  });

  onMount(() => {
    setIsMounted(true);

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
                <Icon class="h-6 w-6 text-neutral-400" name="category" />
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
                  <Icon class="h-4 w-4" name="add" />
                  <span>{t("Create category")}</span>
                </button>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={!isLoading()}>
          <div class="space-y-1 px-4xs">
            <Index each={categories()}>
              {(category) => {
                const documents = createMemo(
                  (prev: ReturnType<typeof categoryDocuments>) => {
                    const next = categoryDocuments(category());
                    const isClosing =
                      next.docs.length === 0 && !isCategoryOpen(category());
                    return isClosing ? prev : next;
                  },
                  { docs: [], rootDocs: [] } as ReturnType<typeof categoryDocuments>,
                );

                const isEmpty = createMemo(
                  () =>
                    expandedItems().has(category().id) &&
                    !isSlugLoading(category().slug) &&
                    documents().rootDocs.length === 0,
                );

                return (
                  <div>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: the drag, long-press and context-menu gestures live on the row; the button inside is the control. */}
                    <category-target
                      attr:data-category-id={category().id}
                      attr:data-space-id={currentSpace()?.id}
                      class="block [&[data-drag-over]]:bg-neutral-100"
                      draggable={isEditMode()}
                      onDragStart={(e) => isEditMode() && handleDragStart(e, category())}
                      onDragOver={(e) =>
                        isEditMode() && handleDragOver(e, categoryIndex(category().id))
                      }
                      onDragLeave={() => isEditMode() && setDragOverIndex(null)}
                      onDrop={(e) =>
                        isEditMode() && void handleDrop(e, categoryIndex(category().id))
                      }
                      onTouchStart={(e) => handleTouchStart(e, category())}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
                      onTouchCancel={clearLongPress}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openContextMenu(e.clientX, e.clientY, category());
                      }}
                    >
                      <div
                        class="group/category flex items-center gap-2 rounded-md text-neutral-900 text-size-normal hover:bg-neutral-100 active:bg-neutral-200"
                        classList={{
                          "border border-blue-300 bg-blue-50":
                            dragOverIndex() === categoryIndex(category().id) &&
                            isEditMode(),
                          "cursor-move": isEditMode(),
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => !isEditMode() && toggleItem(category().id)}
                          class="flex flex-1 items-center gap-2 px-1 py-1 text-left"
                          aria-expanded={isCategoryOpen(category())}
                        >
                          <CategoryBadge category={category()} class="h-6 w-6">
                            <Icon
                              class={twMerge(
                                "absolute top-1/2 left-1/2 z-10 h-4 w-4 flex-none -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity transition-transform group-hover/category:opacity-100",
                                expandedItems().has(category().id) && "rotate-90",
                              )}
                              name="chevron-right-thin"
                            />
                          </CategoryBadge>

                          <span class="font-medium">{category().name}</span>
                        </button>

                        <Show when={!isEditMode() && canManageCategories()}>
                          <div
                            class="mr-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/category:opacity-100 group-hover/category:opacity-100"
                            classList={{
                              "opacity-100":
                                contextMenu()?.category?.id === category().id,
                            }}
                          >
                            <a
                              href={spacePath(
                                currentSpace()?.slug,
                                `/new?category=${category().slug}`,
                              )}
                              class="flex items-center rounded-sm p-1 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
                              title={t("New document in this category")}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Icon class="h-3.5 w-3.5" name="add" />
                              <span class="sr-only">
                                {t("New document in this category")}
                              </span>
                            </a>
                            <button
                              type="button"
                              class="flex items-center rounded-sm p-1 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
                              classList={{
                                "bg-neutral-200 text-neutral-900":
                                  contextMenu()?.category?.id === category().id,
                              }}
                              title={t("Category options")}
                              aria-label={t("Category options")}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMenuButton(e, category());
                              }}
                            >
                              <Icon class="h-3.5 w-3.5" name="context-menu-more" />
                            </button>
                          </div>
                        </Show>

                        <Show when={isEditMode()}>
                          <div
                            class="flex shrink-0 items-center pr-2 text-neutral-400"
                            title={t("Drag to reorder")}
                          >
                            <Icon class="h-4 w-4" name="drag-dots" />
                          </div>
                        </Show>
                      </div>
                    </category-target>

                    <a-expandable
                      attr:opened={isCategoryOpen(category()) ? "" : undefined}
                      class="[--transition-speed:100ms]"
                    >
                      <div class="space-y-1 pt-1 pb-1.5">
                        <Show
                          when={
                            expandedItems().has(category().id) &&
                            isSlugLoading(category().slug)
                          }
                        >
                          <Index each={["55%", "72%", "44%"]}>
                            {(width) => (
                              <div class="flex items-center gap-1 pl-[0.535rem]">
                                <div class="w-4 flex-none" />
                                <div
                                  class="mx-1.5 my-1 h-4 animate-pulse rounded-sm bg-neutral-200"
                                  style={{ width: width() }}
                                />
                              </div>
                            )}
                          </Index>
                        </Show>

                        <For each={documents().rootDocs}>
                          {(doc) => (
                            <DocumentTreeItem
                              doc={doc}
                              allDocs={documents().docs}
                              activeDocId={activeDocSlug()}
                              expandedItems={expandedItems()}
                              onToggle={toggleItem}
                            />
                          )}
                        </For>

                        <Show when={isEmpty()}>
                          <div class="pl-[0.535rem]">
                            <Show
                              when={canManageCategories()}
                              fallback={
                                <p class="px-1.5 py-1 text-neutral-500 text-size-normal">
                                  {t("No documents yet.")}
                                </p>
                              }
                            >
                              <a
                                href={spacePath(
                                  currentSpace()?.slug,
                                  `/new?category=${category().slug}`,
                                )}
                                class="flex items-center gap-1.5 rounded-md border border-neutral-300 border-dashed px-2 py-1.5 text-neutral-500 text-size-normal transition-colors hover:border-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
                              >
                                <Icon class="h-3.5 w-3.5 flex-none" name="add" />
                                <span>{t("New document")}</span>
                              </a>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </a-expandable>
                  </div>
                );
              }}
            </Index>

            <Show when={isEditMode()}>
              <button
                type="button"
                onClick={startCreating}
                class="mt-2 flex w-full items-center gap-3 rounded-md px-3 py-2 text-neutral-900 text-size-medium transition-colors duration-200 hover:bg-neutral-100 hover:text-neutral"
              >
                <Icon class="h-4 w-4 shrink-0" name="add" />
                <span>{t("Add category")}</span>
              </button>
            </Show>
          </div>
        </Show>

        <a-popover-trigger
          ref={categoryPopoverTrigger as never}
          class="fixed z-50 h-px w-px"
          style={{
            left: `${contextMenu()?.x ?? -10000}px`,
            top: `${contextMenu()?.y ?? -10000}px`,
          }}
          on:hide={() => setContextMenu(null)}
        >
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
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                    >
                      <Icon class="h-4 w-4 flex-none" name="document" />
                      <span>{t("New document")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const category = menu().category;
                        closeContextMenu();
                        startEditing(category);
                      }}
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                    >
                      <Icon class="h-4 w-4 flex-none" name="edit-entry" />
                      <span>{t("Edit category")}</span>
                    </button>

                    <div class="my-5xs h-px bg-neutral-100" />

                    <button
                      type="button"
                      onClick={() => {
                        closeContextMenu();
                        startCreating();
                      }}
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                    >
                      <Icon class="h-4 w-4 flex-none" name="add" />
                      <span>{t("New category")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeContextMenu();
                        if (!isEditMode()) toggleEditMode();
                      }}
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-neutral-900 text-size-normal transition-colors hover:bg-primary-50 active:bg-primary-100"
                    >
                      <Icon class="h-4 w-4 flex-none" name="drag-dots" />
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
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs text-left text-red-600 text-size-normal transition-colors hover:bg-red-500 hover:text-white active:bg-red-500 disabled:opacity-50"
                    >
                      <Icon class="h-4 w-4 flex-none" name="delete-entry" />
                      <span>{t("Delete category")}</span>
                    </button>
                  </div>
                )}
              </Show>
            </div>
          </a-popover>
        </a-popover-trigger>

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
                class="flex-1 rounded-md border border-neutral-100 bg-background px-4 py-2 font-medium text-neutral-900 text-size-medium transition-colors hover:bg-neutral-100 disabled:opacity-50"
              >
                {t("Cancel")}
              </button>
              <button
                type="submit"
                form="category-form"
                disabled={isSaving()}
                class="flex-1 rounded-md bg-blue-600 px-4 py-2 font-medium text-size-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
                placeholder={t("Category name")}
              />
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
                class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
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
                class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium"
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
                class="flex-1 rounded-md border border-neutral-100 bg-background px-4 py-2 font-medium text-neutral-900 text-size-medium transition-colors hover:bg-neutral-100 disabled:opacity-50"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={isDeleting()}
                class="flex-1 rounded-md bg-red-600 px-4 py-2 font-medium text-size-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
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
