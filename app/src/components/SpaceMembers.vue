<script setup>
import { computed, ref, watch } from "vue";
import { api } from "#api/client.ts";
import { confirmationIcon, copyIcon, usersGroupIcon, usersIcon } from "#assets/icons.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { formatDate } from "#utils/datetime.ts";
import Button from "./Button.vue";
import "./AvatarElement.ts";

const { currentSpace } = useSpace();
const user = useUserProfile();

const permissions = ref([]);
const error = ref(null);
const isLoading = ref(false);
const showAddMember = ref(false);
const newMemberId = ref("");
const newMemberEmail = ref("");
const newMemberType = ref("user");
const newMemberRole = ref("viewer");
const newMemberScope = ref("space");
const newMemberCategoryId = ref("");
const addingMember = ref(false);
const addMemberError = ref(null);
const updatingMember = ref(null);
const removingMember = ref(null);
const usersMap = ref(new Map());
const categories = ref([]);
const documents = ref([]);
const loadingUsers = ref(false);
const copiedUserId = ref(null);

async function fetchPermissions() {
  if (!currentSpace.value?.id) return;

  isLoading.value = true;
  error.value = null;

  try {
    const [spaceResponse, categoryList, documentList] = await Promise.all([
      api.permissions.list(currentSpace.value.id, "role", { allResources: true }),
      api.categories.get(currentSpace.value.id),
      fetchAllDocuments(currentSpace.value.id),
    ]);

    categories.value = categoryList?.categories || [];
    documents.value = documentList;

    permissions.value = spaceResponse.permissions || [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to fetch permissions";
    console.error("Failed to fetch permissions:", err);
  } finally {
    isLoading.value = false;
  }
}

async function fetchAllDocuments(spaceId) {
  const documents = [];
  let cursor;

  do {
    const response = await api.documents.get(spaceId, { limit: 500, cursor });
    documents.push(...response.documents);
    cursor = response.nextCursor || undefined;
  } while (cursor);

  return documents;
}

async function fetchUsers() {
  if (!currentSpace.value) return;
  loadingUsers.value = true;
  try {
    const members = await api.spaceMembers.get(currentSpace.value.id);

    const map = new Map();
    members.forEach((member) => {
      if (member.user) map.set(member.user.id, member.user);
    });
    usersMap.value = map;

    return members;
  } catch (err) {
    console.error("Failed to fetch users:", err);
  } finally {
    loadingUsers.value = false;
  }
}

watch(
  () => currentSpace.value?.id,
  () => {
    fetchPermissions();
    fetchUsers();
  },
  {
    immediate: true,
  },
);

watch(showAddMember, (isOpen) => {
  if (isOpen) {
    addMemberError.value = null;
    newMemberId.value = "";
    newMemberEmail.value = "";
    newMemberType.value = "user";
    newMemberRole.value = "viewer";
    newMemberScope.value = "space";
    newMemberCategoryId.value = "";
  }
});

const rolePermissions = computed(() => {
  return permissions.value.filter((p) => p.type === "role") || [];
});

const memberAccess = computed(() => {
  const accessByMember = new Map();

  for (const perm of rolePermissions.value) {
    const memberId = perm.permission.userId || perm.permission.groupId;
    if (!memberId) continue;

    const key = `${perm.permission.userId ? "user" : "group"}:${memberId}`;
    const existing = accessByMember.get(key);
    if (existing) {
      existing.grants.push(perm);
      continue;
    }

    accessByMember.set(key, {
      key,
      primaryPermission: perm,
      grants: [perm],
    });
  }

  return [...accessByMember.values()]
    .map((member) => {
      const spaceGrant = member.grants.find(
        (grant) =>
          !grant.permission.resourceType || grant.permission.resourceType === "space",
      );
      const categoryGrants = member.grants.filter(
        (grant) => grant.permission.resourceType === "category",
      );

      return {
        ...member,
        spaceGrant,
        categoryGrants,
        highestRole: getHighestRole(member.grants),
      };
    })
    .sort((a, b) =>
      getMemberName(a.primaryPermission).localeCompare(
        getMemberName(b.primaryPermission),
      ),
    );
});

const expandedMembers = ref(new Set());

const documentsById = computed(
  () => new Map(documents.value.map((document) => [document.id, document])),
);

const documentsByCategoryId = computed(() => {
  return new Map(
    categories.value.map((category) => [
      category.id,
      documents.value.filter((document) =>
        documentBelongsToCategory(document, category.slug, documentsById.value),
      ),
    ]),
  );
});

async function handleAddMember(e) {
  e.preventDefault();

  if (!currentSpace.value?.id) {
    return;
  }

  const isGroup = newMemberType.value === "group";

  if (isGroup ? !newMemberId.value.trim() : !newMemberEmail.value.trim()) {
    return;
  }

  if (newMemberScope.value === "category" && !newMemberCategoryId.value) {
    addMemberError.value = "Select a category";
    return;
  }

  addingMember.value = true;
  addMemberError.value = null;

  try {
    await api.permissions.grant(currentSpace.value.id, {
      type: "role",
      roleOrFeature: newMemberRole.value,
      ...(isGroup
        ? { groupId: newMemberId.value.trim() }
        : { email: newMemberEmail.value.trim() }),
      ...(newMemberScope.value === "category"
        ? { resourceType: "category", resourceId: newMemberCategoryId.value }
        : {}),
    });

    showAddMember.value = false;
    newMemberId.value = "";
    newMemberEmail.value = "";
    newMemberType.value = "user";
    newMemberRole.value = "viewer";
    newMemberScope.value = "space";
    newMemberCategoryId.value = "";
    await Promise.all([fetchPermissions(), fetchUsers()]);
  } catch (err) {
    addMemberError.value = err instanceof Error ? err.message : "Failed to add member";
    console.error("Failed to add member:", err);
  } finally {
    addingMember.value = false;
  }
}

async function handleRoleChange(perm, newRole) {
  if (!currentSpace.value?.id) {
    return;
  }

  updatingMember.value = perm.permission.userId || perm.permission.groupId;

  try {
    const isGroup = !!perm.permission.groupId;
    await api.permissions.grant(currentSpace.value.id, {
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
    updatingMember.value = null;
  }
}

async function handleRemoveMember(perm) {
  if (!currentSpace.value?.id) {
    return;
  }

  const memberId = perm.permission.userId || perm.permission.groupId;
  const memberType = perm.permission.userId ? "user" : "group";
  const isGroup = memberType === "group";

  if (!confirm(`Are you sure you want to remove this ${memberType}?`)) {
    return;
  }

  removingMember.value = memberId;

  try {
    await api.permissions.revoke(currentSpace.value.id, {
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
    removingMember.value = null;
  }
}

function getRoleBadgeClass(role) {
  const classes = {
    owner: "bg-purple-100 text-purple-800",
    editor: "bg-green-100 text-green-800",
    viewer: "bg-neutral-100 text-neutral-800",
  };
  return classes[role] || classes.viewer;
}

function getHighestRole(grants) {
  const hierarchy = { viewer: 1, editor: 2, owner: 3 };
  return grants.reduce(
    (highest, grant) =>
      hierarchy[grant.permission.permission] > hierarchy[highest]
        ? grant.permission.permission
        : highest,
    "viewer",
  );
}

function getAccessSummary(member) {
  if (member.spaceGrant) return "Entire space";
  if (member.categoryGrants.length > 0) {
    const count = member.categoryGrants.length;
    return `${count} categor${count === 1 ? "y" : "ies"}`;
  }
  const count = member.grants.filter((grant) =>
    ["document", "document_tree"].includes(grant.permission.resourceType),
  ).length;
  if (count > 0) return `${count} page${count === 1 ? "" : "s"}`;
  return `${member.grants.length} resource${member.grants.length === 1 ? "" : "s"}`;
}

function getAccessDetail(member) {
  if (member.spaceGrant && member.categoryGrants.length > 0) {
    return `Plus ${member.categoryGrants.length} category override${member.categoryGrants.length === 1 ? "" : "s"}`;
  }
  if (member.spaceGrant) return "Space-wide access";
  if (member.categoryGrants.length > 0) return "Category-scoped access";
  if (
    member.grants.some((grant) =>
      ["document", "document_tree"].includes(grant.permission.resourceType),
    )
  ) {
    return "Page-scoped access";
  }
  return "Resource-scoped access";
}

function documentBelongsToCategory(document, categorySlug, documentsById) {
  const seen = new Set();
  let current = document;

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

function getAccessibleResourceGroups(member) {
  if (member.spaceGrant) return [];

  const categoryGroups = member.categoryGrants.map((grant) => {
    const category = categories.value.find(
      (item) => item.id === grant.permission.resourceId,
    );
    return {
      id: grant.permission.resourceId,
      label: category?.name || "Category",
      documents: documentsByCategoryId.value.get(grant.permission.resourceId) || [],
    };
  });

  const documentGroups = member.grants
    .filter((grant) =>
      ["document", "document_tree"].includes(grant.permission.resourceType),
    )
    .map((grant) => {
      const root = documentsById.value.get(grant.permission.resourceId);
      const isTree = grant.permission.resourceType === "document_tree";
      return {
        id: `${grant.permission.resourceType}:${grant.permission.resourceId}`,
        label: `${isTree ? "Page tree" : "Page"}: ${root ? getDocumentLabel(root) : grant.permission.resourceId}`,
        documents: root
          ? isTree
            ? documents.value.filter((document) =>
                documentIsInTree(document, root.id, documentsById.value),
              )
            : [root]
          : [],
      };
    });

  return [...categoryGroups, ...documentGroups];
}

function getAccessibleDocumentCount(member) {
  return new Set(
    getAccessibleResourceGroups(member).flatMap((group) =>
      group.documents.map((document) => document.id),
    ),
  ).size;
}

function getDocumentLabel(document) {
  const title = document.properties?.title || document.properties?.name;
  return Array.isArray(title) ? title[0] : title || document.slug;
}

function documentIsInTree(document, rootId, documentsById) {
  const seen = new Set();
  let current = document;

  while (current && !seen.has(current.id)) {
    if (current.id === rootId) return true;
    seen.add(current.id);
    current = current.parentId ? documentsById.get(current.parentId) : undefined;
  }

  return false;
}

function hasMixedRoles(member) {
  return new Set(member.grants.map((grant) => grant.permission.permission)).size > 1;
}

function toggleMemberDetails(memberKey) {
  const next = new Set(expandedMembers.value);
  if (next.has(memberKey)) {
    next.delete(memberKey);
  } else {
    next.add(memberKey);
  }
  expandedMembers.value = next;
}

function canEditMember(userId, perm) {
  if (user.value.id === userId) {
    return false;
  }

  if (!user.value || !currentSpace.value) {
    return false;
  }

  const currentUserPerm = permissions.value.find(
    (p) =>
      p.type === "role" &&
      p.permission.userId === user.value.id &&
      p.permission.resourceType === "space",
  );
  if (!currentUserPerm) {
    return false;
  }

  const roleHierarchy = {
    viewer: 1,
    editor: 2,
    owner: 3,
  };

  const currentUserLevel = roleHierarchy[currentUserPerm.permission.permission] || 0;
  const memberLevel = roleHierarchy[perm.permission.permission] || 0;

  return (
    (currentUserLevel >= 3 && currentUserLevel > memberLevel) || currentUserLevel === 3
  );
}

function canRemoveMember(perm) {
  if (!user.value || !currentSpace.value) {
    return false;
  }

  const memberId = perm.permission.userId;

  // Can't remove yourself
  if (memberId === user.value.id) {
    return false;
  }

  // Can't remove the original space owner
  if (perm.permission.permission === "owner" && currentSpace.value.userId === memberId) {
    return false;
  }

  // Space owner can remove anyone (except themselves and the checks above)
  if (currentSpace.value.userId === user.value.id) {
    return true;
  }

  const currentUserPerm = permissions.value.find(
    (p) =>
      p.type === "role" &&
      p.permission.userId === user.value.id &&
      p.permission.resourceType === "space",
  );
  if (!currentUserPerm) {
    return false;
  }

  const roleHierarchy = {
    viewer: 1,
    editor: 2,
    owner: 3,
  };

  const currentUserLevel = roleHierarchy[currentUserPerm.permission.permission] || 0;
  const memberLevel = roleHierarchy[perm.permission.permission] || 0;

  return currentUserLevel >= 3 && currentUserLevel > memberLevel;
}

function getMemberName(perm) {
  if (perm.permission.userId) {
    const userData = getMemberUser(perm);
    return userData?.name || userData?.email || perm.permission.userId;
  }
  return perm.permission.groupId;
}

function getMemberUser(perm) {
  if (!perm.permission.userId) return undefined;
  return usersMap.value.get(perm.permission.userId);
}

function getMemberEmail(perm) {
  if (perm.permission.userId) {
    const userData = getMemberUser(perm);
    return userData?.email || "";
  }
  return "";
}

function getMemberType(perm) {
  return perm.permission.userId ? "User" : "Group";
}

function getResourceLabel(perm) {
  if (!perm.permission.resourceType || perm.permission.resourceType === "space") {
    return "Entire space";
  }
  if (perm.permission.resourceType === "category") {
    const category = categories.value.find((c) => c.id === perm.permission.resourceId);
    return category ? `Category: ${category.name}` : "Category";
  }
  if (perm.permission.resourceType === "document") {
    const document = documentsById.value.get(perm.permission.resourceId);
    return `Page: ${document ? getDocumentLabel(document) : perm.permission.resourceId}`;
  }
  if (perm.permission.resourceType === "document_tree") {
    const document = documentsById.value.get(perm.permission.resourceId);
    return `Page tree: ${document ? getDocumentLabel(document) : perm.permission.resourceId}`;
  }
  return `${perm.permission.resourceType}: ${perm.permission.resourceId}`;
}

async function copyMemberId(memberId) {
  try {
    await navigator.clipboard.writeText(memberId);
    copiedUserId.value = memberId;
    setTimeout(() => {
      copiedUserId.value = null;
    }, 2000);
  } catch (err) {
    console.error("Failed to copy ID:", err);
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h2 class="text-size-large font-semibold text-neutral-900">Members</h2>
      <Button text="Invite People" @click="showAddMember = true" />
    </div>

    <!-- Loading State -->
    <div v-if="isLoading || loadingUsers" class="flex justify-center py-8">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>

    <!-- Error State -->
    <div v-if="error" class="p-4 bg-red-50 border border-red-200 rounded-md">
      <p class="text-size-medium text-red-600">{{ error }}</p>
    </div>

    <!-- Members List -->
    <div
      v-if="!isLoading && !loadingUsers && memberAccess.length > 0"
      class="overflow-x-auto border border-neutral-100 rounded-md"
    >
      <table class="min-w-full text-size-medium">
        <thead class="bg-neutral-50">
          <tr>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Member
            </th>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Type
            </th>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Access
            </th>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Role
            </th>
            <th
              class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Details
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-100">
          <template v-for="member in memberAccess" :key="member.key">
            <tr class="hover:bg-neutral-50">
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-3">
                  <vektor-avatar
                    v-if="member.primaryPermission.permission.userId"
                    size="28"
                    :user-id="member.primaryPermission.permission.userId"
                    :user="getMemberUser(member.primaryPermission)"
                  />
                  <div
                    v-else
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600"
                  >
                    <div class="svg-icon w-4 h-4 text-white" v-html="usersIcon" />
                  </div>
                  <div>
                    <div class="font-medium text-neutral-900">
                      {{ getMemberName(member.primaryPermission) }}
                    </div>
                    <div
                      v-if="getMemberEmail(member.primaryPermission)"
                      class="text-size-small text-neutral-500"
                    >
                      {{ getMemberEmail(member.primaryPermission) }}
                    </div>
                  </div>
                  <button
                    v-if="member.primaryPermission.permission.userId"
                    type="button"
                    :title="copiedUserId === member.primaryPermission.permission.userId ? 'Copied!' : 'Copy ID'"
                    class="p-1 text-neutral-400 hover:text-neutral-600 transition-colors"
                    @click="copyMemberId(member.primaryPermission.permission.userId)"
                  >
                    <div
                      v-if="copiedUserId === member.primaryPermission.permission.userId"
                      class="svg-icon w-3.5 h-3.5 text-green-600"
                      v-html="confirmationIcon"
                    />
                    <div v-else class="svg-icon w-3.5 h-3.5" v-html="copyIcon" />
                  </button>
                </div>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-neutral-600">
                {{ getMemberType(member.primaryPermission) }}
              </td>
              <td class="px-4 py-2.5">
                <div class="whitespace-nowrap font-medium text-neutral-800">
                  {{ getAccessSummary(member) }}
                </div>
                <div class="text-size-small text-neutral-500">
                  {{ getAccessDetail(member) }}
                </div>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-size-small font-medium"
                  :class="getRoleBadgeClass(member.highestRole)"
                >
                  {{ hasMixedRoles(member) ? 'Mixed roles' : member.highestRole }}
                </span>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-right">
                <button
                  type="button"
                  class="text-size-small text-neutral-600 hover:text-neutral-900"
                  :aria-expanded="expandedMembers.has(member.key)"
                  @click="toggleMemberDetails(member.key)"
                >
                  {{ expandedMembers.has(member.key) ? 'Hide access' : `${member.grants.length} grant${member.grants.length === 1 ? '' : 's'}` }}
                </button>
              </td>
            </tr>
            <tr v-if="expandedMembers.has(member.key)" class="bg-neutral-50">
              <td colspan="5" class="px-4 py-3">
                <div class="ml-10 border-l-2 border-neutral-200 pl-4 space-y-2">
                  <div
                    v-for="grant in member.grants"
                    :key="`${grant.permission.resourceType || 'space'}-${grant.permission.resourceId || currentSpace?.id}`"
                    class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background px-3 py-2 border border-neutral-100"
                  >
                    <div>
                      <div class="font-medium text-neutral-900">
                        {{ getResourceLabel(grant) }}
                      </div>
                      <div class="text-size-small text-neutral-500">
                        Added {{ formatDate(grant.permission.createdAt) }}
                      </div>
                    </div>
                    <div class="flex items-center gap-3">
                      <select
                        v-if="canEditMember(grant.permission.userId, grant)"
                        :value="grant.permission.permission"
                        :disabled="updatingMember === (grant.permission.userId || grant.permission.groupId)"
                        class="text-size-medium border border-neutral-100 rounded-md px-2 py-1 focus-ring"
                        @change="(e) => handleRoleChange(grant, e.target.value)"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                        <option value="owner">Owner</option>
                      </select>
                      <span
                        v-else
                        class="inline-flex items-center px-2 py-0.5 rounded-full text-size-small font-medium"
                        :class="getRoleBadgeClass(grant.permission.permission)"
                      >
                        {{ grant.permission.permission }}
                      </span>
                      <button
                        v-if="canRemoveMember(grant)"
                        type="button"
                        :disabled="removingMember === (grant.permission.userId || grant.permission.groupId)"
                        class="text-size-small text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        @click="handleRemoveMember(grant)"
                      >
                        {{ removingMember === (grant.permission.userId || grant.permission.groupId) ? 'Removing...' : 'Remove' }}
                      </button>
                    </div>
                  </div>
                  <details class="rounded-md border border-neutral-200 bg-background">
                    <summary
                      class="cursor-pointer px-3 py-2 text-size-small font-medium text-neutral-700 hover:bg-neutral-50"
                    >
                      {{ member.spaceGrant ? 'Accessible resources · Entire space' : `Accessible resources · ${getAccessibleDocumentCount(member)} pages` }}
                    </summary>
                    <div class="border-t border-neutral-100 p-3 space-y-3">
                      <p
                        v-if="member.spaceGrant"
                        class="text-size-small text-neutral-600"
                      >
                        This grant covers every resource in the space.
                      </p>
                      <div
                        v-for="group in getAccessibleResourceGroups(member)"
                        :key="group.id"
                      >
                        <div class="flex items-center justify-between text-size-small">
                          <span class="font-medium text-neutral-800"
                            >{{ group.label }}</span
                          >
                          <span class="text-neutral-500"
                            >{{ group.documents.length }}
                            pages</span
                          >
                        </div>
                        <ul
                          class="mt-1 divide-y divide-neutral-100 rounded-md border border-neutral-100"
                        >
                          <li
                            v-for="document in group.documents"
                            :key="document.id"
                            class="px-3 py-1.5 text-size-small text-neutral-700"
                          >
                            {{ getDocumentLabel(document) }}
                          </li>
                          <li
                            v-if="group.documents.length === 0"
                            class="px-3 py-1.5 text-size-small text-neutral-500"
                          >
                            No pages in this scope.
                          </li>
                        </ul>
                      </div>
                    </div>
                  </details>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- Empty State -->
    <div
      v-if="!isLoading && !loadingUsers && memberAccess.length === 0"
      class="text-center py-12 border border-neutral-100 rounded-lg"
    >
      <div class="svg-icon mx-auto h-12 w-12 text-neutral-400" v-html="usersGroupIcon" />
      <p class="mt-4 text-neutral-500">
        No members yet. Add your first member to get started.
      </p>
    </div>
  </div>

  <!-- Add Member Modal -->
  <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
  <!-- biome-ignore lint/a11y/useKeyWithClickEvents: This Vue event handler is supplemental to the component's keyboard interaction model. -->
  <div
    v-if="showAddMember"
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    @click.self="showAddMember = false"
  >
    <div class="bg-background rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
      <h3 class="text-size-title font-semibold text-neutral-900 mb-4">Invite People</h3>
      <form @submit.prevent="handleAddMember" class="space-y-4">
        <div>
          <label
            for="member-type"
            class="block text-size-medium font-medium text-neutral-900 mb-1"
          >
            Type
          </label>
          <select
            id="member-type"
            v-model="newMemberType"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus-ring"
          >
            <option value="user">User</option>
            <option value="group">OAuth Group</option>
          </select>
        </div>

        <div>
          <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
          <label
            for="member-id"
            class="block text-size-medium font-medium text-neutral-900 mb-1"
          >
            {{ newMemberType === "user" ? "Email" : "Group ID" }}
          </label>
          <input
            v-if="newMemberType === 'user'"
            id="member-id"
            v-model="newMemberEmail"
            type="email"
            required
            placeholder="person@example.com"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus-ring"
          >
          <input
            v-else
            id="member-id"
            v-model="newMemberId"
            type="text"
            required
            placeholder="e.g., admins, developers"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus-ring"
          >
          <p
            v-if="newMemberType === 'user'"
            class="mt-1 text-size-small text-neutral-500"
          >
            Enter the email of an existing account. They'll be added to the space
            immediately.
          </p>
          <p v-else class="mt-1 text-size-small text-neutral-500">
            The group name from your OAuth provider's wiki_groups field
          </p>
        </div>

        <div>
          <label
            for="member-scope"
            class="block text-size-medium font-medium text-neutral-900 mb-1"
          >
            Access
          </label>
          <select
            id="member-scope"
            v-model="newMemberScope"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus-ring"
          >
            <option value="space">Entire space</option>
            <option value="category">Category</option>
          </select>
        </div>

        <div v-if="newMemberScope === 'category'">
          <label
            for="member-category"
            class="block text-size-medium font-medium text-neutral-900 mb-1"
          >
            Category
          </label>
          <select
            id="member-category"
            v-model="newMemberCategoryId"
            required
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus-ring"
          >
            <option value="">Select a category...</option>
            <option
              v-for="category in categories"
              :key="category.id"
              :value="category.id"
            >
              {{ category.name }}
            </option>
          </select>
        </div>

        <div>
          <label
            for="member-role"
            class="block text-size-medium font-medium text-neutral-900 mb-1"
          >
            Permission Level
          </label>
          <select
            id="member-role"
            v-model="newMemberRole"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus-ring"
          >
            <option value="viewer">Viewer - Read-only access</option>
            <option value="editor">Editor - Create and edit content</option>
            <option value="owner">Owner - Full control</option>
          </select>
        </div>

        <div v-if="addMemberError" class="p-3 bg-red-50 border border-red-200 rounded-md">
          <p class="text-size-medium text-red-600">{{ addMemberError }}</p>
        </div>

        <div class="flex gap-3">
          <Button
            variant="secondary"
            text="Cancel"
            @click="showAddMember = false; addMemberError = null; newMemberId = ''; newMemberEmail = ''; newMemberType = 'user'; newMemberRole = 'viewer'; newMemberScope = 'space'; newMemberCategoryId = '';"
            class="flex-1"
          />
          <Button
            type="submit"
            :disabled="addingMember"
            :text="addingMember ? 'Adding...' : 'Invite People'"
            class="flex-1"
          />
        </div>
      </form>
    </div>
  </div>
</template>
