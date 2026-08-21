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
import { SwitchToggle } from "./SwitchToggle.tsx";
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

function documentScopeOptions(documentTitle?: string): SelectOption[] {
  const titleSuffix = documentTitle?.trim() ? ` — ${documentTitle.trim()}` : "";
  return [
    { value: "document", label: `${t("This document")}${titleSuffix}` },
    {
      value: "document_tree",
      label: `${t("This document and child documents")}${titleSuffix}`,
    },
  ];
}

function linkExpiryOptions(): SelectOption[] {
  return [
    { value: "1", label: t("1 day") },
    { value: "7", label: t("7 days") },
    { value: "30", label: t("30 days") },
    { value: "90", label: t("90 days") },
    { value: "365", label: t("1 year") },
  ];
}

const MIN_LINK_PASSWORD_LENGTH = 8;

function linkScopeLabel(resourceType: string) {
  return (
    documentScopeOptions().find((option) => option.value === resourceType)?.label ??
    t("This document")
  );
}

export function DocumentShareDialog(props: Props) {
  const { currentSpaceId, currentSpace } = useSpace();
  const user = useUserProfile();

  const [shareMode, setShareMode] = createSignal<"people" | "link">("people");
  const [scope, setScope] = createSignal<string>("document");

  const [documentAccess, setDocumentAccess] = createSignal<DocumentAccessEntry[]>([]);
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [usersMap, setUsersMap] = createSignal(new Map<string, User>());
  const [isLoading, setIsLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [showInherited, setShowInherited] = createSignal(false);

  const [links, setLinks] = createSignal<ShareLink[]>([]);
  const [canManageLinks, setCanManageLinks] = createSignal(false);
  const [linkExpiryDays, setLinkExpiryDays] = createSignal(7);
  const [linkScope, setLinkScope] = createSignal<DocumentPermissionResource>("document");
  const [linkPassword, setLinkPassword] = createSignal("");
  const [wantsLinkPassword, setWantsLinkPassword] = createSignal(false);
  const [creatingLink, setCreatingLink] = createSignal(false);
  const [createdLinkId, setCreatedLinkId] = createSignal<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = createSignal<string | null>(null);
  const [linkError, setLinkError] = createSignal<string | null>(null);

  const [newMemberEmail, setNewMemberEmail] = createSignal("");
  const [newMemberRole, setNewMemberRole] = createSignal<string>(Permission.VIEWER);
  const [addingMember, setAddingMember] = createSignal(false);
  const [addMemberError, setAddMemberError] = createSignal<string | null>(null);

  const userIsOwner = createMemo(() => isOwner(currentSpace()?.userRole));

  const roleOptions = [
    { value: Permission.VIEWER, label: roleLabel("viewer") },
    { value: Permission.EDITOR, label: roleLabel("editor") },
  ];

  async function loadLinks() {
    const spaceId = currentSpaceId();
    if (!spaceId || !props.documentId) return;
    try {
      const response = await api.shares.get(spaceId, props.documentId);
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
      // Do not present an authorization failure as an empty access list.
      setDocumentAccess([]);
      setLoadError(err instanceof Error ? err.message : t("Failed to load sharing data"));
    } finally {
      setIsLoading(false);
    }
  }

  createEffect(
    on(
      () => props.show,
      (open) => {
        if (!open) return;
        setShareMode("people");
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
        // Link rows contain actions and must not survive document navigation.
        setLinks([]);
        setCanManageLinks(false);
      },
    ),
  );

  // Retry when the space id resolves after the dialog opens.
  createEffect(
    on([() => props.show, currentSpaceId], ([open, spaceId]) => {
      if (!open || !spaceId) return;
      void load();
    }),
  );

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
      setAddMemberError(err instanceof Error ? err.message : t("Failed to invite"));
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
      setLinkError(
        t("A password needs at least {count} characters").replace(
          "{count}",
          String(MIN_LINK_PASSWORD_LENGTH),
        ),
      );
      return;
    }

    setCreatingLink(true);
    setLinkError(null);
    try {
      const created = await api.shares.create(spaceId, {
        name: props.documentTitle || t("Share link"),
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
      setLinkError(err instanceof Error ? err.message : t("Failed to create link"));
    } finally {
      setCreatingLink(false);
    }
  }

  async function revokeLink(link: ShareLink) {
    const spaceId = currentSpaceId();
    if (!spaceId || !confirm(t("Revoke this link? Anyone holding it loses access."))) {
      return;
    }
    try {
      await api.shares.revoke(spaceId, link.id);
      if (createdLinkId() === link.id) setCreatedLinkId(null);
      await loadLinks();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t("Failed to revoke link"));
    }
  }

  function shareLinkUrl(link: ShareLink): string {
    return `${window.location.origin}/${currentSpace()?.slug}/s/${link.id}`;
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
      setLinkError(t("Could not copy the link — select and copy it manually"));
    }
  }

  function linkHistoryLabel(link: ShareLink): string {
    const expires = link.expiresAt
      ? t("Expires {date}").replace(
          "{date}",
          new Date(link.expiresAt).toLocaleDateString(),
        )
      : t("No expiry");
    const used = link.lastUsedAt
      ? t("Opened {date}").replace(
          "{date}",
          new Date(link.lastUsedAt).toLocaleDateString(),
        )
      : t("Never opened");
    return `${expires} · ${used}`;
  }

  function directGrants(entry: DocumentAccessEntry) {
    return entry.grants.filter((grant) => !grant.inherited);
  }

  async function removeDocumentAccess(entry: DocumentAccessEntry) {
    const spaceId = currentSpaceId();
    const grants = directGrants(entry);
    if (!spaceId || grants.length === 0) return;
    if (!confirm(t("Remove this person's document access?"))) return;
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
      alert(err instanceof Error ? err.message : t("Failed to remove"));
    }
  }

  function getMemberName(userId?: string, groupId?: string): string {
    if (!userId) return groupId ?? "";
    const member = usersMap().get(userId);
    return member?.name || member?.email || t("Unknown user");
  }

  function getMemberSubtitle(entry: DocumentAccessEntry): string {
    if (!entry.userId) return t("Group");
    const member = usersMap().get(entry.userId);
    if (member?.email) return member.email;
    return member?.name ? "" : `id ${entry.userId.slice(0, 8)}`;
  }

  function accessSourceLabel(entry: DocumentAccessEntry): string {
    const { resourceType, resourceLabel, inherited } = entry.via;
    return resourceType === "document"
      ? t("Granted on this document")
      : resourceType === "document_tree"
        ? inherited
          ? t("Via document tree: {document}").replace(
              "{document}",
              resourceLabel || t("parent document"),
            )
          : t("Granted on this document and child documents")
        : resourceType === "category"
          ? t("Via category: {category}").replace(
              "{category}",
              resourceLabel || t("category"),
            )
          : t("Via space membership");
  }

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

  const directAccess = createMemo(() =>
    sortedDocumentAccess().filter((entry) => !entry.via.inherited),
  );
  const inheritedAccess = createMemo(() =>
    sortedDocumentAccess().filter((entry) => entry.via.inherited),
  );

  const accessHeading = createMemo(() => {
    const total = sortedDocumentAccess().length;
    if (total === 0) return t("People with access");
    return total === 1
      ? t("1 person with access")
      : t("{count} people with access").replace("{count}", String(total));
  });

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

  const activeScope = createMemo(() =>
    shareMode() === "people" ? scope() : linkScope(),
  );

  function setActiveScope(value: string) {
    if (shareMode() === "people") {
      setScope(value);
      if (value === "document" || value === "document_tree") {
        setLinkScope(value);
      }
      return;
    }

    const documentScope = value as DocumentPermissionResource;
    setLinkScope(documentScope);
    setScope(documentScope);
  }

  // The hidden label sizes the select to its current option rather than its widest one.
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

  const RowDivider = () => (
    <span aria-hidden="true" class="h-4 w-px flex-none bg-neutral-100" />
  );

  const GroupLabel = (labelProps: { label: string }) => (
    <div class="mt-4xs mb-6xs flex items-center gap-4xs">
      <span class="flex-none text-neutral-400 text-size-small">{labelProps.label}</span>
      <span aria-hidden="true" class="h-px flex-1 bg-neutral-100" />
    </div>
  );

  const GroupToggle = (toggleProps: {
    label: string;
    open: boolean;
    onToggle: () => void;
  }) => (
    <button
      type="button"
      aria-expanded={toggleProps.open}
      class="mt-2 grid w-full grid-cols-[28px_auto] items-center justify-start gap-4xs rounded-lg py-1 text-neutral-400 transition-colors hover:text-neutral-600"
      onClick={toggleProps.onToggle}
    >
      <Icon
        class={`h-3 w-3 justify-self-center transition-transform ${toggleProps.open ? "" : "-rotate-90"}`}
        name="chevron-down"
      />
      <span class="flex-none text-size-small">{toggleProps.label}</span>
    </button>
  );

  const PermissionRow = (rowProps: { entry: DocumentAccessEntry }) => {
    const detail = () => accessDetail(rowProps.entry);
    const removable = () =>
      directGrants(rowProps.entry).length > 0 &&
      rowProps.entry.userId !== user()?.id &&
      (userIsOwner() || !rowProps.entry.groupId);

    return (
      <div class="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-4xs py-1">
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
        <div class="flex flex-none items-center justify-end gap-2">
          <RoleBadge role={rowProps.entry.permission} />
          <Show when={removable()}>
            <button
              type="button"
              class="rounded-md px-1.5 py-0.5 text-neutral-400 text-size-small transition-colors hover:bg-red-500/10 hover:text-red-500"
              onClick={() => void removeDocumentAccess(rowProps.entry)}
            >
              {t("Remove")}
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

  const LoadError = (errorProps: { message: string; onRetry: () => void }) => (
    <div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/10 p-3xs">
      <p class="text-red-500 text-size-small">{errorProps.message}</p>
      <button
        type="button"
        class="mt-1 text-red-500 text-size-small underline"
        onClick={errorProps.onRetry}
      >
        {t("Try again")}
      </button>
    </div>
  );

  const ShareModeSwitch = () => (
    <div class="inline-flex rounded-lg bg-neutral-100 p-1">
      <button
        type="button"
        class={`rounded-md px-3 py-1.5 font-medium text-size-small transition-colors ${
          shareMode() === "people"
            ? "bg-background text-neutral-900 shadow-xs"
            : "text-neutral-500 hover:text-neutral-800"
        }`}
        onClick={() => setShareMode("people")}
      >
        {t("Invite people")}
      </button>
      <button
        type="button"
        class={`rounded-md px-3 py-1.5 font-medium text-size-small transition-colors ${
          shareMode() === "link"
            ? "bg-background text-neutral-900 shadow-xs"
            : "text-neutral-500 hover:text-neutral-800"
        }`}
        onClick={() => setShareMode("link")}
      >
        {t("Share a link")}
      </button>
    </div>
  );

  return (
    <Dialog
      show={props.show}
      maxWidth="md:max-w-lg"
      bodyClass="p-0 overflow-y-auto"
      onUpdateShow={(value) => props.onUpdateShow?.(value)}
      header={
        <div class="relative flex min-h-10 min-w-0 flex-1 items-center">
          <div class="max-w-32 min-w-0">
            <h2 class="font-semibold text-neutral-900 text-size-title leading-tight">
              {t("Share")}
            </h2>
          </div>
          <Show when={canManageLinks()}>
            <div class="absolute top-1/2 left-[calc(50%+1.25rem)] hidden -translate-x-1/2 -translate-y-1/2 sm:block">
              <ShareModeSwitch />
            </div>
          </Show>
        </div>
      }
    >
      <div class="px-5 pt-2 pb-5">
        <Show when={canManageLinks()}>
          <div class="mb-3 flex justify-center sm:hidden">
            <ShareModeSwitch />
          </div>
        </Show>
        <div class="mb-3 flex justify-center">
          <div class="flex items-center gap-1 text-neutral-500 text-size-small">
            <span class="flex-none">{t("Applies to")}</span>
            <QuietSelect
              value={activeScope()}
              ariaLabel={t("What this share applies to")}
              options={documentScopeOptions(props.documentTitle)}
              groups={shareMode() === "people" ? categoryScopeGroups() : undefined}
              onChange={setActiveScope}
            />
          </div>
        </div>

        <Show when={shareMode() === "people"}>
          <form onSubmit={(e) => void handleInvite(e)}>
          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4xs">
            <div class="flex min-w-0 items-center rounded-lg border border-neutral-200 bg-background shadow-xs transition-colors focus-within:border-primary-300 focus-within:ring-2 focus-within:ring-primary-100">
              <input
                id="share-email"
                value={newMemberEmail()}
                onInput={(e) => setNewMemberEmail(e.currentTarget.value)}
                type="email"
                required
              placeholder={t("person@example.com")}
                class="h-10 min-w-0 flex-1 bg-transparent px-3xs text-neutral-900 text-size-medium outline-none placeholder:text-neutral-400"
              />
              <RowDivider />
              <div class="mr-1">
                <QuietSelect
                  value={newMemberRole()}
                  ariaLabel={t("Access to grant")}
                  options={roleOptions}
                  onChange={setNewMemberRole}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={addingMember() || !newMemberEmail().trim()}
              class="button-primary h-10 px-4"
            >
              {addingMember() ? "…" : t("Invite")}
            </button>
          </div>

          <Show when={addMemberError()}>
            <p class="mt-5xs text-red-500 text-size-small">{addMemberError()}</p>
          </Show>
          </form>
        </Show>

        <Show when={canManageLinks() && shareMode() === "link"}>
          <section>
            <form onSubmit={(e) => void handleCreateLink(e)}>
              <div class="grid sm:grid-cols-[3fr_5fr_auto]">
                <div class="flex min-w-0 items-center gap-3 py-2 sm:pr-4">
                  <Icon class="h-5 w-5 flex-none text-neutral-500" name="date" />
                  <div class="min-w-0 flex-1">
                    <div class="text-neutral-500 text-size-extra-small">
                      {t("Expires in")}
                    </div>
                    <div class="-ml-1.5">
                      <QuietSelect
                        value={String(linkExpiryDays())}
                        ariaLabel={t("When the link expires")}
                        options={linkExpiryOptions()}
                        onChange={(value) => setLinkExpiryDays(Number(value))}
                      />
                    </div>
                  </div>
                </div>

                <div class="flex min-w-0 items-center gap-3 border-neutral-100 border-t py-2 sm:border-t-0 sm:border-l sm:px-4">
                  <Icon class="h-5 w-5 flex-none text-neutral-500" name="lock-element" />
                  <div class="min-w-0 flex-1">
                    <div class="text-neutral-500 text-size-extra-small">
                      {t("Password")}
                    </div>
                    <div class="font-medium text-neutral-800 text-size-small">
                      {wantsLinkPassword() ? t("Enabled") : t("Add password")}
                    </div>
                  </div>
                  <SwitchToggle
                    value={wantsLinkPassword()}
                    ariaLabel={t("Add a password to the link")}
                    onInput={(enabled) => {
                      setWantsLinkPassword(enabled);
                      if (!enabled) setLinkPassword("");
                    }}
                  />
                </div>

                <div class="flex items-center justify-center border-neutral-100 border-t py-2 sm:border-t-0 sm:border-l sm:pl-4">
                  <button
                    type="submit"
                    disabled={creatingLink()}
                    class="button-primary whitespace-nowrap"
                  >
                    {creatingLink() ? "…" : t("Create link")}
                  </button>
                </div>
              </div>

              <Show when={wantsLinkPassword()}>
                <input
                  value={linkPassword()}
                  onInput={(e) => setLinkPassword(e.currentTarget.value)}
                  type="password"
                  autocomplete="new-password"
                  minLength={MIN_LINK_PASSWORD_LENGTH}
                  aria-label={t("Link password")}
                  placeholder={t("Password, {count}+ characters").replace(
                    "{count}",
                    String(MIN_LINK_PASSWORD_LENGTH),
                  )}
                  class="mt-3 h-9 w-full rounded-lg border border-neutral-200 bg-background px-3 text-neutral-900 text-size-small outline-none transition-colors placeholder:text-neutral-400 focus-visible:border-primary-300 focus-visible:ring-2 focus-visible:ring-primary-100"
                />
              </Show>

              <p class="mt-3 text-left text-neutral-500 text-size-small">
                {t("Anyone with the link gets read-only access without an account.")}
              </p>

              <Show when={linkError()}>
                <p class="mt-5xs text-red-500 text-size-small">{linkError()}</p>
              </Show>

            </form>

            <Show when={links().length > 0}>
              <div>
                <GroupLabel
                  label={
                    links().length === 1
                      ? t("1 active link")
                      : t("{count} active links").replace(
                          "{count}",
                          String(links().length),
                        )
                  }
                />
                <For each={links()}>
                  {(link) => (
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
                        {copiedLinkId() === link.id ? t("Copied") : t("Copy")}
                      </button>
                      <button
                        type="button"
                        class="flex-none rounded-md px-1.5 py-0.5 text-neutral-400 text-size-small transition-colors hover:bg-red-500/10 hover:text-red-500"
                        onClick={() => void revokeLink(link)}
                      >
                        {t("Revoke")}
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>

        <section class="mt-5 border-neutral-100 border-t pt-4">
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
                    {t("No one has access to this document yet.")}
                  </p>
                }
              >
                <div class="mt-2 max-h-72 overflow-y-auto pr-1">
                  <For each={directAccess()}>
                    {(entry) => <PermissionRow entry={entry} />}
                  </For>

                  <Show when={inheritedAccess().length > 0}>
                    <GroupToggle
                      label={t("Inherited ({count})").replace(
                        "{count}",
                        String(inheritedAccess().length),
                      )}
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
      </div>
    </Dialog>
  );
}
