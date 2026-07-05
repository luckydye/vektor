<script setup>
import { computed, ref, watch } from "vue";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { formatDate, getUserInitials } from "#utils/utils.ts";
import {
  checkThinIcon,
  copyIcon,
  usersGroupIcon,
  usersIcon,
} from "~/src/assets/icons.ts";

const { currentSpace } = useSpace();
const user = useUserProfile();

const permissions = ref([]);
const error = ref(null);
const isLoading = ref(false);
const showAddMember = ref(false);
const newMemberId = ref("");
const newMemberType = ref("user");
const newMemberRole = ref("viewer");
const newMemberScope = ref("space");
const newMemberCategoryId = ref("");
const addingMember = ref(false);
const addMemberError = ref(null);
const updatingMember = ref(null);
const removingMember = ref(null);
const availableUsers = ref([]);
const loadingAvailableUsers = ref(false);
const usersMap = ref(new Map());
const categories = ref([]);
const loadingUsers = ref(false);
const copiedUserId = ref(null);

async function fetchPermissions() {
  if (!currentSpace.value?.id) return;

  isLoading.value = true;
  error.value = null;

  try {
    const [spaceResponse, categoryList] = await Promise.all([
      api.permissions.list(currentSpace.value.id, "role"),
      api.categories.get(currentSpace.value.id),
    ]);

    categories.value = categoryList || [];

    const categoryResponses = await Promise.all(
      categories.value.map((category) =>
        api.permissions.list(currentSpace.value.id, "role", {
          resourceType: "category",
          resourceId: category.id,
        }),
      ),
    );

    permissions.value = [
      ...(spaceResponse.permissions || []),
      ...categoryResponses.flatMap((response) => response.permissions || []),
    ];
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to fetch permissions";
    console.error("Failed to fetch permissions:", err);
  } finally {
    isLoading.value = false;
  }
}

async function fetchUsers() {
  if (!currentSpace.value) return;
  loadingUsers.value = true;
  try {
    const users = await api.users.get(currentSpace.value.id);

    const map = new Map();
    users.forEach((u) => {
      map.set(u.id, u);
    });
    usersMap.value = map;

    return users;
  } catch (err) {
    console.error("Failed to fetch users:", err);
  } finally {
    loadingUsers.value = false;
  }
}

async function fetchAvailableUsers() {
  if (!currentSpace.value) return;
  loadingAvailableUsers.value = true;
  try {
    const users = await api.users.candidates(currentSpace.value.id);
    if (!users) {
      throw new Error("Failed to fetch users");
    }

    const memberUserIds = new Set(
      permissions.value
        .filter((p) => p.type === "role" && p.permission.userId)
        .map((p) => p.permission.userId),
    );
    availableUsers.value = users.filter((u) => !memberUserIds.has(u.id));
  } catch (err) {
    console.error("Failed to fetch available users:", err);
    addMemberError.value = "Failed to load available users";
  } finally {
    loadingAvailableUsers.value = false;
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
    fetchAvailableUsers();
    addMemberError.value = null;
    newMemberId.value = "";
    newMemberType.value = "user";
    newMemberRole.value = "viewer";
    newMemberScope.value = "space";
    newMemberCategoryId.value = "";
  }
});

const rolePermissions = computed(() => {
  return permissions.value.filter((p) => p.type === "role") || [];
});

async function handleAddMember(e) {
  e.preventDefault();

  if (!currentSpace.value?.id || !newMemberId.value) {
    return;
  }

  if (newMemberScope.value === "category" && !newMemberCategoryId.value) {
    addMemberError.value = "Select a category";
    return;
  }

  addingMember.value = true;
  addMemberError.value = null;

  try {
    const isGroup = newMemberType.value === "group";
    await api.permissions.grant(currentSpace.value.id, {
      type: "role",
      roleOrFeature: newMemberRole.value,
      ...(isGroup
        ? { groupId: newMemberId.value.trim() }
        : { userId: newMemberId.value.trim() }),
      ...(newMemberScope.value === "category"
        ? { resourceType: "category", resourceId: newMemberCategoryId.value }
        : {}),
    });

    showAddMember.value = false;
    newMemberId.value = "";
    newMemberType.value = "user";
    newMemberRole.value = "viewer";
    newMemberScope.value = "space";
    newMemberCategoryId.value = "";
    await fetchPermissions();
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

function canEditMember(userId, perm) {
  if (user.value.id === userId) {
    return false;
  }

  if (!user.value || !currentSpace.value) {
    return false;
  }

  const currentUserPerm = permissions.value.find(
    (p) => p.type === "role" && p.permission.userId === user.value.id,
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
    (p) => p.type === "role" && p.permission.userId === user.value.id,
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
    const userData = usersMap.value.get(perm.permission.userId);
    return userData?.name || userData?.email || perm.permission.userId;
  }
  return perm.permission.groupId;
}

function getMemberEmail(perm) {
  if (perm.permission.userId) {
    const userData = usersMap.value.get(perm.permission.userId);
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
  return `${perm.permission.resourceType}: ${perm.permission.resourceId}`;
}

function getMemberIcon(perm) {
  return perm.permission.userId ? "user" : "group";
}

function getMemberBgColor(perm) {
  return perm.permission.userId ? "bg-blue-600" : "bg-green-600";
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
      <button
        @click="showAddMember = true"
        class="px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        Invite People
      </button>
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
    <div v-if="!isLoading && !loadingUsers && rolePermissions.length > 0" class="overflow-x-auto border border-neutral-100 rounded-md">
      <table class="min-w-full text-size-medium">
        <thead class="bg-neutral-50">
          <tr>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Member</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Type</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Access</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Role</th>
            <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Added</th>
            <th class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-100">
          <tr v-for="perm in rolePermissions" :key="`${perm.permission.resourceType || 'space'}-${perm.permission.resourceId || currentSpace?.id}-${perm.permission.userId || perm.permission.groupId}`" class="hover:bg-neutral-50">
            <td class="px-4 py-2.5">
              <div class="flex items-center gap-3">
                <div :class="[getMemberBgColor(perm), 'flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center']">
                  <span v-if="perm.permission.userId" class="text-white text-size-small font-medium">
                    {{ getUserInitials(getMemberName(perm)) }}
                  </span>
                  <div v-else class="svg-icon w-4 h-4 text-white" v-html="usersIcon" />
                </div>
                <div>
                  <div class="font-medium text-neutral-900">{{ getMemberName(perm) }}</div>
                  <div v-if="getMemberEmail(perm)" class="text-size-small text-neutral-500">{{ getMemberEmail(perm) }}</div>
                </div>
                <button
                  v-if="perm.permission.userId"
                  @click="copyMemberId(perm.permission.userId)"
                  :title="copiedUserId === perm.permission.userId ? 'Copied!' : 'Copy ID'"
                  class="p-1 text-neutral-400 hover:text-neutral-600 transition-colors"
                >
                  <div v-if="copiedUserId === perm.permission.userId" class="svg-icon w-3.5 h-3.5 text-green-600" v-html="checkThinIcon" />
                  <div v-else class="svg-icon w-3.5 h-3.5" v-html="copyIcon" />
                </button>
              </div>
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-600">{{ getMemberType(perm) }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-600">{{ getResourceLabel(perm) }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap">
              <select
                v-if="canEditMember(perm.permission.userId, perm)"
                :value="perm.permission.permission"
                @change="(e) => handleRoleChange(perm, e.target.value)"
                class="text-size-medium border border-neutral-100 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                :disabled="updatingMember === (perm.permission.userId || perm.permission.groupId)"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
              </select>
              <span v-else class="inline-flex items-center px-2 py-0.5 rounded-full text-size-small font-medium" :class="getRoleBadgeClass(perm.permission.permission)">
                {{ perm.permission.permission }}
              </span>
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ formatDate(perm.permission.createdAt) }}</td>
            <td class="px-4 py-2.5 whitespace-nowrap text-right">
              <button
                v-if="canRemoveMember(perm)"
                @click="handleRemoveMember(perm)"
                :disabled="removingMember === (perm.permission.userId || perm.permission.groupId)"
                class="text-size-small text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {{ removingMember === (perm.permission.userId || perm.permission.groupId) ? 'Removing...' : 'Remove' }}
              </button>
              <span v-else class="text-neutral-400">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    
    <!-- Empty State -->
    <div v-if="!isLoading && !loadingUsers && rolePermissions.length === 0" class="text-center py-12 border border-neutral-100 rounded-lg">
      <div class="svg-icon mx-auto h-12 w-12 text-neutral-400" v-html="usersGroupIcon" />
      <p class="mt-4 text-neutral-500">No members yet. Add your first member to get started.</p>
    </div>
  </div>

  <!-- Add Member Modal -->
  <div
    v-if="showAddMember"
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    @click.self="showAddMember = false"
  >
    <div class="bg-background rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
      <h3 class="text-size-title font-semibold text-neutral-900 mb-4">Invite People</h3>
      <form @submit.prevent="handleAddMember" class="space-y-4">
        <div>
          <label for="member-type" class="block text-size-medium font-medium text-neutral-900 mb-1">
            Type
          </label>
          <select
            id="member-type"
            v-model="newMemberType"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="user">User</option>
            <option value="group">OAuth Group</option>
          </select>
        </div>

        <div>
          <label for="member-id" class="block text-size-medium font-medium text-neutral-900 mb-1">
            {{ newMemberType === "user" ? "User" : "Group ID" }}
          </label>
          <select
            v-if="newMemberType === 'user'"
            id="member-id"
            v-model="newMemberId"
            required
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            :disabled="loadingAvailableUsers"
          >
            <option value="">Select a user...</option>
            <option v-for="u in availableUsers" :key="u.id" :value="u.id">
              {{ u.name || u.email }} ({{ u.email }})
            </option>
          </select>
          <input
            v-else
            id="member-id"
            v-model="newMemberId"
            type="text"
            required
            placeholder="e.g., admins, developers"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p v-if="newMemberType === 'group'" class="mt-1 text-size-small text-neutral-500">
            The group name from your OAuth provider's wiki_groups field
          </p>
        </div>

        <div>
          <label for="member-scope" class="block text-size-medium font-medium text-neutral-900 mb-1">
            Access
          </label>
          <select
            id="member-scope"
            v-model="newMemberScope"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="space">Entire space</option>
            <option value="category">Category</option>
          </select>
        </div>

        <div v-if="newMemberScope === 'category'">
          <label for="member-category" class="block text-size-medium font-medium text-neutral-900 mb-1">
            Category
          </label>
          <select
            id="member-category"
            v-model="newMemberCategoryId"
            required
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select a category...</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
        </div>

        <div>
          <label for="member-role" class="block text-size-medium font-medium text-neutral-900 mb-1">
            Permission Level
          </label>
          <select
            id="member-role"
            v-model="newMemberRole"
            class="w-full px-3 py-2 border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
          <button
            type="button"
            @click="showAddMember = false; addMemberError = null; newMemberId = ''; newMemberType = 'user'; newMemberRole = 'viewer'; newMemberScope = 'space'; newMemberCategoryId = '';"
            class="flex-1 px-4 py-2 text-size-medium font-medium text-neutral-900 bg-neutral-100 rounded-md hover:bg-neutral-200 focus:outline-none focus:ring-2 focus:ring-neutral-500"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="addingMember"
            class="flex-1 px-4 py-2 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ addingMember ? 'Adding...' : 'Invite People' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
