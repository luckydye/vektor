<script setup>
import { ref, watch, computed } from "vue";
import { useSpace } from "../composeables/useSpace.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import { getUserInitials, formatDate } from "../utils/utils.ts";
import { api } from "../api/client.ts";

const { currentSpace } = useSpace();
const user = useUserProfile();

const permissions = ref([]);
const error = ref(null);
const isLoading = ref(false);
const showAddMember = ref(false);
const newMemberId = ref("");
const newMemberType = ref("user");
const newMemberRole = ref("viewer");
const addingMember = ref(false);
const addMemberError = ref(null);
const updatingMember = ref(null);
const removingMember = ref(null);
const availableUsers = ref([]);
const loadingAvailableUsers = ref(false);
const usersMap = ref(new Map());
const loadingUsers = ref(false);
const copiedUserId = ref(null);

async function fetchPermissions() {
  if (!currentSpace.value?.id) return;

  isLoading.value = true;
  error.value = null;

  try {
    const response = await api.permissions.list(currentSpace.value.id, "role");
    permissions.value = response.permissions || [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to fetch permissions";
    console.error("Failed to fetch permissions:", err);
  } finally {
    isLoading.value = false;
  }
}

async function fetchUsers() {
  loadingUsers.value = true;
  try {
    const users = await api.users.get();

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
  loadingAvailableUsers.value = true;
  try {
    const users = await fetchUsers();
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
    });

    showAddMember.value = false;
    newMemberId.value = "";
    newMemberType.value = "user";
    newMemberRole.value = "viewer";
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
    <div class="flex justify-between items-center">
        <!-- Header -->
        <div>
            <h3 class="text-lg font-semibold text-neutral-900">Space Access</h3>
            <p class="text-sm text-neutral-900 mt-1">Manage users and groups with access to this space</p>
        </div>
    
        <!-- Add Button -->
        <div class="flex justify-end">
            <button
            @click="showAddMember = true"
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
            Add Access
            </button>
        </div>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading || loadingUsers" class="flex justify-center py-8">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>

    <!-- Error State -->
    <div v-if="error" class="p-4 bg-red-50 border border-red-200 rounded-md">
      <p class="text-sm text-red-600">{{ error }}</p>
    </div>

    <!-- Members List -->
    <div v-if="!isLoading && !loadingUsers && rolePermissions.length > 0" class="border border-neutral-100 rounded-lg overflow-auto">
      <table class="min-w-full divide-y divide-neutral-200">
        <thead class="bg-neutral-50">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wider">
              Member
            </th>
            <th class="px-6 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wider">
              Type
            </th>
            <th class="px-6 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wider">
              Role
            </th>
            <th class="px-6 py-3 text-left text-xs font-medium text-neutral-900 uppercase tracking-wider">
              Added
            </th>
            <th class="px-6 py-3 text-right text-xs font-medium text-neutral-900 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody class="bg-background divide-y divide-neutral-200">
          <tr v-for="perm in rolePermissions" :key="`${perm.permission.userId || perm.permission.groupId}`" class="hover:bg-neutral-50">
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="flex items-center gap-3">
                <div :class="[getMemberBgColor(perm), 'flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center']">
                  <span v-if="perm.permission.userId" class="text-white text-sm font-medium">
                    {{ getUserInitials(getMemberName(perm)) }}
                  </span>
                  <svg v-else class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-medium text-neutral-900">{{ getMemberName(perm) }}</div>
                  <div v-if="getMemberEmail(perm)" class="text-xs text-neutral-500">{{ getMemberEmail(perm) }}</div>
                </div>
                <button
                  v-if="perm.permission.userId"
                  @click="copyMemberId(perm.permission.userId)"
                  :title="copiedUserId === perm.permission.userId ? 'Copied!' : 'Copy ID'"
                  class="ml-2 p-1 text-neutral-400 hover:text-neutral-600 transition-colors"
                >
                  <svg v-if="copiedUserId === perm.permission.userId" class="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
              <span class="text-sm text-neutral-900">{{ getMemberType(perm) }}</span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
              <select
                v-if="canEditMember(perm.permission.userId, perm)"
                :value="perm.permission.permission"
                @change="(e) => handleRoleChange(perm, e.target.value)"
                class="text-sm border border-neutral-100 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                :disabled="updatingMember === (perm.permission.userId || perm.permission.groupId)"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
              </select>
              <span v-else class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium" :class="getRoleBadgeClass(perm.permission.permission)">
                {{ perm.permission.permission }}
              </span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-neutral-500">
              {{ formatDate(perm.permission.createdAt) }}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
              <button
                v-if="canRemoveMember(perm)"
                @click="handleRemoveMember(perm)"
                :disabled="removingMember === (perm.permission.userId || perm.permission.groupId)"
                class="text-red-600 hover:text-red-900 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {{ removingMember === (perm.permission.userId || perm.permission.groupId) ? 'Removing...' : 'Remove' }}
              </button>
              <span v-else class="text-neutral-400">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Empty State -->
    <div v-if="!isLoading && !loadingUsers && rolePermissions.length === 0" class="text-center py-12 border border-neutral-100 rounded-lg">
      <svg class="mx-auto h-12 w-12 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
      </svg>
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
      <h3 class="text-lg font-semibold text-neutral-900 mb-4">Add Access</h3>
      <form @submit.prevent="handleAddMember" class="space-y-4">
        <div>
          <label for="member-type" class="block text-sm font-medium text-neutral-900 mb-1">
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
          <label for="member-id" class="block text-sm font-medium text-neutral-900 mb-1">
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
          <p v-if="newMemberType === 'group'" class="mt-1 text-xs text-neutral-500">
            The group name from your OAuth provider's wiki_groups field
          </p>
        </div>

        <div>
          <label for="member-role" class="block text-sm font-medium text-neutral-900 mb-1">
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
          <p class="text-sm text-red-600">{{ addMemberError }}</p>
        </div>

        <div class="flex gap-3">
          <button
            type="button"
            @click="showAddMember = false; addMemberError = null; newMemberId = ''; newMemberType = 'user'; newMemberRole = 'viewer';"
            class="flex-1 px-4 py-2 text-sm font-medium text-neutral-900 bg-neutral-100 rounded-md hover:bg-neutral-200 focus:outline-none focus:ring-2 focus:ring-neutral-500"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="addingMember"
            class="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ addingMember ? 'Adding...' : 'Add Access' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
