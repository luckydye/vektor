import { createEffect, createMemo, createSignal, For, Index, on, Show } from "solid-js";
import {
  Feature,
  highestPermission,
  isOwner,
  Permission,
  permissionLevel,
  ResourceType,
} from "#acl/permissions.ts";
import type {
  AccessToken,
  Category,
  DocumentWithProperties,
  PermissionEntry,
  User,
} from "#api/client.ts";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import {
  roleBadgeClass,
  roleLabel,
  tokenRole,
  tokenStatus,
  tokenStatusClass,
} from "#utils/accessToken.ts";
import { formatAbsoluteDate, formatDate } from "#utils/dateFormat.ts";
import { Button } from "./Button.tsx";
import { FilterSelect, type FilterSelectOption } from "./FilterSelect.tsx";
import "./AvatarElement.ts";
import { Icon } from "./Icon.tsx";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";

/** Scope select values that carry the id of the resource a grant lands on. */
const CATEGORY_SCOPE_PREFIX = "category:";
const DOCUMENT_SCOPE_PREFIX = "document:";

interface MemberAccess {
  key: string;
  primaryPermission: PermissionEntry;
  grants: PermissionEntry[];
  spaceGrant?: PermissionEntry;
  categoryGrants: PermissionEntry[];
  highestRole: string;
}

type InviteeType = "user" | "group" | "token";

interface InviteRow {
  id: string;
  type: InviteeType;
  value: string;
  role: string;
  scope: string;
  includeChildren: boolean;
  expiresInDays: number | null;
}

function getHighestRole(grants: PermissionEntry[]): string {
  return (
    highestPermission(grants.map((grant) => grant.permission.permission)) ??
    Permission.VIEWER
  );
}

function getDocumentLabel(document: DocumentWithProperties): string {
  const title = document.properties?.title || document.properties?.name;
  return (Array.isArray(title) ? title[0] : title) || document.slug;
}

function isScopedGrant(grant: PermissionEntry): boolean {
  return ["document", "document_tree"].includes(grant.permission.resourceType ?? "");
}

/** Owner is only grantable on the space, so only a space grant may offer it. */
function isSpaceGrant(grant: PermissionEntry): boolean {
  const { resourceType } = grant.permission;
  return !resourceType || resourceType === "space";
}

function tokenResourceLabel(resource: {
  resourceType: string;
  resourceId: string;
}): string {
  if (resource.resourceType === ResourceType.FEATURE) {
    return resource.resourceId === Feature.MANAGE_EXTENSIONS
      ? "Extensions (install/update)"
      : `Feature: ${resource.resourceId}`;
  }
  if (resource.resourceType === ResourceType.SPACE) return "Entire space";
  return `${resource.resourceType}: ${resource.resourceId}`;
}

export function SpaceMembers() {
  const t = useTranslation();
  const lang = useLocale();

  const { currentSpace, currentSpaceId } = useSpace();
  const user = useUserProfile();

  const [permissions, setPermissions] = createSignal<PermissionEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [inviteRows, setInviteRows] = createSignal<InviteRow[]>([]);
  const [sendingInvites, setSendingInvites] = createSignal(false);
  const [inviteError, setInviteError] = createSignal<string | null>(null);
  const [updatingMember, setUpdatingMember] = createSignal<string | null>(null);
  const [removingMember, setRemovingMember] = createSignal<string | null>(null);
  const [usersMap, setUsersMap] = createSignal(new Map<string, User>());
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [documents, setDocuments] = createSignal<DocumentWithProperties[]>([]);
  const [loadingUsers, setLoadingUsers] = createSignal(false);
  const [copiedUserId, setCopiedUserId] = createSignal<string | null>(null);
  const [expandedMembers, setExpandedMembers] = createSignal(new Set<string>());
  const [inviteSuggestions, setInviteSuggestions] = createSignal<User[]>([]);
  const [suggestionRowId, setSuggestionRowId] = createSignal<string | null>(null);
  const [accessTokens, setAccessTokens] = createSignal<AccessToken[]>([]);
  const [createdTokenValue, setCreatedTokenValue] = createSignal<string | null>(null);
  const [tokenCopied, setTokenCopied] = createSignal(false);
  let nextInviteRowId = 0;

  async function fetchAllDocuments(spaceId: string) {
    const all: DocumentWithProperties[] = [];
    let cursor: string | undefined;

    do {
      const response = await api.documents.get(spaceId, { limit: 500, cursor });
      all.push(...response.documents);
      cursor = response.nextCursor || undefined;
    } while (cursor);

    return all;
  }

  async function fetchPermissions() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      const [spaceResponse, categoryList, documentList] = await Promise.all([
        api.permissions.list(spaceId, "role", { allResources: true }),
        api.categories.get(spaceId),
        fetchAllDocuments(spaceId),
      ]);

      setCategories(categoryList?.categories || []);
      setDocuments(documentList);
      setPermissions(spaceResponse.permissions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch permissions");
      console.error("Failed to fetch permissions:", err);
    } finally {
      setIsLoading(false);
    }
  }

  /**
   * Tokens are ACL rows, but they are read from their own endpoint rather than
   * the permission listing: that is where a token's name, expiry and last use
   * live, and a feature-scoped token has no role grant to list.
   */
  async function fetchAccessTokens() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    try {
      const response = await api.accessTokens.get(spaceId);
      setAccessTokens(response.tokens || []);
    } catch {
      setAccessTokens([]);
    }
  }

  async function handleRevokeToken(tokenId: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm("Revoke this token? Anything using it stops working immediately."))
      return;
    setError(null);
    try {
      await api.accessTokens.revoke(spaceId, tokenId);
      await fetchAccessTokens();
    } catch {
      setError("Failed to revoke token");
    }
  }

  async function handleDeleteToken(tokenId: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm("Delete this token and its access?")) return;
    setError(null);
    try {
      await api.accessTokens.delete(spaceId, tokenId);
      await Promise.all([fetchAccessTokens(), fetchPermissions()]);
    } catch {
      setError("Failed to delete token");
    }
  }

  async function handleCopyToken() {
    const value = createdTokenValue();
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setTokenCopied(true);
  }

  async function fetchUsers() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setLoadingUsers(true);
    try {
      const members = await api.spaceMembers.get(spaceId);

      const map = new Map<string, User>();
      for (const member of members) {
        if (member.user) map.set(member.user.id, member.user);
      }
      setUsersMap(map);
    } catch (err) {
      console.error("Failed to fetch users:", err);
    } finally {
      setLoadingUsers(false);
    }
  }

  async function fetchInviteSuggestions() {
    try {
      const suggestions = await api.users.inviteSuggestions();
      setInviteSuggestions(suggestions);
    } catch (err) {
      console.error("Failed to fetch invite suggestions:", err);
      setInviteSuggestions([]);
    }
  }

  createEffect(
    on(currentSpaceId, () => {
      void fetchPermissions();
      void fetchUsers();
      void fetchAccessTokens();
      void fetchInviteSuggestions();
      setInviteRows([]);
      setInviteError(null);
      setSuggestionRowId(null);
    }),
  );

  useSync(currentSpaceId, [realtimeTopics.acl], (topics) => {
    if (!topics.includes(realtimeTopics.acl)) return;
    void Promise.all([fetchPermissions(), fetchUsers()]);
  });

  const rolePermissions = createMemo(() =>
    permissions().filter((p) => p.type === "role"),
  );

  const existingMemberIds = createMemo(
    () =>
      new Set(
        rolePermissions()
          .map((perm) => perm.permission.userId)
          .filter((id): id is string => !!id),
      ),
  );

  function filteredInviteSuggestions(row: InviteRow): User[] {
    const query = row.value.trim().toLowerCase();
    const members = existingMemberIds();
    const selectedEmails = new Set(
      inviteRows()
        .filter((invite) => invite.id !== row.id && invite.type === "user")
        .map((invite) => invite.value.trim().toLowerCase()),
    );
    return inviteSuggestions()
      .filter((suggestion) => !members.has(suggestion.id))
      .filter((suggestion) => !selectedEmails.has(suggestion.email.toLowerCase()))
      .filter((suggestion) => {
        if (!query) return true;
        return (
          suggestion.name.toLowerCase().includes(query) ||
          suggestion.email.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }

  function selectSuggestion(rowId: string, suggestion: User) {
    updateInviteRow(rowId, { value: suggestion.email });
    setSuggestionRowId(null);
  }

  function getMemberUser(perm: PermissionEntry): User | undefined {
    if (!perm.permission.userId) return undefined;
    return usersMap().get(perm.permission.userId);
  }

  function getMemberName(perm: PermissionEntry): string {
    if (perm.permission.userId) {
      const userData = getMemberUser(perm);
      return userData?.name || userData?.email || perm.permission.userId;
    }
    return perm.permission.groupId ?? "";
  }

  function getMemberEmail(perm: PermissionEntry): string {
    if (perm.permission.userId) return getMemberUser(perm)?.email || "";
    return "";
  }

  function getMemberType(perm: PermissionEntry): string {
    return perm.permission.userId ? "User" : "Group";
  }

  /** The role a user holds today, for comparing a token against its issuer. */
  function roleOfUser(userId: string): string | undefined {
    return memberAccess().find((member) => member.key === `user:${userId}`)?.highestRole;
  }

  /**
   * Who delegated this token — and, when their role has since dropped below what
   * the token was granted, what it is actually limited to now.
   */
  function tokenIssuerLabel(token: AccessToken): string {
    const issuerId = token.createdBy;
    if (!issuerId) return "Issuer unknown";

    const issuer = usersMap().get(issuerId);
    const name = issuer?.name || issuer?.email || issuerId;
    const issuerRole = roleOfUser(issuerId);
    const ceiling = tokenRole(token);

    if (issuerRole && permissionLevel(issuerRole) < permissionLevel(ceiling)) {
      return `Issued by ${name} · limited to ${issuerRole}`;
    }
    return `Issued by ${name}`;
  }

  // Space-wide membership and group grants are owner-only on the API, so a
  // non-owner is offered neither.
  const userIsOwner = createMemo(() => isOwner(currentSpace()?.userRole));

  /** Space-wide is the only scope that needs no id, so it is the only default. */
  function defaultScope() {
    return userIsOwner() ? "space" : "";
  }

  function createInviteRow(): InviteRow {
    return {
      id: `invite-${++nextInviteRowId}`,
      type: "user",
      value: "",
      role: Permission.VIEWER,
      scope: defaultScope(),
      includeChildren: false,
      expiresInDays: null,
    };
  }

  function updateInviteRow(id: string, update: Partial<InviteRow>) {
    setInviteRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...update } : row)),
    );
  }

  function addInviteRow() {
    setInviteRows((rows) => [...rows, createInviteRow()]);
  }

  function removeInviteRow(id: string) {
    setInviteRows((rows) => {
      if (rows.length === 1) return [];
      return rows.filter((row) => row.id !== id);
    });
    if (suggestionRowId() === id) setSuggestionRowId(null);
  }

  /** Turns an invite row's scope into the resource its grant is written to. */
  function grantTarget(row: InviteRow) {
    const value = row.scope;
    if (value.startsWith(CATEGORY_SCOPE_PREFIX)) {
      return {
        resourceType: "category" as const,
        resourceId: value.slice(CATEGORY_SCOPE_PREFIX.length),
      };
    }
    if (value.startsWith(DOCUMENT_SCOPE_PREFIX)) {
      return {
        resourceType: row.includeChildren
          ? ("document_tree" as const)
          : ("document" as const),
        resourceId: value.slice(DOCUMENT_SCOPE_PREFIX.length),
      };
    }
    return {};
  }

  /** Access tokens use the same space/category/document scope picker as members. */
  function tokenTarget(row: InviteRow, spaceId: string) {
    const target = grantTarget(row);
    return {
      resourceType:
        target.resourceType === "document_tree"
          ? "document"
          : (target.resourceType ?? "space"),
      resourceId: target.resourceId ?? spaceId,
    };
  }

  const memberAccess = createMemo<MemberAccess[]>(() => {
    const accessByMember = new Map<
      string,
      { key: string; primaryPermission: PermissionEntry; grants: PermissionEntry[] }
    >();

    for (const perm of rolePermissions()) {
      const memberId = perm.permission.userId || perm.permission.groupId;
      if (!memberId) continue;
      // Tokens are grants too, but they are listed from the token endpoint
      // below, which knows their name and whether they still work.
      if (perm.permission.kind) continue;

      const key = `${perm.permission.userId ? "user" : "group"}:${memberId}`;
      const existing = accessByMember.get(key);
      if (existing) {
        existing.grants.push(perm);
        continue;
      }

      accessByMember.set(key, { key, primaryPermission: perm, grants: [perm] });
    }

    return [...accessByMember.values()]
      .map((member) => ({
        ...member,
        spaceGrant: member.grants.find(
          (grant) =>
            !grant.permission.resourceType || grant.permission.resourceType === "space",
        ),
        categoryGrants: member.grants.filter(
          (grant) => grant.permission.resourceType === "category",
        ),
        highestRole: getHighestRole(member.grants),
      }))
      .sort((a, b) =>
        getMemberName(a.primaryPermission).localeCompare(
          getMemberName(b.primaryPermission),
        ),
      );
  });

  const documentsById = createMemo(
    () => new Map(documents().map((document) => [document.id, document])),
  );

  const documentScopeOptions = createMemo(() =>
    documents()
      .map((document) => ({ id: document.id, label: getDocumentLabel(document) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  const scopeOptions = createMemo<FilterSelectOption[]>(() => [
    ...(userIsOwner() ? [{ value: "space", label: t("Entire space") }] : []),
    ...categories().map((category) => ({
      value: `${CATEGORY_SCOPE_PREFIX}${category.id}`,
      label: category.name,
      group: t("Category"),
    })),
    ...documentScopeOptions().map((document) => ({
      value: `${DOCUMENT_SCOPE_PREFIX}${document.id}`,
      label: document.label,
      group: t("Document"),
    })),
  ]);

  async function handleInviteRows(e: Event) {
    e.preventDefault();

    const spaceId = currentSpace()?.id;
    if (!spaceId) return;

    const rows = inviteRows().filter((row) => row.value.trim());
    if (rows.length === 0) {
      setInviteError(t("Add at least one person or group"));
      return;
    }

    if (
      rows.some(
        (row) => !row.scope && !(row.type === "token" && row.role === "extensions"),
      )
    ) {
      setInviteError(t("Select what to give access to"));
      return;
    }

    const tokenRows = rows.filter((row) => row.type === "token");
    if (tokenRows.length > 1) {
      setInviteError(t("Create one token at a time so its value can be copied safely"));
      return;
    }

    const emailCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.type !== "user") continue;
      const email = row.value.trim().toLowerCase();
      emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    }
    if ([...emailCounts.values()].some((count) => count > 1)) {
      setInviteError(t("Each person can only be invited once"));
      return;
    }

    setSendingInvites(true);
    setInviteError(null);

    try {
      const tokenRow = tokenRows[0];
      const [, tokenResult] = await Promise.all([
        Promise.all(
          rows
            .filter((row) => row.type !== "token")
            .map((row) =>
              api.permissions.grant(spaceId, {
                type: "role",
                roleOrFeature: row.role,
                ...(row.type === "group"
                  ? { groupId: row.value.trim() }
                  : { email: row.value.trim() }),
                ...grantTarget(row),
              }),
            ),
        ),
        tokenRow
          ? api.accessTokens.create(spaceId, {
              name: tokenRow.value.trim(),
              permission: tokenRow.role,
              ...(tokenRow.role === "extensions" ? {} : tokenTarget(tokenRow, spaceId)),
              ...(tokenRow.expiresInDays
                ? { expiresInDays: tokenRow.expiresInDays }
                : {}),
            })
          : Promise.resolve(null),
      ]);

      setInviteRows([]);
      if (tokenResult) {
        setCreatedTokenValue(tokenResult.token);
        setTokenCopied(false);
      }
      await Promise.all([fetchPermissions(), fetchUsers(), fetchAccessTokens()]);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : t("Failed to send invites"));
      console.error("Failed to send invites:", err);
    } finally {
      setSendingInvites(false);
    }
  }

  async function handleRoleChange(perm: PermissionEntry, newRole: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;

    setUpdatingMember(perm.permission.userId || perm.permission.groupId || null);

    try {
      const isGroup = !!perm.permission.groupId;
      await api.permissions.grant(spaceId, {
        type: "role",
        roleOrFeature: newRole,
        ...(isGroup
          ? { groupId: perm.permission.groupId }
          : { userId: perm.permission.userId }),
        ...(perm.permission.resourceType && perm.permission.resourceType !== "space"
          ? {
              resourceType: perm.permission.resourceType,
              resourceId: perm.permission.resourceId,
            }
          : {}),
      });
      await fetchPermissions();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setUpdatingMember(null);
    }
  }

  async function handleRemoveMember(perm: PermissionEntry) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;

    const memberId = perm.permission.userId || perm.permission.groupId;
    const memberType = perm.permission.userId ? "user" : "group";
    const isGroup = memberType === "group";

    if (!confirm(`Are you sure you want to remove this ${memberType}?`)) return;

    setRemovingMember(memberId ?? null);

    try {
      await api.permissions.revoke(spaceId, {
        type: "role",
        roleOrFeature: perm.permission.permission,
        ...(isGroup ? { groupId: memberId } : { userId: memberId }),
        ...(perm.permission.resourceType && perm.permission.resourceType !== "space"
          ? {
              resourceType: perm.permission.resourceType,
              resourceId: perm.permission.resourceId,
            }
          : {}),
      });
      await fetchPermissions();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove member");
    } finally {
      setRemovingMember(null);
    }
  }

  function getAccessSummary(member: MemberAccess): string {
    if (member.spaceGrant) return "Entire space";
    if (member.categoryGrants.length > 0) {
      const count = member.categoryGrants.length;
      return `${count} categor${count === 1 ? "y" : "ies"}`;
    }
    const count = member.grants.filter(isScopedGrant).length;
    if (count > 0) return `${count} page${count === 1 ? "" : "s"}`;
    return `${member.grants.length} resource${member.grants.length === 1 ? "" : "s"}`;
  }

  function getAccessDetail(member: MemberAccess): string {
    if (member.spaceGrant && member.categoryGrants.length > 0) {
      return `Plus ${member.categoryGrants.length} category override${member.categoryGrants.length === 1 ? "" : "s"}`;
    }
    if (member.spaceGrant) return "Space-wide access";
    if (member.categoryGrants.length > 0) return "Category-scoped access";
    if (member.grants.some(isScopedGrant)) return "Document-scoped access";
    return "Resource-scoped access";
  }

  function hasMixedRoles(member: MemberAccess): boolean {
    return new Set(member.grants.map((grant) => grant.permission.permission)).size > 1;
  }

  function toggleMemberDetails(memberKey: string) {
    const next = new Set(expandedMembers());
    if (next.has(memberKey)) next.delete(memberKey);
    else next.add(memberKey);
    setExpandedMembers(next);
  }

  function currentUserSpacePermission() {
    const me = user();
    if (!me) return undefined;
    return permissions().find(
      (p) =>
        p.type === "role" &&
        p.permission.userId === me.id &&
        p.permission.resourceType === "space",
    );
  }

  function canEditMember(userId: string | undefined): boolean {
    const me = user();
    if (!me || !currentSpace()) return false;
    if (me.id === userId) return false;

    const currentUserPerm = currentUserSpacePermission();
    if (!currentUserPerm) return false;

    // Owners may edit anyone else's membership.
    return isOwner(currentUserPerm.permission.permission);
  }

  function canRemoveMember(perm: PermissionEntry): boolean {
    const me = user();
    const space = currentSpace();
    if (!me || !space) return false;

    const memberId = perm.permission.userId;

    if (memberId === me.id) return false;

    if (isOwner(perm.permission.permission) && space.createdBy === memberId) {
      return false;
    }

    if (space.createdBy === me.id) return true;

    const currentUserPerm = currentUserSpacePermission();
    if (!currentUserPerm) return false;

    // Owners may remove anyone ranked strictly below them — never another owner.
    const currentUserRole = currentUserPerm.permission.permission;
    return (
      isOwner(currentUserRole) &&
      permissionLevel(currentUserRole) > permissionLevel(perm.permission.permission)
    );
  }

  function getResourceLabel(perm: PermissionEntry): string {
    const { resourceType, resourceId } = perm.permission;
    if (!resourceType || resourceType === "space") return "Entire space";
    if (resourceType === "category") {
      const category = categories().find((c) => c.id === resourceId);
      return category ? `Category: ${category.name}` : "Category";
    }
    if (resourceType === "document") {
      const document = documentsById().get(resourceId ?? "");
      return `Document: ${document ? getDocumentLabel(document) : resourceId}`;
    }
    if (resourceType === "document_tree") {
      const document = documentsById().get(resourceId ?? "");
      return `Document tree: ${document ? getDocumentLabel(document) : resourceId}`;
    }
    return `${resourceType}: ${resourceId}`;
  }

  async function copyMemberId(memberId: string) {
    try {
      await navigator.clipboard.writeText(memberId);
      setCopiedUserId(memberId);
      setTimeout(() => setCopiedUserId(null), 2000);
    } catch (err) {
      console.error("Failed to copy ID:", err);
    }
  }

  function getScopedGrants(member: MemberAccess): PermissionEntry[] {
    return member.grants.filter((grant) => grant !== member.spaceGrant);
  }

  function MemberGrantRow(props: { grant: PermissionEntry }) {
    const grantMemberId = () =>
      props.grant.permission.userId || props.grant.permission.groupId;

    return (
      <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 pl-6 pr-4 sm:pl-10">
        <div class="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <span class="truncate font-medium text-neutral-900">
            {getResourceLabel(props.grant)}
          </span>
          <span class="shrink-0 text-neutral-500 text-size-small">
            Added{" "}
            {props.grant.permission.createdAt
              ? formatDate(props.grant.permission.createdAt, lang)
              : "—"}
          </span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show
            when={canEditMember(props.grant.permission.userId)}
            fallback={
              <span
                class={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-size-small ${roleBadgeClass(props.grant.permission.permission)}`}
              >
                {props.grant.permission.permission}
              </span>
            }
          >
            <select
              value={props.grant.permission.permission}
              disabled={updatingMember() === grantMemberId()}
              class="focus-ring h-8 rounded-md border border-neutral-100 bg-background px-2 text-size-small"
              onChange={(event) =>
                void handleRoleChange(props.grant, event.currentTarget.value)
              }
            >
              <option value={Permission.VIEWER}>Viewer</option>
              <option value={Permission.EDITOR}>Editor</option>
              <Show when={isSpaceGrant(props.grant)}>
                <option value={Permission.OWNER}>Owner</option>
              </Show>
            </select>
          </Show>
          <Show when={canRemoveMember(props.grant)}>
            <button
              type="button"
              disabled={removingMember() === grantMemberId()}
              class="rounded-md px-2 py-1 text-neutral-500 text-size-small hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleRemoveMember(props.grant)}
            >
              {removingMember() === grantMemberId() ? "Removing..." : "Remove"}
            </button>
          </Show>
        </div>
      </div>
    );
  }

  return (
    <>
      <div class="flex flex-col gap-6">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold text-neutral-900 text-size-large">Access</h2>
        </div>

        {/*
          <div class="rounded-lg border border-neutral-200 bg-background p-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateToken();
              }}
              class="space-y-3"
            >
              <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label
                    for="token-name"
                    class="mb-1 block font-medium text-neutral-700 text-size-small"
                  >
                    Name
                  </label>
                  <input
                    id="token-name"
                    value={newTokenName()}
                    onInput={(e) => setNewTokenName(e.currentTarget.value)}
                    type="text"
                    required
                    placeholder="e.g. CI Deploy Token"
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                  />
                </div>
                <div>
                  <label
                    for="token-permission"
                    class="mb-1 block font-medium text-neutral-700 text-size-small"
                  >
                    Permission
                  </label>
                  <select
                    id="token-permission"
                    value={newTokenPermission()}
                    onChange={(e) => setNewTokenPermission(e.currentTarget.value)}
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                  >
                    <option value={Permission.VIEWER}>Viewer</option>
                    <option value={Permission.EDITOR}>Editor</option>
                    <option value="extensions">Extensions (install/update)</option>
                  </select>
                </div>
                <Show
                  when={newTokenPermission() !== "extensions"}
                  fallback={
                    <div class="self-center text-neutral-500 text-size-small md:col-span-2">
                      Grants space-wide permission to install and update extensions. No
                      resource needed.
                    </div>
                  }
                >
                  <div>
                    <label
                      for="token-resource-type"
                      class="mb-1 block font-medium text-neutral-700 text-size-small"
                    >
                      Resource Type
                    </label>
                    <select
                      id="token-resource-type"
                      value={newTokenResourceType()}
                      onChange={(e) => setNewTokenResourceType(e.currentTarget.value)}
                      class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                    >
                      <option value="space">Space</option>
                      <option value="document">Document</option>
                      <option value="extension">Extension</option>
                    </select>
                  </div>
                  <div>
                    <label
                      for="token-resource-id"
                      class="mb-1 block font-medium text-neutral-700 text-size-small"
                    >
                      Resource ID
                      <Show when={newTokenResourceType() === "space"}>
                        <span class="font-normal text-neutral-400">
                          (space ID auto-filled)
                        </span>
                      </Show>
                    </label>
                    <input
                      id="token-resource-id"
                      value={newTokenResourceId()}
                      onInput={(e) => setNewTokenResourceId(e.currentTarget.value)}
                      type="text"
                      required
                      disabled={newTokenResourceType() === "space"}
                      class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium disabled:bg-neutral-100 disabled:text-neutral-400"
                    />
                  </div>
                </Show>
                <div>
                  <label
                    for="token-expires"
                    class="mb-1 block font-medium text-neutral-700 text-size-small"
                  >
                    Expires in days{" "}
                    <span class="font-normal text-neutral-400">(optional)</span>
                  </label>
                  <input
                    id="token-expires"
                    value={newTokenExpiresInDays() ?? ""}
                    onInput={(e) =>
                      setNewTokenExpiresInDays(
                        e.currentTarget.value ? Number(e.currentTarget.value) : null,
                      )
                    }
                    type="number"
                    min="1"
                    placeholder="Never"
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                  />
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCreatingToken(false)}
                  class="px-3 py-1.5 text-neutral-600 text-size-medium hover:text-neutral-800"
                >
                  Cancel
                </button>
                <Button
                  type="submit"
                  disabled={isSubmittingToken()}
                  text={isSubmittingToken() ? "Creating..." : "Create Token"}
                />
              </div>
            </form>
          </div>
        */}

        <Show when={createdTokenValue()}>
          {(value) => (
            <div class="rounded-md border border-green-200 bg-green-50 p-3">
              <p class="mb-2 font-medium text-green-800 text-size-small">
                Token created — copy it now, it won't be shown again.
              </p>
              <div class="flex items-center gap-2">
                <code class="flex-1 select-all break-all rounded-sm border border-green-200 bg-background px-2 py-1.5 font-mono text-size-small">
                  {value()}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyToken()}
                  class="shrink-0 rounded-sm border border-green-300 bg-green-100 px-2 py-1.5 font-medium text-green-700 text-size-small hover:bg-green-200"
                >
                  {tokenCopied() ? "Copied!" : "Copy"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreatedTokenValue(null);
                  setTokenCopied(false);
                }}
                class="mt-2 text-green-700 text-size-small hover:text-green-900"
              >
                Dismiss
              </button>
            </div>
          )}
        </Show>

        <Show when={isLoading() || loadingUsers()}>
          <div class="overflow-hidden rounded-t-md border border-neutral-100 bg-background">
            <div class="grid grid-cols-[minmax(16rem,2fr)_minmax(7rem,0.7fr)_minmax(13rem,1.2fr)_minmax(7rem,0.7fr)_minmax(5rem,0.5fr)] gap-3 border-neutral-100 border-b bg-neutral-50 px-4 py-2.5">
              <div class="h-3 w-14 animate-pulse rounded bg-neutral-100" />
              <div class="h-3 w-10 animate-pulse rounded bg-neutral-100" />
              <div class="h-3 w-12 animate-pulse rounded bg-neutral-100" />
              <div class="h-3 w-10 animate-pulse rounded bg-neutral-100" />
              <div class="justify-self-end h-3 w-12 animate-pulse rounded bg-neutral-100" />
            </div>
            <For each={[0, 1, 2]}>
              {() => (
                <div class="grid grid-cols-[minmax(16rem,2fr)_minmax(7rem,0.7fr)_minmax(13rem,1.2fr)_minmax(7rem,0.7fr)_minmax(5rem,0.5fr)] items-center gap-3 border-neutral-100 border-b px-4 py-3 last:border-b-0">
                  <div class="flex items-center gap-3">
                    <div class="h-7 w-7 shrink-0 animate-pulse rounded-full bg-neutral-100" />
                    <div class="space-y-2">
                      <div class="h-3 w-32 animate-pulse rounded bg-neutral-100" />
                      <div class="h-2.5 w-44 animate-pulse rounded bg-neutral-100" />
                    </div>
                  </div>
                  <div class="h-3 w-10 animate-pulse rounded bg-neutral-100" />
                  <div class="space-y-2">
                    <div class="h-3 w-24 animate-pulse rounded bg-neutral-100" />
                    <div class="h-2.5 w-28 animate-pulse rounded bg-neutral-100" />
                  </div>
                  <div class="h-5 w-14 animate-pulse rounded-full bg-neutral-100" />
                  <div class="justify-self-end h-3 w-12 animate-pulse rounded bg-neutral-100" />
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={error()}>
          <div class="rounded-md border border-red-200 bg-red-50 p-4">
            <p class="text-red-600 text-size-medium">{error()}</p>
          </div>
        </Show>

        <form
          onSubmit={(event) => void handleInviteRows(event)}
          class="order-1 -mt-6 overflow-hidden rounded-b-md border border-neutral-100 border-t-0 bg-background"
        >
          <div class="divide-y divide-neutral-100">
            <Index each={inviteRows()}>
              {(row) => (
                <div class="grid grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] items-center gap-y-3 px-4 py-3 lg:grid-cols-[6.5rem_minmax(12rem,2fr)_minmax(8rem,1fr)_7.5rem_7rem_2.5rem]">
                  <div class="relative col-start-2 row-start-1 min-w-0 lg:col-start-2 lg:row-start-1">
                    <Show when={row().type !== "token"}>
                      <div class="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                        <Show
                          when={inviteSuggestions().find(
                            (suggestion) =>
                              suggestion.email.toLowerCase() ===
                              row().value.trim().toLowerCase(),
                          )}
                          fallback={<Icon class="h-4 w-4 text-neutral-400" name="people" />}
                        >
                          {(suggestion) => (
                            <vektor-avatar
                              size="24"
                              attr:user-id={suggestion().id}
                              prop:user={suggestion()}
                            />
                          )}
                        </Show>
                      </div>
                    </Show>
                    <input
                      value={row().value}
                      onInput={(event) => {
                        updateInviteRow(row().id, { value: event.currentTarget.value });
                        setSuggestionRowId(row().type === "user" ? row().id : null);
                      }}
                      onFocus={() => row().type === "user" && setSuggestionRowId(row().id)}
                      onBlur={() =>
                        setTimeout(() => {
                          if (suggestionRowId() === row().id) setSuggestionRowId(null);
                        }, 150)
                      }
                      type={row().type === "user" ? "email" : "text"}
                      autocomplete="off"
                      placeholder={
                        row().type === "user"
                          ? t("person@example.com")
                          : row().type === "group"
                            ? t("e.g., admins, developers")
                            : t("e.g., CI deploy token")
                      }
                      aria-label={t("Member")}
                      class={`focus-ring h-9 w-full rounded-md rounded-l-none border border-neutral-200 border-l-0 bg-background py-0 pr-2.5 text-neutral-900 text-size-medium ${row().type === "token" ? "pl-2.5" : "pl-10"}`}
                    />
                    <Show
                      when={
                        row().type === "user" &&
                        suggestionRowId() === row().id &&
                        filteredInviteSuggestions(row()).length > 0
                      }
                    >
                      <ul class="absolute z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-neutral-200 bg-background py-1 shadow-lg">
                        <For each={filteredInviteSuggestions(row())}>
                          {(suggestion) => (
                            <li>
                              <button
                                type="button"
                                class="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-neutral-50"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  selectSuggestion(row().id, suggestion);
                                }}
                              >
                                <vektor-avatar
                                  size="28"
                                  attr:user-id={suggestion.id}
                                  prop:user={suggestion}
                                />
                                <span class="min-w-0">
                                  <span class="block truncate text-neutral-900 text-size-medium">
                                    {suggestion.name}
                                  </span>
                                  <span class="block truncate text-neutral-400 text-size-small">
                                    {suggestion.email}
                                  </span>
                                </span>
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>

                  <select
                    value={row().type}
                    disabled={!userIsOwner()}
                    onChange={(event) => {
                      const type = event.currentTarget.value as InviteeType;
                      updateInviteRow(row().id, {
                        type,
                        value: "",
                        role: type === "token" ? Permission.EDITOR : Permission.VIEWER,
                        scope: type === "token" ? "space" : row().scope,
                        includeChildren: false,
                      });
                    }}
                    aria-label={t("Type")}
                    class="focus-ring col-start-1 row-start-1 h-9 w-full min-w-0 rounded-md rounded-r-none border border-neutral-200 bg-background px-2.5 py-0 text-neutral-900 text-size-medium disabled:cursor-default disabled:opacity-100 lg:col-start-1 lg:row-start-1"
                  >
                    <option value="user">{t("Person")}</option>
                    <Show when={userIsOwner()}>
                      <option value="group">{t("Group")}</option>
                      <option value="token">{t("Token")}</option>
                    </Show>
                  </select>

                  <div class="col-span-3 col-start-1 row-start-2 flex min-w-0 flex-col gap-2 lg:col-span-1 lg:col-start-3 lg:row-start-1 lg:ml-3">
                    <Show
                      when={!(row().type === "token" && row().role === "extensions")}
                      fallback={
                        <div class="flex min-h-8 items-center rounded-md border border-neutral-200 px-2.5 text-neutral-500 text-size-medium">
                          {t("Extensions (install/update)")}
                        </div>
                      }
                    >
                      <FilterSelect
                        id={`member-scope-${row().id}`}
                        class="h-9"
                        value={row().scope}
                        options={scopeOptions()}
                        placeholder={t("Select access")}
                        filterPlaceholder={t("Search pages and categories…")}
                        onChange={(value) =>
                          updateInviteRow(row().id, {
                            scope: value,
                            includeChildren: false,
                            role:
                              value === "space" || row().role !== Permission.OWNER
                                ? row().role
                                : Permission.VIEWER,
                          })
                        }
                      />
                    </Show>
                    <Show
                      when={
                        row().type !== "token" &&
                        row().scope.startsWith(DOCUMENT_SCOPE_PREFIX)
                      }
                    >
                      <select
                        value={row().includeChildren ? "tree" : "single"}
                        onChange={(event) =>
                          updateInviteRow(row().id, {
                            includeChildren: event.currentTarget.value === "tree",
                          })
                        }
                        aria-label={t("Documents")}
                        class="focus-ring w-full rounded-md border border-neutral-200 bg-background px-2.5 py-1.5 text-neutral-900 text-size-small"
                      >
                        <option value="single">{t("This document")}</option>
                        <option value="tree">{t("This document and child documents")}</option>
                      </select>
                    </Show>
                  </div>

                  <select
                    value={row().role}
                    onChange={(event) =>
                      updateInviteRow(row().id, { role: event.currentTarget.value })
                    }
                    aria-label={t("Role")}
                    class={`focus-ring row-start-3 h-9 w-full min-w-0 rounded-md border border-neutral-200 bg-background px-2.5 py-0 text-neutral-900 text-size-medium lg:col-span-1 lg:col-start-4 lg:row-start-1 lg:ml-3 lg:w-[calc(100%_-_0.75rem)] ${row().type === "token" ? "col-start-1 rounded-r-none" : "col-span-3 col-start-1"}`}
                  >
                    <Show
                      when={row().type === "token"}
                      fallback={
                        <>
                          <option value={Permission.VIEWER}>
                            {roleLabel("viewer", lang)}
                          </option>
                          <option value={Permission.EDITOR}>
                            {roleLabel("editor", lang)}
                          </option>
                          <Show when={row().scope === "space"}>
                            <option value={Permission.OWNER}>
                              {roleLabel("owner", lang)}
                            </option>
                          </Show>
                        </>
                      }
                    >
                      <option value={Permission.VIEWER}>{roleLabel("viewer", lang)}</option>
                      <option value={Permission.EDITOR}>{roleLabel("editor", lang)}</option>
                      <option value="extensions">{t("Extensions")}</option>
                    </Show>
                  </select>

                  <div
                    class={`col-start-3 row-start-1 flex items-center justify-self-end self-center lg:row-start-1 ${row().type === "token" ? "lg:col-span-1 lg:col-start-6" : "lg:col-span-2 lg:col-start-5"}`}
                  >
                    <button
                      type="button"
                      class="flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                      onClick={() => removeInviteRow(row().id)}
                      aria-label={t("Remove")}
                      title={t("Remove")}
                    >
                      <Icon class="h-4 w-4" name="cancel" />
                    </button>
                  </div>
                  <Show when={row().type === "token"}>
                    <div class="col-span-2 col-start-2 row-start-3 flex h-9 min-w-0 items-center gap-1.5 rounded-md rounded-l-none border border-neutral-200 border-l-0 bg-background px-2 lg:col-span-1 lg:col-start-5 lg:row-start-1">
                      <Icon class="h-4 w-4 shrink-0 text-neutral-500" name="date" />
                      <div class="min-w-0 flex-1">
                        <select
                          value={String(row().expiresInDays ?? "")}
                          onChange={(event) =>
                            updateInviteRow(row().id, {
                              expiresInDays: event.currentTarget.value
                                ? Number(event.currentTarget.value)
                                : null,
                            })
                          }
                          aria-label={t("Expires in")}
                          class="focus-ring w-full border-0 bg-transparent p-0 font-medium text-neutral-900 text-size-small outline-none"
                        >
                          <option value="">{t("Never")}</option>
                          <option value="7">{t("7 days")}</option>
                          <option value="30">{t("30 days")}</option>
                          <option value="90">{t("90 days")}</option>
                        </select>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </Index>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 border-neutral-100 border-t px-4 py-3">
            <button
              type="button"
              onClick={addInviteRow}
              class="flex items-center gap-1.5 font-medium text-neutral-600 text-size-small hover:text-neutral-900"
            >
              <Icon class="h-4 w-4" name="add" />
              {inviteRows().length === 0 ? t("Add access") : t("Add another")}
            </button>
            <div class="flex items-center gap-3">
              <Show when={inviteError()}>
                <p class="text-red-500 text-size-small">{inviteError()}</p>
              </Show>
              <Button
                type="submit"
                text={sendingInvites() ? t("Saving…") : t("Save access")}
                disabled={sendingInvites() || inviteRows().length === 0}
              />
            </div>
          </div>
        </form>

        <Show
          when={
            !isLoading() &&
            !loadingUsers()
          }
        >
          <div class="overflow-x-auto rounded-t-md border border-neutral-100">
            <table class="min-w-full text-size-medium">
              <thead class="bg-neutral-50">
                <tr>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Member
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Type
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Access
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Role
                  </th>
                  <th class="px-4 py-2.5 text-right font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-100">
                <For each={memberAccess()}>
                  {(member) => (
                    <>
                      <tr
                        class={
                          expandedMembers().has(member.key)
                            ? "bg-neutral-50"
                            : "hover:bg-neutral-50"
                        }
                      >
                        <td class="px-4 py-2.5">
                          <div class="flex items-center gap-3">
                            <Show
                              when={member.primaryPermission.permission.userId}
                              fallback={
                                <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600">
                                  <Icon class="h-4 w-4 text-white" name="users" />
                                </div>
                              }
                            >
                              {(userId) => (
                                <vektor-avatar
                                  size="28"
                                  attr:user-id={userId()}
                                  prop:user={getMemberUser(member.primaryPermission)}
                                />
                              )}
                            </Show>
                            <div>
                              <div class="font-medium text-neutral-900">
                                {getMemberName(member.primaryPermission)}
                              </div>
                              <Show when={getMemberEmail(member.primaryPermission)}>
                                <div class="text-neutral-500 text-size-small">
                                  {getMemberEmail(member.primaryPermission)}
                                </div>
                              </Show>
                            </div>
                            <Show when={member.primaryPermission.permission.userId}>
                              {(userId) => (
                                <button
                                  type="button"
                                  title={
                                    copiedUserId() === userId() ? "Copied!" : "Copy ID"
                                  }
                                  class="p-1 text-neutral-400 transition-colors hover:text-neutral-600"
                                  onClick={() => void copyMemberId(userId())}
                                >
                                  <Show
                                    when={copiedUserId() === userId()}
                                    fallback={<Icon class="h-3.5 w-3.5" name="copy" />}
                                  >
                                    <Icon
                                      class="h-3.5 w-3.5 text-green-600"
                                      name="confirmation"
                                    />
                                  </Show>
                                </button>
                              )}
                            </Show>
                          </div>
                        </td>
                        <td class="whitespace-nowrap px-4 py-2.5 text-neutral-600">
                          {getMemberType(member.primaryPermission)}
                        </td>
                        <td class="px-4 py-2.5">
                          <div class="whitespace-nowrap font-medium text-neutral-800">
                            {getAccessSummary(member)}
                          </div>
                          <div class="text-neutral-500 text-size-small">
                            {getAccessDetail(member)}
                          </div>
                        </td>
                        <td class="whitespace-nowrap px-4 py-2.5">
                          <span
                            class={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-size-small ${roleBadgeClass(member.highestRole)}`}
                          >
                            {hasMixedRoles(member) ? "Mixed roles" : member.highestRole}
                          </span>
                        </td>
                        <td class="whitespace-nowrap px-4 py-2.5 text-right">
                          <button
                            type="button"
                            class="text-neutral-600 text-size-small hover:text-neutral-900"
                            aria-expanded={expandedMembers().has(member.key)}
                            onClick={() => toggleMemberDetails(member.key)}
                          >
                            {expandedMembers().has(member.key)
                              ? "Hide access"
                              : `${member.grants.length} grant${member.grants.length === 1 ? "" : "s"}`}
                          </button>
                        </td>
                      </tr>
                      <Show when={expandedMembers().has(member.key)}>
                        <tr>
                          <td colspan="5" class="p-0">
                            <div class="border-neutral-200 border-l-2 bg-neutral-50/60">
                              <Show when={member.spaceGrant}>
                                {(spaceGrant) => (
                                  <MemberGrantRow grant={spaceGrant()} />
                                )}
                              </Show>
                              <Show when={getScopedGrants(member).length > 0}>
                                <details
                                  open={!member.spaceGrant}
                                  class="group border-neutral-100 border-t"
                                >
                                  <summary class="flex cursor-pointer list-none items-center justify-between gap-3 bg-neutral-100/50 py-2 pl-6 pr-4 text-size-small hover:bg-neutral-100 sm:pl-10">
                                    <span class="flex items-center gap-2 font-medium text-neutral-700">
                                      <span
                                        aria-hidden="true"
                                        class="text-neutral-400 transition-transform group-open:rotate-90"
                                      >
                                        ›
                                      </span>
                                      {member.spaceGrant
                                        ? "Scoped overrides"
                                        : "Scoped access"}
                                    </span>
                                    <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-600 group-hover:bg-background">
                                      {getScopedGrants(member).length} grant
                                      {getScopedGrants(member).length === 1 ? "" : "s"}
                                    </span>
                                  </summary>
                                  <div class="divide-y divide-neutral-100 border-neutral-100 border-t">
                                    <For each={getScopedGrants(member)}>
                                      {(grant) => <MemberGrantRow grant={grant} />}
                                    </For>
                                  </div>
                                </details>
                              </Show>
                            </div>
                          </td>
                        </tr>
                      </Show>
                    </>
                  )}
                </For>
                <For each={accessTokens()}>
                  {(token) => (
                    <tr class="hover:bg-neutral-50">
                      <td class="px-4 py-2.5">
                        <div class="flex items-center gap-3">
                          <vektor-avatar
                            size="28"
                            attr:user-id={token.id}
                            kind="credential"
                          />
                          <div>
                            <div class="flex items-center gap-2">
                              <span class="font-medium text-neutral-900">
                                {token.name}
                              </span>
                              {/* Active is the default, so only say what is wrong. */}
                              <Show when={tokenStatus(token) !== "Active"}>
                                <span
                                  class={`rounded-sm px-1.5 py-0.5 text-size-small ${tokenStatusClass(tokenStatus(token))}`}
                                >
                                  {tokenStatus(token)}
                                </span>
                              </Show>
                            </div>
                            <div class="text-neutral-500 text-size-small">
                              {token.lastUsedAt
                                ? `Last used ${formatAbsoluteDate(token.lastUsedAt, lang)}`
                                : "Never used"}
                              {token.expiresAt
                                ? ` · Expires ${formatAbsoluteDate(token.expiresAt, lang)}`
                                : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-600">
                        Token
                      </td>
                      <td class="px-4 py-2.5">
                        <div class="whitespace-nowrap font-medium text-neutral-800">
                          <For each={token.resources}>
                            {(resource) => <span>{tokenResourceLabel(resource)}</span>}
                          </For>
                          <Show when={!token.resources?.length}>
                            <span class="text-neutral-400 italic">No access</span>
                          </Show>
                        </div>
                        <div class="text-neutral-500 text-size-small">
                          {tokenIssuerLabel(token)}
                        </div>
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5">
                        <span
                          class={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-size-small ${roleBadgeClass(tokenRole(token))}`}
                        >
                          {tokenRole(token)}
                        </span>
                      </td>
                      <td class="space-x-3 whitespace-nowrap px-4 py-2.5 text-right">
                        <Show when={userIsOwner()}>
                          <Show when={!token.revokedAt}>
                            <button
                              type="button"
                              onClick={() => void handleRevokeToken(token.id)}
                              class="text-red-600 text-size-small hover:text-red-800"
                            >
                              Revoke
                            </button>
                          </Show>
                          <button
                            type="button"
                            onClick={() => void handleDeleteToken(token.id)}
                            class="text-neutral-500 text-size-small hover:text-neutral-700"
                          >
                            Delete
                          </button>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show
          when={
            !isLoading() &&
            !loadingUsers() &&
            memberAccess().length === 0 &&
            accessTokens().length === 0 &&
            inviteRows().length === 0
          }
        >
          <div class="order-2 rounded-lg border border-neutral-100 py-12 text-center">
            <Icon class="mx-auto h-12 w-12 text-neutral-400" name="users-group" />
            <p class="mt-4 text-neutral-500">
              No members yet. Send an invite to get started.
            </p>
          </div>
        </Show>
      </div>
    </>
  );
}
