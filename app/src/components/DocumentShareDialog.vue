<script setup lang="ts">
import { computed, ref, watch } from "vue";
import "@atrium-ui/elements/tabs";
import { Icon } from "~/src/components/index.ts";
import { api } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { isOwner } from "../composeables/usePermissions.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import { getUserInitials } from "../utils/utils.ts";

const props = defineProps<{
  show: boolean;
  documentId: string;
  documentTitle?: string;
}>();

const emit = defineEmits<{ "update:show": [value: boolean] }>();

const { currentSpaceId, currentSpace } = useSpace();
const user = useUserProfile();

type ATabsEl = HTMLElement & { selectTabByIndex: (index: number, focus?: boolean) => void };
const tabsEl = ref<ATabsEl | null>(null);

type Scope = "document" | "space";
const scope = ref<Scope>("document");

const docPermissions = ref<any[]>([]);
const spacePermissions = ref<any[]>([]);
const availableUsers = ref<any[]>([]);
const usersMap = ref(new Map<string, any>());
const isLoading = ref(false);

const newMemberId = ref("");
const newMemberRole = ref("viewer");
const addingMember = ref(false);
const addMemberError = ref<string | null>(null);

const userIsOwner = computed(() => isOwner(currentSpace.value?.userRole));

const roleOptions = computed(() =>
  userIsOwner.value
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
  scope.value = index === 0 ? "document" : "space";
  newMemberId.value = "";
  addMemberError.value = null;
}

async function load() {
  if (!currentSpaceId.value || !props.documentId) return;
  isLoading.value = true;
  try {
    const [docPerms, spacePerms, users] = await Promise.all([
      api.permissions.list(currentSpaceId.value, "role", {
        resourceType: "document",
        resourceId: props.documentId,
      }),
      api.permissions.list(currentSpaceId.value, "role"),
      api.users.get(currentSpaceId.value),
    ]);

    docPermissions.value = (docPerms.permissions || []).filter((p: any) => p.type === "role");
    spacePermissions.value = (spacePerms.permissions || []).filter((p: any) => p.type === "role");

    const map = new Map<string, any>();
    (users || []).forEach((u: any) => map.set(u.id, u));
    usersMap.value = map;
  } catch (err) {
    console.error("Failed to load sharing data:", err);
  } finally {
    isLoading.value = false;
  }
}

async function fetchCandidates() {
  if (!currentSpaceId.value) return;
  try {
    availableUsers.value = (await api.users.candidates(currentSpaceId.value)) || [];
  } catch {
    availableUsers.value = [];
  }
}

watch(
  () => props.show,
  async (open) => {
    if (open) {
      scope.value = "document";
      newMemberId.value = "";
      newMemberRole.value = "viewer";
      addMemberError.value = null;
      await customElements.whenDefined("a-tabs");
      tabsEl.value?.selectTabByIndex(0, false);
      load();
      fetchCandidates();
    }
  },
);

async function handleInvite(e: Event) {
  e.preventDefault();
  if (!currentSpaceId.value || !newMemberId.value) return;

  addingMember.value = true;
  addMemberError.value = null;
  try {
    await api.permissions.grant(currentSpaceId.value, {
      type: "role",
      roleOrFeature: newMemberRole.value,
      userId: newMemberId.value.trim(),
      ...(scope.value === "document"
        ? { resourceType: "document", resourceId: props.documentId }
        : {}),
    });
    newMemberId.value = "";
    await load();
    await fetchCandidates();
  } catch (err) {
    addMemberError.value = err instanceof Error ? err.message : "Failed to invite";
  } finally {
    addingMember.value = false;
  }
}

async function removeDocPerm(perm: any) {
  if (!currentSpaceId.value || !confirm("Remove this person's document access?")) return;
  try {
    await api.permissions.revoke(currentSpaceId.value, {
      type: "role",
      roleOrFeature: perm.permission.permission,
      userId: perm.permission.userId,
      resourceType: "document",
      resourceId: props.documentId,
    });
    await load();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to remove");
  }
}

async function removeSpacePerm(perm: any) {
  if (!currentSpaceId.value || !confirm("Remove this member from the space?")) return;
  try {
    const isGroup = !!perm.permission.groupId;
    const memberId = perm.permission.userId || perm.permission.groupId;
    await api.permissions.revoke(currentSpaceId.value, {
      type: "role",
      roleOrFeature: perm.permission.permission,
      ...(isGroup ? { groupId: memberId } : { userId: memberId }),
    });
    await load();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to remove");
  }
}

async function changeSpaceRole(perm: any, newRole: string) {
  if (!currentSpaceId.value) return;
  try {
    const isGroup = !!perm.permission.groupId;
    const memberId = perm.permission.userId || perm.permission.groupId;
    await api.permissions.grant(currentSpaceId.value, {
      type: "role",
      roleOrFeature: newRole,
      ...(isGroup ? { groupId: memberId } : { userId: memberId }),
    });
    await load();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to update role");
  }
}

function getMemberName(perm: any) {
  if (perm.permission.userId) {
    const u = usersMap.value.get(perm.permission.userId);
    return u?.name || u?.email || perm.permission.userId;
  }
  return perm.permission.groupId;
}

function getMemberEmail(perm: any) {
  if (perm.permission.userId) {
    return usersMap.value.get(perm.permission.userId)?.email || "";
  }
  return "";
}

function roleBadgeClass(role: string) {
  const map: Record<string, string> = {
    owner: "bg-purple-100 text-purple-700",
    editor: "bg-primary-50 text-primary-700",
    viewer: "bg-neutral-100 text-neutral-600",
  };
  return map[role] ?? map.viewer;
}

function isSelf(perm: any) {
  return perm.permission.userId === user.value?.id;
}

function canRemoveSpaceMember(perm: any) {
  if (!userIsOwner.value) return false;
  if (isSelf(perm)) return false;
  if (perm.permission.permission === "owner" && currentSpace.value?.userId === perm.permission.userId) return false;
  return true;
}
</script>

<template>
  <div
    v-if="show"
    class="fixed inset-0 bg-black/20 flex items-center justify-center z-50"
    @click.self="emit('update:show', false)"
  >
    <div class="bg-background rounded-xl shadow-large w-full max-w-md mx-4 border border-neutral-100">

      <!-- Header -->
      <div class="flex items-start justify-between px-4 pt-4 pb-3">
        <div class="min-w-0">
          <h2 class="text-size-title font-semibold text-neutral-900 leading-tight">Share</h2>
          <p v-if="documentTitle" class="text-size-small text-neutral-400 truncate mt-0.5">{{ documentTitle }}</p>
        </div>
        <button
          type="button"
          class="flex-none ml-3 mt-0.5 p-1 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
          @click="emit('update:show', false)"
        >
          <Icon name="close" />
        </button>
      </div>

      <!-- Tabs -->
      <a-tabs ref="tabsEl" @tab-selected="onTabSelected">
        <a-tabs-list class="block border-b border-neutral-100 px-4">
          <a-tabs-tab class="px-1 py-2.5 mr-4 text-size-medium text-neutral-500 border-b-2 border-transparent [&[selected]]:text-neutral-900 [&[selected]]:border-neutral-900">
            This document
          </a-tabs-tab>
          <a-tabs-tab class="px-1 py-2.5 text-size-medium text-neutral-500 border-b-2 border-transparent [&[selected]]:text-neutral-900 [&[selected]]:border-neutral-900">
            Entire space
          </a-tabs-tab>
        </a-tabs-list>

        <!-- Document panel -->
        <a-tabs-panel class="block">
          <div class="px-4 py-3 space-y-3">

            <form @submit.prevent="handleInvite">
              <div class="flex gap-2 items-center">
                <select
                  v-model="newMemberId"
                  required
                  class="flex-1 min-w-0 px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
                >
                  <option value="">Select a person…</option>
                  <option v-for="u in availableUsers" :key="u.id" :value="u.id">
                    {{ u.name || u.email }}
                  </option>
                </select>
                <select
                  v-model="newMemberRole"
                  class="px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
                >
                  <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <button type="submit" :disabled="addingMember || !newMemberId" class="button-primary px-3xs">
                  {{ addingMember ? "…" : "Invite" }}
                </button>
              </div>
              <p v-if="addMemberError" class="mt-1.5 text-size-small text-red-500">{{ addMemberError }}</p>
            </form>

            <div v-if="isLoading" class="flex justify-center py-6">
              <div class="animate-spin rounded-full h-5 w-5 border-2 border-neutral-200 border-t-neutral-600" />
            </div>

            <template v-else>
              <div v-if="docPermissions.length > 0" class="max-h-64 overflow-y-auto divide-y divide-neutral-100">
                <div
                  v-for="perm in docPermissions"
                  :key="perm.permission.userId"
                  class="flex items-center gap-2.5 py-2"
                >
                  <div class="flex-shrink-0 h-7 w-7 rounded-full bg-neutral-200 flex items-center justify-center">
                    <span class="text-neutral-700 text-size-small font-medium leading-none">
                      {{ getUserInitials(getMemberName(perm)) }}
                    </span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-size-medium text-neutral-900 truncate">{{ getMemberName(perm) }}</div>
                    <div v-if="getMemberEmail(perm)" class="text-size-small text-neutral-400 truncate">{{ getMemberEmail(perm) }}</div>
                  </div>
                  <span class="flex-shrink-0 text-size-small font-medium px-2 py-0.5 rounded-full" :class="roleBadgeClass(perm.permission.permission)">
                    {{ perm.permission.permission }}
                  </span>
                  <button
                    v-if="!isSelf(perm)"
                    type="button"
                    class="flex-shrink-0 text-size-small text-neutral-400 hover:text-red-500 transition-colors"
                    @click="removeDocPerm(perm)"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <p v-else class="text-size-small text-neutral-400">
                No one has been given direct access to this document yet.
              </p>

              <p v-if="spacePermissions.length > 0" class="text-size-small text-neutral-400">
                {{ spacePermissions.length }} space member{{ spacePermissions.length !== 1 ? 's' : '' }} can also access this document via their space role.
              </p>
            </template>

          </div>
        </a-tabs-panel>

        <!-- Space panel -->
        <a-tabs-panel class="block">
          <div class="px-4 py-3 space-y-3">

            <form @submit.prevent="handleInvite">
              <div class="flex gap-2 items-center">
                <select
                  v-model="newMemberId"
                  required
                  class="flex-1 min-w-0 px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
                >
                  <option value="">Select a person…</option>
                  <option v-for="u in availableUsers" :key="u.id" :value="u.id">
                    {{ u.name || u.email }}
                  </option>
                </select>
                <select
                  v-model="newMemberRole"
                  class="px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
                >
                  <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <button type="submit" :disabled="addingMember || !newMemberId" class="button-primary px-3xs">
                  {{ addingMember ? "…" : "Invite" }}
                </button>
              </div>
              <p v-if="addMemberError" class="mt-1.5 text-size-small text-red-500">{{ addMemberError }}</p>
            </form>

            <div v-if="isLoading" class="flex justify-center py-6">
              <div class="animate-spin rounded-full h-5 w-5 border-2 border-neutral-200 border-t-neutral-600" />
            </div>

            <template v-else>
              <div v-if="spacePermissions.length > 0" class="max-h-64 overflow-y-auto divide-y divide-neutral-100">
                <div
                  v-for="perm in spacePermissions"
                  :key="perm.permission.userId || perm.permission.groupId"
                  class="flex items-center gap-2.5 py-2"
                >
                  <div class="flex-shrink-0 h-7 w-7 rounded-full bg-neutral-200 flex items-center justify-center">
                    <span class="text-neutral-700 text-size-small font-medium leading-none">
                      {{ getUserInitials(getMemberName(perm)) }}
                    </span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-size-medium text-neutral-900 truncate">{{ getMemberName(perm) }}</div>
                    <div v-if="getMemberEmail(perm)" class="text-size-small text-neutral-400 truncate">{{ getMemberEmail(perm) }}</div>
                  </div>
                  <select
                    v-if="userIsOwner && !isSelf(perm)"
                    :value="perm.permission.permission"
                    @change="(e) => changeSpaceRole(perm, (e.target as HTMLSelectElement).value)"
                    class="text-size-small border border-neutral-200 rounded-md px-2 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-700"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="owner">Owner</option>
                  </select>
                  <span v-else class="flex-shrink-0 text-size-small font-medium px-2 py-0.5 rounded-full" :class="roleBadgeClass(perm.permission.permission)">
                    {{ perm.permission.permission }}
                  </span>
                  <button
                    v-if="canRemoveSpaceMember(perm)"
                    type="button"
                    class="flex-shrink-0 text-size-small text-neutral-400 hover:text-red-500 transition-colors"
                    @click="removeSpacePerm(perm)"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <p v-else class="text-size-small text-neutral-400">
                No space members yet.
              </p>
            </template>

          </div>
        </a-tabs-panel>
      </a-tabs>

    </div>
  </div>
</template>
