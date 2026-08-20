import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { isOwner, Permission } from "#acl/permissions.ts";
import type { Category, DocumentAccessEntry, ShareLink, User } from "#api/client.ts";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { roleBadgeClass, roleLabel } from "#utils/accessToken.ts";
import { t } from "#utils/lang.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import "./AvatarElement.ts";

interface Props {
  show: boolean;
  documentId: string;
  documentTitle?: string;
  onUpdateShow?: (value: boolean) => void;
}

type DocumentPermissionResource = "document" | "document_tree";

interface SelectOption {
  value: string;
  label: string;
}

const CATEGORY_SCOPE_PREFIX = "category:";

/** The two document scopes, worded identically for an invite and for a link. */
function documentScopeOptions(): SelectOption[] {
  return [
    { value: "document", label: t("This document") },
    { value: "document_tree", label: t("This document and child documents") },
  ];
}

/** Presets rather than a number field: the API requires an expiry and caps it at a year. */
const LINK_EXPIRY_OPTIONS: SelectOption[] = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

/** The API's floor, so a password it would refuse is caught before the request. */
const MIN_LINK_PASSWORD_LENGTH = 8;

/** What a link opens, in the same words as the scope select above it. */
function linkScopeLabel(resourceType: string) {
  return (
    documentScopeOptions().find((option) => option.value === resourceType)?.label ??
    t("This document")
  );
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
  /** Inherited access is context for the direct grants, so it starts folded. */
  const [showInherited, setShowInherited] = createSignal(false);

  const [links, setLinks] = createSignal<ShareLink[]>([]);
  // Listing needs the same role as minting, so a refused load is the answer to
  // "may this person manage links" rather than an error to show.
  const [canManageLinks, setCanManageLinks] = createSignal(false);
  const [linkExpiryDays, setLinkExpiryDays] = createSignal(7);
  // Its own scope, not the invite select's: a link resolves to a page to render,
  // so a category — which the invite select offers — has nothing to point at.
  const [linkScope, setLinkScope] = createSignal<DocumentPermissionResource>("document");
  const [linkPassword, setLinkPassword] = createSignal("");
  const [wantsLinkPassword, setWantsLinkPassword] = createSignal(false);
  const [creatingLink, setCreatingLink] = createSignal(false);
  /** Marks the row a create just added, which is the one the person came to copy. */
  const [createdLinkId, setCreatedLinkId] = createSignal<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = createSignal<string | null>(null);
  const [linkError, setLinkError] = createSignal<string | null>(null);

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

  async function loadLinks() {
    const spaceId = currentSpaceId();
    if (!spaceId || !props.documentId) return;
    try {
      const response = await api.shareLinks.get(spaceId, props.documentId);
      // Revoked and expired alike answer 404, so neither is offered for copying
      // nor counted among the links that work.
      const now = Date.now();
      setLinks(
        response.links.filter(
          (link) =>
            !link.revokedAt &&
            (!link.expiresAt || new Date(link.expiresAt).getTime() > now),
        ),
      );
      setCanManageLinks(true);
    } catch {
      setLinks([]);
      setCanManageLinks(false);
    }
  }

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
      await loadLinks();
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
        setShowInherited(false);
        setLinkScope("document");
        setLinkExpiryDays(7);
        setWantsLinkPassword(false);
        setCreatedLinkId(null);
        setLinkPassword("");
        setLinkError(null);
        // This instance outlives navigation between pages of the same type, so
        // anything left from the last page it was opened on is a statement about
        // the wrong document — including live Revoke buttons.
        setLinks([]);
        setCanManageLinks(false);
      },
    ),
  );

  // Tracks the space too, not just the open flag: the dialog can be opened before
  // the space query resolves, and a load that returned early on a null space id
  // would never be retried.
  createEffect(
    on([() => props.show, currentSpaceId], ([open, spaceId]) => {
      if (!open || !spaceId) return;
      void load();
    }),
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

  async function handleCreateLink(e: Event) {
    e.preventDefault();
    const spaceId = currentSpaceId();
    if (!spaceId) return;

    const password = wantsLinkPassword() ? linkPassword().trim() : "";
    if (wantsLinkPassword() && password.length < MIN_LINK_PASSWORD_LENGTH) {
      setLinkError(`A password needs at least ${MIN_LINK_PASSWORD_LENGTH} characters`);
      return;
    }

    setCreatingLink(true);
    setLinkError(null);
    try {
      const created = await api.shareLinks.create(spaceId, {
        name: props.documentTitle || "Share link",
        resourceType: linkScope(),
        resourceId: props.documentId,
        expiresInDays: linkExpiryDays(),
        ...(password ? { password } : {}),
      });
      setCreatedLinkId(created.id);
      setLinkPassword("");
      setWantsLinkPassword(false);
      await loadLinks();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to create link");
    } finally {
      setCreatingLink(false);
    }
  }

  async function revokeLink(link: ShareLink) {
    const spaceId = currentSpaceId();
    if (!spaceId || !confirm("Revoke this link? Anyone holding it loses access.")) {
      return;
    }
    try {
      await api.shareLinks.revoke(spaceId, link.id);
      if (createdLinkId() === link.id) setCreatedLinkId(null);
      await loadLinks();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "Failed to revoke link");
    }
  }

  /** The link's own URL, which is the credential — `/s/<id>` is the page route. */
  function shareLinkUrl(link: ShareLink): string {
    return `${window.location.origin}/s/${link.id}`;
  }

  async function copyLink(link: ShareLink) {
    try {
      await navigator.clipboard.writeText(shareLinkUrl(link));
      setCopiedLinkId(link.id);
      setTimeout(
        () => setCopiedLinkId((current) => (current === link.id ? null : current)),
        1_500,
      );
    } catch {
      setLinkError("Could not copy the link — select and copy it manually");
    }
  }

  /** When a link stops working, and whether it has ever been opened. */
  function linkHistoryLabel(link: ShareLink): string {
    const expires = link.expiresAt
      ? `Expires ${new Date(link.expiresAt).toLocaleDateString()}`
      : "No expiry";
    const used = link.lastUsedAt
      ? `opened ${new Date(link.lastUsedAt).toLocaleDateString()}`
      : "never opened";
    return `${expires} · ${used}`;
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

  // An id no profile resolves — a deleted account, or one from an IdP this space
  // has never seen — is a person this list cannot name. Saying so beats printing
  // the raw uuid, which reads as a broken row.
  function getMemberName(userId?: string, groupId?: string): string {
    if (!userId) return groupId ?? "";
    const member = usersMap().get(userId);
    return member?.name || member?.email || "Unknown user";
  }

  /**
   * Email for a person, the kind for a group, and enough of the id to tell two
   * unnamed grantees apart.
   */
  function getMemberSubtitle(entry: DocumentAccessEntry): string {
    if (!entry.userId) return "Group";
    const member = usersMap().get(entry.userId);
    if (member?.email) return member.email;
    return member?.name ? "" : `id ${entry.userId.slice(0, 8)}`;
  }

  // What the grant covers, not what the person can reach — they may well hold
  // grants on other documents, which this dialog never sees. That it is a group
  // is the row's subtitle, not part of this.
  function accessSourceLabel(entry: DocumentAccessEntry): string {
    const { resourceType, resourceLabel, inherited } = entry.via;
    return resourceType === "document"
      ? "Granted on this document"
      : resourceType === "document_tree"
        ? inherited
          ? `Via document tree: ${resourceLabel || "parent document"}`
          : "Granted on this document and child documents"
        : resourceType === "category"
          ? `Via category: ${resourceLabel || "category"}`
          : "Via space membership";
  }

  /** Left off when the group heading already says it: a plain grant on this document. */
  function accessDetail(entry: DocumentAccessEntry): string | undefined {
    if (!entry.via.inherited && entry.via.resourceType === "document") return undefined;
    return accessSourceLabel(entry);
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
  // granted, and what the person already had — so they are listed apart.
  const directAccess = createMemo(() =>
    sortedDocumentAccess().filter((entry) => !entry.via.inherited),
  );
  const inheritedAccess = createMemo(() =>
    sortedDocumentAccess().filter((entry) => entry.via.inherited),
  );

  /** Carries the count, so the label earns its line instead of just naming the list. */
  const accessHeading = createMemo(() => {
    const total = sortedDocumentAccess().length;
    if (total === 0) return "People with access";
    return total === 1 ? "1 person with access" : `${total} people with access`;
  });

  /** Categories are a third kind of scope, so they sit in their own group. */
  const categoryScopeGroups = createMemo(() =>
    categories().length === 0
      ? undefined
      : [
          {
            label: t("Category"),
            options: categories().map((category) => ({
              value: `${CATEGORY_SCOPE_PREFIX}${category.id}`,
              label: category.name,
            })),
          },
        ],
  );

  /**
   * A native select wearing the chip chrome the rest of the app uses. Reading as
   * text rather than as a boxed field is the point: these sit inside sentences.
   *
   * Options are passed as data, not as children, because the invisible twin below
   * needs the chosen label — a select left to itself is as wide as its longest
   * option, which drags the chevron a sentence away from the word it belongs to.
   */
  const QuietSelect = (selectProps: {
    value: string;
    ariaLabel: string;
    options: SelectOption[];
    groups?: { label: string; options: SelectOption[] }[];
    onChange: (value: string) => void;
  }) => {
    const selectedLabel = () =>
      [
        ...selectProps.options,
        ...(selectProps.groups ?? []).flatMap((group) => group.options),
      ].find((option) => option.value === selectProps.value)?.label ?? "";

    return (
      <span class="relative inline-flex h-7 flex-none items-center">
        <span
          aria-hidden="true"
          class="whitespace-pre pr-6 pl-1.5 font-medium text-size-small opacity-0"
        >
          {selectedLabel()}
        </span>
        {/* Out of flow, so only the twin above decides how wide this reads. */}
        <select
          value={selectProps.value}
          aria-label={selectProps.ariaLabel}
          onChange={(e) => selectProps.onChange(e.currentTarget.value)}
          class="absolute inset-0 cursor-pointer appearance-none rounded-md bg-transparent pr-6 pl-1.5 font-medium text-neutral-800 text-size-small transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-primary-500 focus-visible:outline-offset-1"
        >
          <For each={selectProps.options}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
          <For each={selectProps.groups ?? []}>
            {(group) => (
              <optgroup label={group.label}>
                <For each={group.options}>
                  {(option) => <option value={option.value}>{option.label}</option>}
                </For>
              </optgroup>
            )}
          </For>
        </select>
        <Icon
          class="pointer-events-none absolute right-1.5 h-3 w-3 opacity-40"
          name="chevron-down"
        />
      </span>
    );
  };

  /** Separates the controls inside one sentence-style row. */
  const RowDivider = () => (
    <span aria-hidden="true" class="h-4 w-px flex-none bg-neutral-100" />
  );

  /** A subdivision of a list, pitched below a section heading rather than beside it. */
  const GroupLabel = (labelProps: { label: string }) => (
    <div class="mt-4xs mb-6xs flex items-center gap-4xs">
      <span class="flex-none text-neutral-400 text-size-small">{labelProps.label}</span>
      <span aria-hidden="true" class="h-px flex-1 bg-neutral-100" />
    </div>
  );

  /** The same label as a disclosure, for a list that is context rather than the point. */
  const GroupToggle = (toggleProps: {
    label: string;
    open: boolean;
    onToggle: () => void;
  }) => (
    <button
      type="button"
      aria-expanded={toggleProps.open}
      class="mt-4xs mb-6xs flex w-full items-center gap-4xs text-neutral-400 transition-colors hover:text-neutral-600"
      onClick={toggleProps.onToggle}
    >
      <Icon
        class={`h-3 w-3 flex-none transition-transform ${toggleProps.open ? "" : "-rotate-90"}`}
        name="chevron-down"
      />
      <span class="flex-none text-size-small">{toggleProps.label}</span>
      <span aria-hidden="true" class="h-px flex-1 bg-neutral-100" />
    </button>
  );

  const PermissionRow = (rowProps: { entry: DocumentAccessEntry }) => {
    const detail = () => accessDetail(rowProps.entry);
    const removable = () =>
      directGrants(rowProps.entry).length > 0 &&
      rowProps.entry.userId !== user()?.id &&
      (userIsOwner() || !rowProps.entry.groupId);

    return (
      <div class="flex items-center gap-4xs py-1">
        <Show
          when={rowProps.entry.userId}
          fallback={
            <span class="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-neutral-100 text-neutral-500">
              <Icon class="h-3.5 w-3.5" name="users-group" />
            </span>
          }
        >
          <vektor-avatar
            size="28"
            attr:user-id={rowProps.entry.userId}
            prop:user={usersMap().get(rowProps.entry.userId ?? "")}
          />
        </Show>
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium text-neutral-900 text-size-normal">
            {getMemberName(rowProps.entry.userId, rowProps.entry.groupId)}
          </div>
          <Show when={getMemberSubtitle(rowProps.entry)}>
            <div class="truncate text-neutral-400 text-size-small">
              {getMemberSubtitle(rowProps.entry)}
            </div>
          </Show>
          <Show when={detail()}>
            <div class="truncate text-neutral-400 text-size-small">{detail()}</div>
          </Show>
        </div>
        <RoleBadge role={rowProps.entry.permission} />
        {/* Reserved whether or not it holds a button, so every badge above and
            below ends on the same rail. */}
        <div class="flex w-14 flex-none justify-end">
          <Show when={removable()}>
            <button
              type="button"
              class="rounded-md px-1.5 py-0.5 text-neutral-400 text-size-small transition-colors hover:bg-red-500/10 hover:text-red-500"
              onClick={() => void removeDocumentAccess(rowProps.entry)}
            >
              Remove
            </button>
          </Show>
        </div>
      </div>
    );
  };

  const RoleBadge = (badgeProps: { role: string }) => (
    <span
      class={`flex-none rounded-md border px-1.5 py-0.5 font-medium text-size-extra-small ${roleBadgeClass(badgeProps.role)}`}
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
    <div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/10 p-3xs">
      <p class="text-red-500 text-size-small">{errorProps.message}</p>
      <button
        type="button"
        class="mt-1 text-red-500 text-size-small underline"
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
      <div class="px-5 pt-2 pb-5">
        <form onSubmit={(e) => void handleInvite(e)}>
          {/* Email and access read as one control, so they share one field frame. */}
          <div class="flex items-center gap-4xs">
            <div class="flex min-w-0 flex-1 items-center rounded-lg border border-neutral-200 bg-background transition-colors focus-within:border-primary-300">
              <input
                id="share-email"
                value={newMemberEmail()}
                onInput={(e) => setNewMemberEmail(e.currentTarget.value)}
                type="email"
                required
                placeholder="person@example.com"
                class="h-10 min-w-0 flex-1 bg-transparent px-3xs text-neutral-900 text-size-medium outline-none placeholder:text-neutral-400"
              />
              <RowDivider />
              <QuietSelect
                value={newMemberRole()}
                ariaLabel="Access to grant"
                options={roleOptions}
                onChange={setNewMemberRole}
              />
            </div>
            <button
              type="submit"
              disabled={addingMember() || !newMemberEmail().trim()}
              class="button-primary h-10"
            >
              {addingMember() ? "…" : "Invite"}
            </button>
          </div>

          <div class="mt-5xs flex items-center gap-5xs text-neutral-500 text-size-small">
            <span class="flex-none">Applies to</span>
            <QuietSelect
              value={scope()}
              ariaLabel="What the invite applies to"
              options={documentScopeOptions()}
              groups={categoryScopeGroups()}
              onChange={setScope}
            />
          </div>

          <Show when={addMemberError()}>
            <p class="mt-5xs text-red-500 text-size-small">{addMemberError()}</p>
          </Show>
        </form>

        {/* The list is the content here, so its heading stays furniture: a label,
            not a second title competing with the dialog's own. */}
        <section class="mt-2xs">
          <h3 class="font-medium text-neutral-400 text-size-extra-small uppercase tracking-wider">
            {accessHeading()}
          </h3>

          <Show when={!isLoading()} fallback={<Spinner />}>
            <Show
              when={!loadError()}
              fallback={
                <div class="mt-4xs">
                  <LoadError message={loadError() ?? ""} onRetry={() => void load()} />
                </div>
              }
            >
              <Show
                when={sortedDocumentAccess().length > 0}
                fallback={
                  <p class="mt-4xs text-neutral-400 text-size-small">
                    No one has access to this document yet.
                  </p>
                }
              >
                <div class="mt-5xs max-h-72 overflow-y-auto">
                  <For each={directAccess()}>
                    {(entry) => <PermissionRow entry={entry} />}
                  </For>

                  {/* Folded away by default: access this document did not grant, and
                      that this dialog cannot take back. */}
                  <Show when={inheritedAccess().length > 0}>
                    <GroupToggle
                      label={`Inherited (${inheritedAccess().length})`}
                      open={showInherited()}
                      onToggle={() => setShowInherited(!showInherited())}
                    />
                    <Show when={showInherited()}>
                      <For each={inheritedAccess()}>
                        {(entry) => <PermissionRow entry={entry} />}
                      </For>
                    </Show>
                  </Show>
                </div>
              </Show>
            </Show>
          </Show>
        </section>

        {/* Its own surface, bled to the panel edges. Link sharing is a different
            kind of thing from the people list, and a fourth flush-left heading
            under a fourth rule would only have added to the stack. */}
        <Show when={canManageLinks()}>
          <section class="-mx-5 mt-2xs -mb-5 border-neutral-100 border-t bg-neutral-50 px-5 pt-3xs pb-5">
            <form onSubmit={(e) => void handleCreateLink(e)}>
              <div class="flex items-start gap-4xs">
                <div class="min-w-0 flex-1">
                  <h3 class="font-medium text-neutral-900 text-size-medium">
                    Anyone with the link
                  </h3>
                  <p class="text-neutral-400 text-size-small">
                    Read-only, and no account needed.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={creatingLink()}
                  class="button-secondary bg-background"
                >
                  {creatingLink() ? "…" : "Create link"}
                </button>
              </div>

              <div class="mt-4xs flex flex-wrap items-center gap-5xs text-neutral-500 text-size-small">
                <span class="flex-none">Expires in</span>
                <QuietSelect
                  value={String(linkExpiryDays())}
                  ariaLabel="When the link expires"
                  options={LINK_EXPIRY_OPTIONS}
                  onChange={(value) => setLinkExpiryDays(Number(value))}
                />
                <RowDivider />
                <QuietSelect
                  value={linkScope()}
                  ariaLabel="What the link opens"
                  options={documentScopeOptions()}
                  onChange={(value) => setLinkScope(value as DocumentPermissionResource)}
                />
                <RowDivider />
                <Show
                  when={wantsLinkPassword()}
                  fallback={
                    <button
                      type="button"
                      class="flex-none rounded-md px-1.5 py-1 font-medium text-neutral-600 text-size-small transition-colors hover:bg-neutral-100"
                      onClick={() => setWantsLinkPassword(true)}
                    >
                      Add password
                    </button>
                  }
                >
                  {/* The clear button rides inside the field, or it wraps to a
                      line of its own once the row is full. */}
                  <span class="relative flex min-w-40 flex-1 items-center">
                    <input
                      value={linkPassword()}
                      onInput={(e) => setLinkPassword(e.currentTarget.value)}
                      type="password"
                      autocomplete="new-password"
                      minLength={MIN_LINK_PASSWORD_LENGTH}
                      aria-label="Link password"
                      placeholder={`Password, ${MIN_LINK_PASSWORD_LENGTH}+ chars`}
                      class="h-7 w-full rounded-md border border-neutral-200 bg-background pr-7 pl-2 text-neutral-900 text-size-small outline-none transition-colors placeholder:text-neutral-400 focus-visible:border-primary-300"
                    />
                    <button
                      type="button"
                      aria-label="Drop the password"
                      class="absolute right-1 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                      onClick={() => {
                        setWantsLinkPassword(false);
                        setLinkPassword("");
                      }}
                    >
                      <Icon class="h-3 w-3" name="cancel" />
                    </button>
                  </span>
                </Show>
              </div>

              <Show when={linkError()}>
                <p class="mt-5xs text-red-500 text-size-small">{linkError()}</p>
              </Show>
            </form>

            <Show when={links().length > 0}>
              <div>
                <GroupLabel
                  label={
                    links().length === 1
                      ? "1 active link"
                      : `${links().length} active links`
                  }
                />
                <For each={links()}>
                  {(link) => (
                    // Negative margin so the row's own hover surface can bleed past
                    // the body padding while its content stays on the same rail.
                    <div
                      class={`-mx-2 flex items-center gap-4xs rounded-lg border px-2 py-1.5 transition-colors ${
                        link.id === createdLinkId()
                          ? "border-primary-200 bg-primary-10"
                          : "border-transparent hover:bg-background"
                      }`}
                    >
                      <Icon
                        class="h-3.5 w-3.5 flex-none opacity-40"
                        name={link.hasPassword ? "lock-element" : "link"}
                      />
                      <div class="min-w-0 flex-1">
                        <div class="truncate font-medium text-neutral-900 text-size-normal">
                          {linkScopeLabel(link.resourceType)}
                        </div>
                        <div class="truncate text-neutral-400 text-size-small">
                          {linkHistoryLabel(link)}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="button-secondary button-small bg-background"
                        onClick={() => void copyLink(link)}
                      >
                        {copiedLinkId() === link.id ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        class="flex-none rounded-md px-1.5 py-0.5 text-neutral-400 text-size-small transition-colors hover:bg-red-500/10 hover:text-red-500"
                        onClick={() => void revokeLink(link)}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>
      </div>
    </Dialog>
  );
}
