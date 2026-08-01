import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  Show,
} from "solid-js";
import "@atrium-ui/elements/tabs";
import type { Category, PermissionEntry, User } from "#api/client.ts";
import { api } from "#api/client.ts";
import { isOwner } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { Dialog } from "./Dialog.tsx";
import "./AvatarElement.ts";

interface Props {
  show: boolean;
  documentId: string;
  documentTitle?: string;
  onUpdateShow?: (value: boolean) => void;
}

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};

type Scope = "document" | "category" | "space";
type DocumentPermissionResource = "document" | "document_tree";

function roleBadgeClass(role: string) {
  const map: Record<string, string> = {
    owner: "bg-purple-100 text-purple-700",
    editor: "bg-primary-50 text-primary-700",
    viewer: "bg-neutral-100 text-neutral-600",
  };
  return map[role] ?? map.viewer;
}

export function DocumentShareDialog(props: Props) {
  const { currentSpaceId, currentSpace } = useSpace();
  const user = useUserProfile();

  let tabsEl: ATabsEl | undefined;

  const [scope, setScope] = createSignal<Scope>("document");
  const [includeChildPages, setIncludeChildPages] = createSignal(false);

  const [docPermissions, setDocPermissions] = createSignal<PermissionEntry[]>([]);
  const [categoryPermissions, setCategoryPermissions] = createSignal<PermissionEntry[]>(
    [],
  );
  const [spacePermissions, setSpacePermissions] = createSignal<PermissionEntry[]>([]);
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = createSignal("");
  const [usersMap, setUsersMap] = createSignal(new Map<string, User>());
  const [isLoading, setIsLoading] = createSignal(false);

  const [newMemberEmail, setNewMemberEmail] = createSignal("");
  const [newMemberRole, setNewMemberRole] = createSignal("viewer");
  const [addingMember, setAddingMember] = createSignal(false);
  const [addMemberError, setAddMemberError] = createSignal<string | null>(null);

  const userIsOwner = createMemo(() => isOwner(currentSpace()?.userRole));

  const roleOptions = createMemo(() =>
    userIsOwner()
      ? [
          { value: "viewer", label: "Viewer" },
          { value: "editor", label: "Editor" },
          { value: "owner", label: "Owner" },
        ]
      : [
          { value: "viewer", label: "Viewer" },
          { value: "editor", label: "Editor" },
        ],
  );

  function onTabSelected(e: Event) {
    const { index } = (e as CustomEvent<{ index: number }>).detail;
    setScope(index === 0 ? "document" : index === 1 ? "category" : "space");
    setNewMemberEmail("");
    setAddMemberError(null);
  }

  async function loadCategoryPermissions() {
    const spaceId = currentSpaceId();
    const categoryId = selectedCategoryId();
    if (!spaceId || !categoryId) {
      setCategoryPermissions([]);
      return;
    }
    const response = await api.permissions.list(spaceId, "role", {
      resourceType: "category",
      resourceId: categoryId,
    });
    setCategoryPermissions((response.permissions || []).filter((p) => p.type === "role"));
  }

  async function load() {
    const spaceId = currentSpaceId();
    if (!spaceId || !props.documentId) return;
    setIsLoading(true);
    try {
      const [docPerms, docTreePerms, spacePerms, members, categoryList] =
        await Promise.all([
          api.permissions.list(spaceId, "role", {
            resourceType: "document",
            resourceId: props.documentId,
          }),
          api.permissions.list(spaceId, "role", {
            resourceType: "document_tree",
            resourceId: props.documentId,
          }),
          api.permissions.list(spaceId, "role"),
          api.spaceMembers.get(spaceId),
          api.categories.get(spaceId),
        ]);

      const categoryValues = categoryList?.categories || [];
      setCategories(categoryValues);
      if (!selectedCategoryId() && categoryValues.length > 0) {
        setSelectedCategoryId(categoryValues[0].id);
      }

      setDocPermissions(
        [...(docPerms.permissions || []), ...(docTreePerms.permissions || [])].filter(
          (p) => p.type === "role",
        ),
      );
      setSpacePermissions(
        (spacePerms.permissions || []).filter((p) => p.type === "role"),
      );

      const map = new Map<string, User>();
      for (const member of members || []) {
        if (member.user) map.set(member.user.id, member.user);
      }
      setUsersMap(map);
      await loadCategoryPermissions();
    } catch (err) {
      console.error("Failed to load sharing data:", err);
    } finally {
      setIsLoading(false);
    }
  }

  createEffect(
    on(
      () => props.show,
      async (open) => {
        if (!open) return;
        setScope("document");
        setNewMemberEmail("");
        setNewMemberRole("viewer");
        setIncludeChildPages(false);
        setSelectedCategoryId("");
        setAddMemberError(null);
        await customElements.whenDefined("a-tabs");
        tabsEl?.selectTabByIndex(0, false);
        void load();
      },
    ),
  );

  async function handleInvite(e: Event) {
    e.preventDefault();
    const spaceId = currentSpaceId();
    if (!spaceId || !newMemberEmail().trim()) return;
    if (scope() === "category" && !selectedCategoryId()) {
      setAddMemberError("Select a category");
      return;
    }

    setAddingMember(true);
    setAddMemberError(null);
    try {
      await api.permissions.grant(spaceId, {
        type: "role",
        roleOrFeature: newMemberRole(),
        email: newMemberEmail().trim(),
        ...(scope() === "document"
          ? {
              resourceType: (includeChildPages()
                ? "document_tree"
                : "document") as DocumentPermissionResource,
              resourceId: props.documentId,
            }
          : scope() === "category"
            ? { resourceType: "category" as const, resourceId: selectedCategoryId() }
            : {}),
      });
      setNewMemberEmail("");
      await load();
    } catch (err) {
      setAddMemberError(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setAddingMember(false);
    }
  }

  async function removeDocPerm(perm: PermissionEntry) {
    const spaceId = currentSpaceId();
    if (!spaceId || !confirm("Remove this person's document access?")) return;
    try {
      await api.permissions.revoke(spaceId, {
        type: "role",
        roleOrFeature: perm.permission.permission,
        userId: perm.permission.userId,
        resourceType: perm.permission.resourceType || "document",
        resourceId: props.documentId,
      });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  async function removeCategoryPerm(perm: PermissionEntry) {
    const spaceId = currentSpaceId();
    const categoryId = selectedCategoryId();
    if (!spaceId || !categoryId || !confirm("Remove this person's category access?")) {
      return;
    }
    try {
      await api.permissions.revoke(spaceId, {
        type: "role",
        roleOrFeature: perm.permission.permission,
        userId: perm.permission.userId,
        groupId: perm.permission.groupId,
        resourceType: "category",
        resourceId: categoryId,
      });
      await loadCategoryPermissions();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  async function removeSpacePerm(perm: PermissionEntry) {
    const spaceId = currentSpaceId();
    if (!spaceId || !confirm("Remove this member from the space?")) return;
    try {
      const isGroup = !!perm.permission.groupId;
      const memberId = perm.permission.userId || perm.permission.groupId;
      await api.permissions.revoke(spaceId, {
        type: "role",
        roleOrFeature: perm.permission.permission,
        ...(isGroup ? { groupId: memberId } : { userId: memberId }),
      });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  async function changeSpaceRole(perm: PermissionEntry, newRole: string) {
    const spaceId = currentSpaceId();
    if (!spaceId) return;
    try {
      const isGroup = !!perm.permission.groupId;
      const memberId = perm.permission.userId || perm.permission.groupId;
      await api.permissions.grant(spaceId, {
        type: "role",
        roleOrFeature: newRole,
        ...(isGroup ? { groupId: memberId } : { userId: memberId }),
      });
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update role");
    }
  }

  function getMemberUser(perm: PermissionEntry): User | undefined {
    if (!perm.permission.userId) return undefined;
    return usersMap().get(perm.permission.userId);
  }

  function getMemberName(perm: PermissionEntry): string {
    if (perm.permission.userId) {
      const u = getMemberUser(perm);
      return u?.name || u?.email || perm.permission.userId;
    }
    return perm.permission.groupId ?? "";
  }

  function getMemberEmail(perm: PermissionEntry): string {
    if (perm.permission.userId) return getMemberUser(perm)?.email || "";
    return "";
  }

  function permissionScopeLabel(perm: PermissionEntry): string {
    return perm.permission.resourceType === "document_tree"
      ? "Includes child pages"
      : "This document only";
  }

  function isSelf(perm: PermissionEntry): boolean {
    return perm.permission.userId === user()?.id;
  }

  function canRemoveSpaceMember(perm: PermissionEntry): boolean {
    if (!userIsOwner()) return false;
    if (isSelf(perm)) return false;
    // The space owner is `createdBy`.
    if (
      perm.permission.permission === "owner" &&
      currentSpace()?.createdBy === perm.permission.userId
    ) {
      return false;
    }
    return true;
  }

  /** One person's row — identical in all three panels apart from the trailing controls. */
  const PermissionRow = (rowProps: {
    perm: PermissionEntry;
    scopeLabel?: boolean;
    trailing: JSX.Element;
  }) => (
    <div class="flex items-center gap-2.5 py-2">
      <vektor-avatar
        size="28"
        attr:user-id={rowProps.perm.permission.userId || undefined}
        prop:user={getMemberUser(rowProps.perm)}
      />
      <div class="min-w-0 flex-1">
        <div class="truncate text-neutral-900 text-size-medium">
          {getMemberName(rowProps.perm)}
        </div>
        <Show when={getMemberEmail(rowProps.perm)}>
          <div class="truncate text-neutral-400 text-size-small">
            {getMemberEmail(rowProps.perm)}
          </div>
        </Show>
        <Show when={rowProps.scopeLabel}>
          <div class="truncate text-neutral-400 text-size-small">
            {permissionScopeLabel(rowProps.perm)}
          </div>
        </Show>
      </div>
      {rowProps.trailing}
    </div>
  );

  const RoleBadge = (badgeProps: { role: string }) => (
    <span
      class={`flex-shrink-0 rounded-full px-2 py-0.5 font-medium text-size-small ${roleBadgeClass(badgeProps.role)}`}
    >
      {badgeProps.role}
    </span>
  );

  const Spinner = () => (
    <div class="flex justify-center py-6">
      <div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
    </div>
  );

  const EmailAndRoleFields = () => (
    <>
      <input
        value={newMemberEmail()}
        onInput={(e) => setNewMemberEmail(e.currentTarget.value)}
        type="email"
        required
        placeholder="person@example.com"
        class="min-w-0 flex-1 rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
      />
      <select
        value={newMemberRole()}
        onChange={(e) => setNewMemberRole(e.currentTarget.value)}
        class="rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
      >
        <For each={roleOptions()}>
          {(opt) => <option value={opt.value}>{opt.label}</option>}
        </For>
      </select>
    </>
  );

  const InviteError = () => (
    <Show when={addMemberError()}>
      <p class="mt-1.5 text-red-500 text-size-small">{addMemberError()}</p>
    </Show>
  );

  return (
    <Dialog
      show={props.show}
      bodyClass="p-0 overflow-y-auto"
      panelHeight="h-[22rem]"
      onUpdateShow={(value) => props.onUpdateShow?.(value)}
      header={
        <div class="min-w-0">
          <h2 class="font-semibold text-neutral-900 text-size-title leading-tight">
            Share
          </h2>
          <Show when={props.documentTitle}>
            <p class="mt-0.5 truncate text-neutral-400 text-size-small">
              {props.documentTitle}
            </p>
          </Show>
        </div>
      }
    >
      <a-tabs ref={tabsEl as never} class="block" on:tab-selected={onTabSelected}>
        <a-tabs-list class="block overflow-x-auto px-4 pt-4xs pb-2xs">
          <a-tabs-tab class="inline-flex items-center justify-center rounded-sm px-5xs text-label opacity-60 [&[selected]:hover_span]:bg-gray-100 [&[selected]]:opacity-100 [&[selected]_span]:bg-gray-100 hover:[&_span]:bg-gray-200">
            <span class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors">
              This document
            </span>
          </a-tabs-tab>
          <a-tabs-tab class="inline-flex items-center justify-center rounded-sm px-5xs text-label opacity-60 [&[selected]:hover_span]:bg-gray-100 [&[selected]]:opacity-100 [&[selected]_span]:bg-gray-100 hover:[&_span]:bg-gray-200">
            <span class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors">
              Category
            </span>
          </a-tabs-tab>
          <a-tabs-tab class="inline-flex items-center justify-center rounded-sm px-5xs text-label opacity-60 [&[selected]:hover_span]:bg-gray-100 [&[selected]]:opacity-100 [&[selected]_span]:bg-gray-100 hover:[&_span]:bg-gray-200">
            <span class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors">
              Entire space
            </span>
          </a-tabs-tab>
        </a-tabs-list>

        {/* Document panel */}
        <a-tabs-panel class="block">
          <div class="space-y-3 px-5 py-3">
            <form class="space-y-2" onSubmit={(e) => void handleInvite(e)}>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <EmailAndRoleFields />
              </div>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <label class="inline-flex items-center gap-1.5 whitespace-nowrap text-neutral-600 text-size-small">
                  <input
                    checked={includeChildPages()}
                    onChange={(e) => setIncludeChildPages(e.currentTarget.checked)}
                    type="checkbox"
                    class="h-4 w-4 rounded border-neutral-200 text-neutral-900 focus:ring-neutral-400"
                  />
                  <span>Include child pages</span>
                </label>
                <button
                  type="submit"
                  disabled={addingMember() || !newMemberEmail().trim()}
                  class="button-primary px-3xs"
                >
                  {addingMember() ? "…" : "Invite"}
                </button>
              </div>
              <InviteError />
            </form>

            <Show when={!isLoading()} fallback={<Spinner />}>
              <Show
                when={docPermissions().length > 0}
                fallback={
                  <p class="text-neutral-400 text-size-small">
                    No one has been given direct access to this document yet.
                  </p>
                }
              >
                <div class="max-h-64 divide-y divide-neutral-100 overflow-y-auto">
                  <For each={docPermissions()}>
                    {(perm) => (
                      <PermissionRow
                        perm={perm}
                        scopeLabel
                        trailing={
                          <>
                            <RoleBadge role={perm.permission.permission} />
                            <Show when={!isSelf(perm)}>
                              <button
                                type="button"
                                class="flex-shrink-0 text-neutral-400 text-size-small transition-colors hover:text-red-500"
                                onClick={() => void removeDocPerm(perm)}
                              >
                                Remove
                              </button>
                            </Show>
                          </>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>

              <Show when={spacePermissions().length > 0}>
                <p class="text-neutral-400 text-size-small">
                  {spacePermissions().length} space member
                  {spacePermissions().length !== 1 ? "s" : ""} can also access this
                  document via their space role.
                </p>
              </Show>
            </Show>
          </div>
        </a-tabs-panel>

        {/* Category panel */}
        <a-tabs-panel class="block">
          <div class="space-y-3 px-5 py-3">
            <select
              value={selectedCategoryId()}
              onChange={(e) => {
                setSelectedCategoryId(e.currentTarget.value);
                void loadCategoryPermissions();
              }}
              class="w-full rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
            >
              <option value="">Select a category...</option>
              <For each={categories()}>
                {(category) => <option value={category.id}>{category.name}</option>}
              </For>
            </select>

            <form onSubmit={(e) => void handleInvite(e)}>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <EmailAndRoleFields />
                <button
                  type="submit"
                  disabled={
                    addingMember() || !newMemberEmail().trim() || !selectedCategoryId()
                  }
                  class="button-primary col-span-2 justify-self-end px-3xs sm:col-span-1"
                >
                  {addingMember() ? "..." : "Invite"}
                </button>
              </div>
              <InviteError />
            </form>

            <Show when={!isLoading()} fallback={<Spinner />}>
              <Show
                when={categoryPermissions().length > 0}
                fallback={
                  <p class="text-neutral-400 text-size-small">
                    No one has been given direct access to this category yet.
                  </p>
                }
              >
                <div class="max-h-64 divide-y divide-neutral-100 overflow-y-auto">
                  <For each={categoryPermissions()}>
                    {(perm) => (
                      <PermissionRow
                        perm={perm}
                        trailing={
                          <>
                            <RoleBadge role={perm.permission.permission} />
                            <Show when={!isSelf(perm)}>
                              <button
                                type="button"
                                class="flex-shrink-0 text-neutral-400 text-size-small transition-colors hover:text-red-500"
                                onClick={() => void removeCategoryPerm(perm)}
                              >
                                Remove
                              </button>
                            </Show>
                          </>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </a-tabs-panel>

        {/* Space panel */}
        <a-tabs-panel class="block">
          <div class="space-y-3 px-5 py-3">
            <form onSubmit={(e) => void handleInvite(e)}>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <EmailAndRoleFields />
                <button
                  type="submit"
                  disabled={addingMember() || !newMemberEmail().trim()}
                  class="button-primary col-span-2 justify-self-end px-3xs sm:col-span-1"
                >
                  {addingMember() ? "…" : "Invite"}
                </button>
              </div>
              <InviteError />
            </form>

            <Show when={!isLoading()} fallback={<Spinner />}>
              <Show
                when={spacePermissions().length > 0}
                fallback={
                  <p class="text-neutral-400 text-size-small">No space members yet.</p>
                }
              >
                <div class="max-h-64 divide-y divide-neutral-100 overflow-y-auto">
                  <For each={spacePermissions()}>
                    {(perm) => (
                      <PermissionRow
                        perm={perm}
                        trailing={
                          <>
                            <Show
                              when={userIsOwner() && !isSelf(perm)}
                              fallback={<RoleBadge role={perm.permission.permission} />}
                            >
                              <select
                                value={perm.permission.permission}
                                onChange={(e) =>
                                  void changeSpaceRole(perm, e.currentTarget.value)
                                }
                                class="rounded-md border border-neutral-200 bg-background px-2 py-0.5 text-neutral-700 text-size-small focus:outline-none focus:ring-1 focus:ring-neutral-400"
                              >
                                <option value="viewer">Viewer</option>
                                <option value="editor">Editor</option>
                                <option value="owner">Owner</option>
                              </select>
                            </Show>
                            <Show when={canRemoveSpaceMember(perm)}>
                              <button
                                type="button"
                                class="flex-shrink-0 text-neutral-400 text-size-small transition-colors hover:text-red-500"
                                onClick={() => void removeSpacePerm(perm)}
                              >
                                Remove
                              </button>
                            </Show>
                          </>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </a-tabs-panel>
      </a-tabs>
    </Dialog>
  );
}
