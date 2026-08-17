import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  Show,
} from "solid-js";
import { isOwner, Permission } from "#acl/permissions.ts";
import type { Category, DocumentAccessEntry, User } from "#api/client.ts";
import { api } from "#api/client.ts";
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

type DocumentPermissionResource = "document" | "document_tree";

const CATEGORY_SCOPE_PREFIX = "category:";

function roleBadgeClass(role: string) {
  const map: Record<string, string> = {
    owner: "bg-purple-100 text-purple-700",
    editor: "bg-primary-50 text-primary-700",
    viewer: "bg-neutral-100 text-neutral-600",
  };
  return map[role] ?? map.viewer;
}

/** Phrased as what the person may do, not as a role name. */
function roleLabel(role: string) {
  const map: Record<string, string> = {
    owner: "Owner",
    editor: "Can edit",
    viewer: "Can view",
  };
  return map[role] ?? role;
}

export function DocumentShareDialog(props: Props) {
  const { currentSpaceId, currentSpace } = useSpace();
  const user = useUserProfile();

  /** `document`, `document_tree`, or `category:<id>` — the resource a grant lands on. */
  const [scope, setScope] = createSignal<string>("document");

  const [documentAccess, setDocumentAccess] = createSignal<DocumentAccessEntry[]>([]);
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [usersMap, setUsersMap] = createSignal(new Map<string, User>());
  const [isLoading, setIsLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  const [newMemberEmail, setNewMemberEmail] = createSignal("");
  const [newMemberRole, setNewMemberRole] = createSignal<string>(Permission.VIEWER);
  const [addingMember, setAddingMember] = createSignal(false);
  const [addMemberError, setAddMemberError] = createSignal<string | null>(null);

  const userIsOwner = createMemo(() => isOwner(currentSpace()?.userRole));

  // No owner: this dialog shares a document or a category, and owner is only
  // grantable on the space itself.
  const roleOptions = [
    { value: Permission.VIEWER, label: roleLabel("viewer") },
    { value: Permission.EDITOR, label: roleLabel("editor") },
  ];

  async function load() {
    const spaceId = currentSpaceId();
    if (!spaceId || !props.documentId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const [access, members, categoryList] = await Promise.all([
        api.documentAccess.get(spaceId, props.documentId),
        api.spaceMembers.get(spaceId),
        api.categories.get(spaceId),
      ]);

      setCategories(categoryList?.categories || []);
      setDocumentAccess(access);

      const map = new Map<string, User>();
      for (const member of members || []) {
        if (member.user) map.set(member.user.id, member.user);
      }
      setUsersMap(map);
    } catch (err) {
      // Every list in this dialog is a statement about who has access, so a
      // failed load must not fall through to the empty state — "no one has
      // access" is the opposite of "we could not find out".
      setDocumentAccess([]);
      setLoadError(err instanceof Error ? err.message : "Failed to load sharing data");
    } finally {
      setIsLoading(false);
    }
  }

  createEffect(
    on(
      () => props.show,
      (open) => {
        if (!open) return;
        setScope("document");
        setNewMemberEmail("");
        setNewMemberRole(Permission.VIEWER);
        setAddMemberError(null);
        void load();
      },
    ),
  );

  /** Turns the scope selection into the resource the grant is written to. */
  function grantTarget() {
    const value = scope();
    if (value.startsWith(CATEGORY_SCOPE_PREFIX)) {
      return {
        resourceType: "category" as const,
        resourceId: value.slice(CATEGORY_SCOPE_PREFIX.length),
      };
    }
    return {
      resourceType: value as DocumentPermissionResource,
      resourceId: props.documentId,
    };
  }

  async function handleInvite(e: Event) {
    e.preventDefault();
    const spaceId = currentSpaceId();
    if (!spaceId || !newMemberEmail().trim()) return;

    setAddingMember(true);
    setAddMemberError(null);
    try {
      await api.permissions.grant(spaceId, {
        type: "role",
        roleOrFeature: newMemberRole(),
        email: newMemberEmail().trim(),
        ...grantTarget(),
      });
      setNewMemberEmail("");
      await load();
    } catch (err) {
      setAddMemberError(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setAddingMember(false);
    }
  }

  function directGrants(entry: DocumentAccessEntry) {
    return entry.grants.filter((grant) => !grant.inherited);
  }

  async function removeDocumentAccess(entry: DocumentAccessEntry) {
    const spaceId = currentSpaceId();
    const grants = directGrants(entry);
    if (!spaceId || grants.length === 0) return;
    if (!confirm("Remove this person's document access?")) return;
    try {
      for (const grant of grants) {
        await api.permissions.revoke(spaceId, {
          type: "role",
          roleOrFeature: grant.permission,
          ...(entry.userId ? { userId: entry.userId } : { groupId: entry.groupId }),
          resourceType: grant.resourceType,
          resourceId: grant.resourceId,
        });
      }
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  function getMemberName(userId?: string, groupId?: string): string {
    if (!userId) return groupId ?? "";
    const member = usersMap().get(userId);
    return member?.name || member?.email || userId;
  }

  function getMemberEmail(userId?: string): string {
    return (userId && usersMap().get(userId)?.email) || "";
  }

  // What the grant covers, not what the person can reach — they may well hold
  // grants on other documents, which this dialog never sees.
  function accessSourceLabel(entry: DocumentAccessEntry): string {
    const { resourceType, resourceLabel, inherited } = entry.via;
    const source =
      resourceType === "document"
        ? "Granted on this page"
        : resourceType === "document_tree"
          ? inherited
            ? `Via page tree: ${resourceLabel || "parent page"}`
            : "Granted on this page and child pages"
          : resourceType === "category"
            ? `Via category: ${resourceLabel || "category"}`
            : "Via space membership";
    return entry.groupId ? `Group · ${source}` : source;
  }

  const sourceRank: Record<string, number> = {
    document: 0,
    document_tree: 1,
    category: 2,
    space: 3,
  };

  const sortedDocumentAccess = createMemo(() =>
    [...documentAccess()].sort((a, b) => {
      const rank =
        (sourceRank[a.via.resourceType] ?? 4) - (sourceRank[b.via.resourceType] ?? 4);
      if (rank !== 0) return rank;
      return getMemberName(a.userId, a.groupId).localeCompare(
        getMemberName(b.userId, b.groupId),
      );
    }),
  );

  // Direct and inherited access answer different questions — what this dialog
  // granted, and what the person already had — so they are labelled apart.
  const accessGroups = createMemo(() =>
    [
      {
        label: "Direct access",
        badgeClass: "bg-primary-50 text-primary-700",
        entries: sortedDocumentAccess().filter((entry) => !entry.via.inherited),
      },
      {
        label: "Inherited access",
        badgeClass: "bg-neutral-100 text-neutral-600",
        entries: sortedDocumentAccess().filter((entry) => entry.via.inherited),
      },
    ].filter((group) => group.entries.length > 0),
  );

  const PermissionRow = (rowProps: {
    userId?: string;
    groupId?: string;
    detail?: string;
    trailing: JSX.Element;
  }) => (
    <div class="flex items-center gap-2.5 py-2">
      <vektor-avatar
        size="28"
        attr:user-id={rowProps.userId || undefined}
        prop:user={rowProps.userId ? usersMap().get(rowProps.userId) : undefined}
      />
      <div class="min-w-0 flex-1">
        <div class="truncate text-neutral-900 text-size-medium">
          {getMemberName(rowProps.userId, rowProps.groupId)}
        </div>
        <Show when={getMemberEmail(rowProps.userId)}>
          <div class="truncate text-neutral-400 text-size-small">
            {getMemberEmail(rowProps.userId)}
          </div>
        </Show>
        <Show when={rowProps.detail}>
          <div class="truncate text-neutral-400 text-size-small">{rowProps.detail}</div>
        </Show>
      </div>
      {rowProps.trailing}
    </div>
  );

  const RoleBadge = (badgeProps: { role: string }) => (
    <span
      class={`flex-shrink-0 rounded-full px-2 py-0.5 font-medium text-size-small ${roleBadgeClass(badgeProps.role)}`}
    >
      {roleLabel(badgeProps.role)}
    </span>
  );

  const Spinner = () => (
    <div class="flex justify-center py-6">
      <div class="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
    </div>
  );

  /** Shown in place of a list whose load failed, so nothing reads as "empty". */
  const LoadError = (errorProps: { message: string; onRetry: () => void }) => (
    <div role="alert" class="rounded-md border border-red-200 bg-red-50 p-3">
      <p class="text-red-600 text-size-small">{errorProps.message}</p>
      <button
        type="button"
        class="mt-1.5 text-red-700 text-size-small underline"
        onClick={errorProps.onRetry}
      >
        Try again
      </button>
    </div>
  );

  return (
    <Dialog
      show={props.show}
      bodyClass="p-0 overflow-y-auto"
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
      <div class="space-y-3 px-5 py-3">
        <form
          class="space-y-2 rounded-lg bg-neutral-50 p-3"
          onSubmit={(e) => void handleInvite(e)}
        >
          <div class="flex items-center gap-2">
            <input
              id="share-email"
              value={newMemberEmail()}
              onInput={(e) => setNewMemberEmail(e.currentTarget.value)}
              type="email"
              required
              placeholder="person@example.com"
              class="min-w-0 flex-1 rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
            <button
              type="submit"
              disabled={addingMember() || !newMemberEmail().trim()}
              class="button-primary flex-none px-3xs"
            >
              {addingMember() ? "…" : "Invite"}
            </button>
          </div>

          {/* Both selects share the row evenly: neither fits beside the other
              and the button at this dialog's width. */}
          <div class="flex items-center gap-2">
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <label
                class="flex-none text-neutral-600 text-size-small"
                for="share-access"
              >
                Access
              </label>
              <select
                id="share-access"
                value={newMemberRole()}
                onChange={(e) => setNewMemberRole(e.currentTarget.value)}
                class="min-w-0 flex-1 rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
              >
                <For each={roleOptions}>
                  {(opt) => <option value={opt.value}>{opt.label}</option>}
                </For>
              </select>
            </div>

            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <label class="flex-none text-neutral-600 text-size-small" for="share-scope">
                Scope
              </label>
              <select
                id="share-scope"
                value={scope()}
                onChange={(e) => setScope(e.currentTarget.value)}
                class="min-w-0 flex-1 rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-medium focus:outline-none focus:ring-1 focus:ring-neutral-400"
              >
                <option value="document">This page</option>
                <option value="document_tree">This page and child pages</option>
                <Show when={categories().length > 0}>
                  <optgroup label="Category">
                    <For each={categories()}>
                      {(category) => (
                        <option value={`${CATEGORY_SCOPE_PREFIX}${category.id}`}>
                          {category.name}
                        </option>
                      )}
                    </For>
                  </optgroup>
                </Show>
              </select>
            </div>
          </div>

          <Show when={addMemberError()}>
            <p class="text-red-500 text-size-small">{addMemberError()}</p>
          </Show>
        </form>

        <div>
          <h3 class="mb-2 font-semibold text-neutral-900 text-size-medium">
            People with access
          </h3>

          <Show when={!isLoading()} fallback={<Spinner />}>
            <Show
              when={!loadError()}
              fallback={
                <LoadError message={loadError() ?? ""} onRetry={() => void load()} />
              }
            >
              <Show
                when={accessGroups().length > 0}
                fallback={
                  <p class="text-neutral-400 text-size-small">
                    No one has access to this document yet.
                  </p>
                }
              >
                <div class="max-h-80 divide-y divide-neutral-100 overflow-y-auto">
                  <For each={accessGroups()}>
                    {(group) => (
                      <div class="py-2">
                        <span
                          class={`inline-flex rounded-md px-2 py-0.5 font-medium text-size-small ${group.badgeClass}`}
                        >
                          {group.label}
                        </span>
                        <div class="mt-1">
                          <For each={group.entries}>
                            {(entry) => (
                              <PermissionRow
                                userId={entry.userId}
                                groupId={entry.groupId}
                                detail={accessSourceLabel(entry)}
                                trailing={
                                  <>
                                    <RoleBadge role={entry.permission} />
                                    <Show
                                      when={
                                        directGrants(entry).length > 0 &&
                                        entry.userId !== user()?.id &&
                                        (userIsOwner() || !entry.groupId)
                                      }
                                    >
                                      <button
                                        type="button"
                                        class="flex-shrink-0 text-neutral-400 text-size-small transition-colors hover:text-red-500"
                                        onClick={() => void removeDocumentAccess(entry)}
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
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
