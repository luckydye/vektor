import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import {
  Feature,
  highestPermission,
  isCredentialPrincipal,
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
  tokenRole,
  tokenStatus,
  tokenStatusClass,
} from "#utils/accessToken.ts";
import { formatAbsoluteDate, formatDate } from "#utils/dateFormat.ts";
import { Button } from "./Button.tsx";
import "./AvatarElement.ts";
import { Icon } from "./Icon.tsx";

interface MemberAccess {
  key: string;
  primaryPermission: PermissionEntry;
  grants: PermissionEntry[];
  spaceGrant?: PermissionEntry;
  categoryGrants: PermissionEntry[];
  highestRole: string;
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

function documentBelongsToCategory(
  document: DocumentWithProperties,
  categorySlug: string,
  documentsById: Map<string, DocumentWithProperties>,
): boolean {
  const seen = new Set<string>();
  let current: DocumentWithProperties | undefined = document;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const categoryValues = [current.properties?.category, current.properties?.collection]
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter(Boolean);

    if (categoryValues.includes(categorySlug)) return true;
    current = current.parentId ? documentsById.get(current.parentId) : undefined;
  }

  return false;
}

function documentIsInTree(
  document: DocumentWithProperties,
  rootId: string,
  documentsById: Map<string, DocumentWithProperties>,
): boolean {
  const seen = new Set<string>();
  let current: DocumentWithProperties | undefined = document;

  while (current && !seen.has(current.id)) {
    if (current.id === rootId) return true;
    seen.add(current.id);
    current = current.parentId ? documentsById.get(current.parentId) : undefined;
  }

  return false;
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
  const { currentSpace, currentSpaceId } = useSpace();
  const user = useUserProfile();

  const [permissions, setPermissions] = createSignal<PermissionEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [showAddMember, setShowAddMember] = createSignal(false);
  const [newMemberId, setNewMemberId] = createSignal("");
  const [newMemberEmail, setNewMemberEmail] = createSignal("");
  const [newMemberType, setNewMemberType] = createSignal("user");
  const [newMemberRole, setNewMemberRole] = createSignal<string>(Permission.VIEWER);
  const [newMemberScope, setNewMemberScope] = createSignal("space");
  const [newMemberCategoryId, setNewMemberCategoryId] = createSignal("");
  const [addingMember, setAddingMember] = createSignal(false);
  const [addMemberError, setAddMemberError] = createSignal<string | null>(null);
  const [updatingMember, setUpdatingMember] = createSignal<string | null>(null);
  const [removingMember, setRemovingMember] = createSignal<string | null>(null);
  const [usersMap, setUsersMap] = createSignal(new Map<string, User>());
  const [categories, setCategories] = createSignal<Category[]>([]);
  const [documents, setDocuments] = createSignal<DocumentWithProperties[]>([]);
  const [loadingUsers, setLoadingUsers] = createSignal(false);
  const [copiedUserId, setCopiedUserId] = createSignal<string | null>(null);
  const [expandedMembers, setExpandedMembers] = createSignal(new Set<string>());
  const [inviteSuggestions, setInviteSuggestions] = createSignal<User[]>([]);
  const [showSuggestions, setShowSuggestions] = createSignal(false);
  const [accessTokens, setAccessTokens] = createSignal<AccessToken[]>([]);
  const [isCreatingToken, setIsCreatingToken] = createSignal(false);
  const [isSubmittingToken, setIsSubmittingToken] = createSignal(false);
  const [newTokenName, setNewTokenName] = createSignal("");
  const [newTokenPermission, setNewTokenPermission] = createSignal<string>(
    Permission.EDITOR,
  );
  const [newTokenResourceType, setNewTokenResourceType] = createSignal("space");
  const [newTokenResourceId, setNewTokenResourceId] = createSignal("");
  const [newTokenExpiresInDays, setNewTokenExpiresInDays] = createSignal<number | null>(
    null,
  );
  const [createdTokenValue, setCreatedTokenValue] = createSignal<string | null>(null);
  const [tokenCopied, setTokenCopied] = createSignal(false);

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

  function openCreateToken() {
    setIsCreatingToken(true);
    setShowAddMember(false);
    setNewTokenName("");
    setNewTokenPermission(Permission.EDITOR);
    setNewTokenResourceType("space");
    setNewTokenResourceId(currentSpace()?.id ?? "");
    setNewTokenExpiresInDays(null);
    setError(null);
  }

  async function handleCreateToken() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsSubmittingToken(true);
    setError(null);

    try {
      const isExtensionsCapability = newTokenPermission() === "extensions";
      const result = await api.accessTokens.create(spaceId, {
        name: newTokenName().trim(),
        permission: newTokenPermission(),
        ...(isExtensionsCapability
          ? {}
          : {
              resourceType: newTokenResourceType(),
              resourceId:
                newTokenResourceType() === "space"
                  ? spaceId
                  : newTokenResourceId().trim(),
            }),
        ...(newTokenExpiresInDays()
          ? { expiresInDays: newTokenExpiresInDays() as number }
          : {}),
      });
      setCreatedTokenValue(result.token);
      setTokenCopied(false);
      setIsCreatingToken(false);
      await Promise.all([fetchAccessTokens(), fetchPermissions()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setIsSubmittingToken(false);
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
    }),
  );

  useSync(currentSpaceId, [realtimeTopics.acl], (topics) => {
    if (!topics.includes(realtimeTopics.acl)) return;
    void Promise.all([fetchPermissions(), fetchUsers()]);
  });

  // The form opens pre-filled with the space id. Switching to another resource
  // type has to clear it, or that id rides along as the document/extension id
  // and mints a grant that matches nothing.
  createEffect(
    on(
      newTokenResourceType,
      (type) => {
        setNewTokenResourceId(type === "space" ? (currentSpace()?.id ?? "") : "");
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      showAddMember,
      (isOpen) => {
        setShowSuggestions(false);
        if (!isOpen) return;
        setAddMemberError(null);
        setNewMemberId("");
        setNewMemberEmail("");
        setNewMemberType("user");
        setNewMemberRole(Permission.VIEWER);
        setNewMemberScope("space");
        setNewMemberCategoryId("");
        void fetchInviteSuggestions();
      },
      { defer: true },
    ),
  );

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

  const filteredInviteSuggestions = createMemo<User[]>(() => {
    const query = newMemberEmail().trim().toLowerCase();
    const members = existingMemberIds();
    return inviteSuggestions()
      .filter((suggestion) => !members.has(suggestion.id))
      .filter((suggestion) => {
        if (!query) return true;
        return (
          suggestion.name.toLowerCase().includes(query) ||
          suggestion.email.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  });

  function selectSuggestion(suggestion: User) {
    setNewMemberEmail(suggestion.email);
    setShowSuggestions(false);
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

  function openAddMember() {
    setNewMemberType("user");
    setNewMemberRole(Permission.VIEWER);
    setNewMemberScope(userIsOwner() ? "space" : "category");
    setShowAddMember(true);
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
      if (isCredentialPrincipal(perm.permission.userId)) continue;

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

  const documentsByCategoryId = createMemo(
    () =>
      new Map(
        categories().map((category) => [
          category.id,
          documents().filter((document) =>
            documentBelongsToCategory(document, category.slug, documentsById()),
          ),
        ]),
      ),
  );

  async function handleAddMember(e: Event) {
    e.preventDefault();

    const spaceId = currentSpace()?.id;
    if (!spaceId) return;

    const isGroup = newMemberType() === "group";

    if (isGroup ? !newMemberId().trim() : !newMemberEmail().trim()) return;

    if (newMemberScope() === "category" && !newMemberCategoryId()) {
      setAddMemberError("Select a category");
      return;
    }

    setAddingMember(true);
    setAddMemberError(null);

    try {
      await api.permissions.grant(spaceId, {
        type: "role",
        roleOrFeature: newMemberRole(),
        ...(isGroup
          ? { groupId: newMemberId().trim() }
          : { email: newMemberEmail().trim() }),
        ...(newMemberScope() === "category"
          ? { resourceType: "category", resourceId: newMemberCategoryId() }
          : {}),
      });

      setShowAddMember(false);
      setNewMemberId("");
      setNewMemberEmail("");
      setNewMemberType("user");
      setNewMemberRole(Permission.VIEWER);
      setNewMemberScope(userIsOwner() ? "space" : "category");
      setNewMemberCategoryId("");
      await Promise.all([fetchPermissions(), fetchUsers()]);
    } catch (err) {
      setAddMemberError(err instanceof Error ? err.message : "Failed to add member");
      console.error("Failed to add member:", err);
    } finally {
      setAddingMember(false);
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
    if (member.grants.some(isScopedGrant)) return "Page-scoped access";
    return "Resource-scoped access";
  }

  function getAccessibleResourceGroups(member: MemberAccess) {
    if (member.spaceGrant) return [];

    const categoryGroups = member.categoryGrants.map((grant) => {
      const category = categories().find(
        (item) => item.id === grant.permission.resourceId,
      );
      return {
        id: grant.permission.resourceId ?? "",
        label: category?.name || "Category",
        documents: documentsByCategoryId().get(grant.permission.resourceId ?? "") || [],
      };
    });

    const documentGroups = member.grants.filter(isScopedGrant).map((grant) => {
      const resourceId = grant.permission.resourceId ?? "";
      const root = documentsById().get(resourceId);
      const isTree = grant.permission.resourceType === "document_tree";
      return {
        id: `${grant.permission.resourceType}:${resourceId}`,
        label: `${isTree ? "Page tree" : "Page"}: ${root ? getDocumentLabel(root) : resourceId}`,
        documents: root
          ? isTree
            ? documents().filter((document) =>
                documentIsInTree(document, root.id, documentsById()),
              )
            : [root]
          : [],
      };
    });

    return [...categoryGroups, ...documentGroups];
  }

  function getAccessibleDocumentCount(member: MemberAccess): number {
    return new Set(
      getAccessibleResourceGroups(member).flatMap((group) =>
        group.documents.map((document) => document.id),
      ),
    ).size;
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
      return `Page: ${document ? getDocumentLabel(document) : resourceId}`;
    }
    if (resourceType === "document_tree") {
      const document = documentsById().get(resourceId ?? "");
      return `Page tree: ${document ? getDocumentLabel(document) : resourceId}`;
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

  return (
    <>
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold text-neutral-900 text-size-large">Access</h2>
          <div class="flex items-center gap-3">
            <Show when={userIsOwner() && !isCreatingToken()}>
              <button
                type="button"
                onClick={openCreateToken}
                class="font-medium text-blue-600 text-size-small hover:text-blue-800"
              >
                + Create token
              </button>
            </Show>
            <Button text="Invite People" onClick={openAddMember} />
          </div>
        </div>

        <Show when={isCreatingToken()}>
          <div class="rounded-md border border-blue-200 bg-blue-50 p-3">
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
        </Show>

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
          <div class="flex justify-center py-8">
            <div class="h-8 w-8 animate-spin rounded-full border-blue-600 border-b-2" />
          </div>
        </Show>

        <Show when={error()}>
          <div class="rounded-md border border-red-200 bg-red-50 p-4">
            <p class="text-red-600 text-size-medium">{error()}</p>
          </div>
        </Show>

        <Show
          when={
            !isLoading() &&
            !loadingUsers() &&
            (memberAccess().length > 0 || accessTokens().length > 0)
          }
        >
          <div class="overflow-x-auto rounded-md border border-neutral-100">
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
                      <tr class="hover:bg-neutral-50">
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
                        <tr class="bg-neutral-50">
                          <td colspan="5" class="px-4 py-3">
                            <div class="ml-10 space-y-2 border-neutral-200 border-l-2 pl-4">
                              <For each={member.grants}>
                                {(grant) => (
                                  <div class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-100 bg-background px-3 py-2">
                                    <div>
                                      <div class="font-medium text-neutral-900">
                                        {getResourceLabel(grant)}
                                      </div>
                                      <div class="text-neutral-500 text-size-small">
                                        Added{" "}
                                        {grant.permission.createdAt
                                          ? formatDate(grant.permission.createdAt)
                                          : "—"}
                                      </div>
                                    </div>
                                    <div class="flex items-center gap-3">
                                      <Show
                                        when={canEditMember(grant.permission.userId)}
                                        fallback={
                                          <span
                                            class={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-size-small ${roleBadgeClass(grant.permission.permission)}`}
                                          >
                                            {grant.permission.permission}
                                          </span>
                                        }
                                      >
                                        <select
                                          value={grant.permission.permission}
                                          disabled={
                                            updatingMember() ===
                                            (grant.permission.userId ||
                                              grant.permission.groupId)
                                          }
                                          class="focus-ring rounded-md border border-neutral-100 px-2 py-1 text-size-medium"
                                          onChange={(e) =>
                                            void handleRoleChange(
                                              grant,
                                              e.currentTarget.value,
                                            )
                                          }
                                        >
                                          <option value={Permission.VIEWER}>
                                            Viewer
                                          </option>
                                          <option value={Permission.EDITOR}>
                                            Editor
                                          </option>
                                          <Show when={isSpaceGrant(grant)}>
                                            <option value={Permission.OWNER}>
                                              Owner
                                            </option>
                                          </Show>
                                        </select>
                                      </Show>
                                      <Show when={canRemoveMember(grant)}>
                                        <button
                                          type="button"
                                          disabled={
                                            removingMember() ===
                                            (grant.permission.userId ||
                                              grant.permission.groupId)
                                          }
                                          class="text-red-600 text-size-small hover:text-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                                          onClick={() => void handleRemoveMember(grant)}
                                        >
                                          {removingMember() ===
                                          (grant.permission.userId ||
                                            grant.permission.groupId)
                                            ? "Removing..."
                                            : "Remove"}
                                        </button>
                                      </Show>
                                    </div>
                                  </div>
                                )}
                              </For>
                              <details class="rounded-md border border-neutral-200 bg-background">
                                <summary class="cursor-pointer px-3 py-2 font-medium text-neutral-700 text-size-small hover:bg-neutral-50">
                                  {member.spaceGrant
                                    ? "Accessible resources · Entire space"
                                    : `Accessible resources · ${getAccessibleDocumentCount(member)} pages`}
                                </summary>
                                <div class="space-y-3 border-neutral-100 border-t p-3">
                                  <Show when={member.spaceGrant}>
                                    <p class="text-neutral-600 text-size-small">
                                      This grant covers every resource in the space.
                                    </p>
                                  </Show>
                                  <For each={getAccessibleResourceGroups(member)}>
                                    {(group) => (
                                      <div>
                                        <div class="flex items-center justify-between text-size-small">
                                          <span class="font-medium text-neutral-800">
                                            {group.label}
                                          </span>
                                          <span class="text-neutral-500">
                                            {group.documents.length} pages
                                          </span>
                                        </div>
                                        <ul class="mt-1 divide-y divide-neutral-100 rounded-md border border-neutral-100">
                                          <For each={group.documents}>
                                            {(document) => (
                                              <li class="px-3 py-1.5 text-neutral-700 text-size-small">
                                                {getDocumentLabel(document)}
                                              </li>
                                            )}
                                          </For>
                                          <Show when={group.documents.length === 0}>
                                            <li class="px-3 py-1.5 text-neutral-500 text-size-small">
                                              No pages in this scope.
                                            </li>
                                          </Show>
                                        </ul>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </details>
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
                          <vektor-avatar size="28" attr:user-id={token.id} />
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
                                ? `Last used ${formatAbsoluteDate(token.lastUsedAt)}`
                                : "Never used"}
                              {token.expiresAt
                                ? ` · Expires ${formatAbsoluteDate(token.expiresAt)}`
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
            accessTokens().length === 0
          }
        >
          <div class="rounded-lg border border-neutral-100 py-12 text-center">
            <Icon class="mx-auto h-12 w-12 text-neutral-400" name="users-group" />
            <p class="mt-4 text-neutral-500">
              No members yet. Add your first member to get started.
            </p>
          </div>
        </Show>
      </div>

      <Show when={showAddMember()}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the Cancel button is the keyboard path. */}
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowAddMember(false);
          }}
        >
          <div class="mx-4 w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
            <h3 class="mb-4 font-semibold text-neutral-900 text-size-title">
              Invite People
            </h3>
            <form onSubmit={(event) => void handleAddMember(event)} class="space-y-4">
              <Show when={userIsOwner()}>
                <div>
                  <label
                    for="member-type"
                    class="mb-1 block font-medium text-neutral-900 text-size-medium"
                  >
                    Type
                  </label>
                  <select
                    id="member-type"
                    value={newMemberType()}
                    onChange={(e) => setNewMemberType(e.currentTarget.value)}
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2"
                  >
                    <option value="user">User</option>
                    <option value="group">OAuth Group</option>
                  </select>
                </div>
              </Show>

              <div>
                <label
                  for="member-id"
                  class="mb-1 block font-medium text-neutral-900 text-size-medium"
                >
                  {newMemberType() === "user" ? "Email" : "Group ID"}
                </label>
                <Show
                  when={newMemberType() === "user"}
                  fallback={
                    <input
                      id="member-id"
                      value={newMemberId()}
                      onInput={(e) => setNewMemberId(e.currentTarget.value)}
                      type="text"
                      required
                      placeholder="e.g., admins, developers"
                      class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2"
                    />
                  }
                >
                  <div class="relative">
                    <input
                      id="member-id"
                      value={newMemberEmail()}
                      onInput={(e) => {
                        setNewMemberEmail(e.currentTarget.value);
                        setShowSuggestions(true);
                      }}
                      onFocus={() => setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      type="email"
                      required
                      autocomplete="off"
                      placeholder="person@example.com"
                      class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2"
                    />
                    <Show
                      when={showSuggestions() && filteredInviteSuggestions().length > 0}
                    >
                      <ul class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-neutral-200 bg-background py-1 shadow-lg">
                        <For each={filteredInviteSuggestions()}>
                          {(suggestion) => (
                            <li>
                              <button
                                type="button"
                                class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-50"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  selectSuggestion(suggestion);
                                }}
                              >
                                <vektor-avatar
                                  size="28"
                                  attr:user-id={suggestion.id}
                                  prop:user={suggestion}
                                />
                                <div class="min-w-0">
                                  <div class="truncate font-medium text-neutral-900">
                                    {suggestion.name}
                                  </div>
                                  <div class="truncate text-neutral-500 text-size-small">
                                    {suggestion.email}
                                  </div>
                                </div>
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </Show>
                <Show
                  when={newMemberType() === "user"}
                  fallback={
                    <p class="mt-1 text-neutral-500 text-size-small">
                      The group name from your OAuth provider's wiki_groups field
                    </p>
                  }
                >
                  <p class="mt-1 text-neutral-500 text-size-small">
                    Start typing to pick someone from your groups, or enter the email of
                    an existing account. They'll be added to the space immediately.
                  </p>
                </Show>
              </div>

              <div>
                <label
                  for="member-scope"
                  class="mb-1 block font-medium text-neutral-900 text-size-medium"
                >
                  Access
                </label>
                <select
                  id="member-scope"
                  value={newMemberScope()}
                  onChange={(e) => {
                    setNewMemberScope(e.currentTarget.value);
                    // Owner is a space role; leaving it selected under a
                    // narrower scope would submit a request the API refuses.
                    if (e.currentTarget.value !== "space") {
                      setNewMemberRole((role) =>
                        role === Permission.OWNER ? Permission.VIEWER : role,
                      );
                    }
                  }}
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2"
                >
                  <Show when={userIsOwner()}>
                    <option value="space">Entire space</option>
                  </Show>
                  <option value="category">Category</option>
                </select>
              </div>

              <Show when={newMemberScope() === "category"}>
                <div>
                  <label
                    for="member-category"
                    class="mb-1 block font-medium text-neutral-900 text-size-medium"
                  >
                    Category
                  </label>
                  <select
                    id="member-category"
                    value={newMemberCategoryId()}
                    onChange={(e) => setNewMemberCategoryId(e.currentTarget.value)}
                    required
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2"
                  >
                    <option value="">Select a category...</option>
                    <For each={categories()}>
                      {(category) => <option value={category.id}>{category.name}</option>}
                    </For>
                  </select>
                </div>
              </Show>

              <div>
                <label
                  for="member-role"
                  class="mb-1 block font-medium text-neutral-900 text-size-medium"
                >
                  Permission Level
                </label>
                <select
                  id="member-role"
                  value={newMemberRole()}
                  onChange={(e) => setNewMemberRole(e.currentTarget.value)}
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-2"
                >
                  <option value={Permission.VIEWER}>Viewer - Read-only access</option>
                  <option value={Permission.EDITOR}>
                    Editor - Create and edit content
                  </option>
                  <Show when={newMemberScope() === "space"}>
                    <option value={Permission.OWNER}>Owner - Full control</option>
                  </Show>
                </select>
              </div>

              <Show when={addMemberError()}>
                <div class="rounded-md border border-red-200 bg-red-50 p-3">
                  <p class="text-red-600 text-size-medium">{addMemberError()}</p>
                </div>
              </Show>

              <div class="flex gap-3">
                <Button
                  variant="secondary"
                  text="Cancel"
                  onClick={() => setShowAddMember(false)}
                  class="flex-1"
                />
                <Button
                  type="submit"
                  disabled={addingMember()}
                  text={addingMember() ? "Adding..." : "Invite People"}
                  class="flex-1"
                />
              </div>
            </form>
          </div>
        </div>
      </Show>
    </>
  );
}
