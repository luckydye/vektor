<script setup lang="ts">
import { computed, ref, watch } from "vue";
import "@atrium-ui/elements/tabs";
import { api } from "#api/client.ts";
import { isOwner } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { getUserInitials } from "#utils/utils.ts";
import { Dialog } from "~/src/components/index.ts";

const props = defineProps<{
  show: boolean;
  documentId: string;
  documentTitle?: string;
}>();

const emit = defineEmits<{ "update:show": [value: boolean] }>();

const { currentSpaceId, currentSpace } = useSpace();
const user = useUserProfile();

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};
const tabsEl = ref<ATabsEl | null>(null);

type Scope = "document" | "category" | "space";
type DocumentPermissionResource = "document" | "document_tree";
const scope = ref<Scope>("document");
const includeChildPages = ref(false);

const docPermissions = ref<any[]>([]);
const categoryPermissions = ref<any[]>([]);
const spacePermissions = ref<any[]>([]);
const categories = ref<any[]>([]);
const selectedCategoryId = ref("");
const usersMap = ref(new Map<string, any>());
const isLoading = ref(false);

const newMemberEmail = ref("");
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
  scope.value = index === 0 ? "document" : index === 1 ? "category" : "space";
  newMemberEmail.value = "";
  addMemberError.value = null;
}

async function loadCategoryPermissions() {
  if (!currentSpaceId.value || !selectedCategoryId.value) {
    categoryPermissions.value = [];
    return;
  }
  const response = await api.permissions.list(currentSpaceId.value, "role", {
    resourceType: "category",
    resourceId: selectedCategoryId.value,
  });
  categoryPermissions.value = (response.permissions || []).filter(
    (p: any) => p.type === "role",
  );
}

async function load() {
  if (!currentSpaceId.value || !props.documentId) return;
  isLoading.value = true;
  try {
    const [docPerms, docTreePerms, spacePerms, users, categoryList] = await Promise.all([
      api.permissions.list(currentSpaceId.value, "role", {
        resourceType: "document",
        resourceId: props.documentId,
      }),
      api.permissions.list(currentSpaceId.value, "role", {
        resourceType: "document_tree",
        resourceId: props.documentId,
      }),
      api.permissions.list(currentSpaceId.value, "role"),
      api.users.get(currentSpaceId.value),
      api.categories.get(currentSpaceId.value),
    ]);

    categories.value = categoryList || [];
    if (!selectedCategoryId.value && categories.value.length > 0) {
      selectedCategoryId.value = categories.value[0].id;
    }

    docPermissions.value = [
      ...(docPerms.permissions || []),
      ...(docTreePerms.permissions || []),
    ].filter((p: any) => p.type === "role");
    spacePermissions.value = (spacePerms.permissions || []).filter(
      (p: any) => p.type === "role",
    );

    const map = new Map<string, any>();
    (users || []).forEach((u: any) => {
      map.set(u.id, u);
    });
    usersMap.value = map;
    await loadCategoryPermissions();
  } catch (err) {
    console.error("Failed to load sharing data:", err);
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => props.show,
  async (open) => {
    if (open) {
      scope.value = "document";
      newMemberEmail.value = "";
      newMemberRole.value = "viewer";
      includeChildPages.value = false;
      selectedCategoryId.value = "";
      addMemberError.value = null;
      await customElements.whenDefined("a-tabs");
      tabsEl.value?.selectTabByIndex(0, false);
      load();
    }
  },
);

async function handleInvite(e: Event) {
  e.preventDefault();
  if (!currentSpaceId.value || !newMemberEmail.value.trim()) return;
  if (scope.value === "category" && !selectedCategoryId.value) {
    addMemberError.value = "Select a category";
    return;
  }

  addingMember.value = true;
  addMemberError.value = null;
  try {
    await api.permissions.grant(currentSpaceId.value, {
      type: "role",
      roleOrFeature: newMemberRole.value,
      email: newMemberEmail.value.trim(),
      ...(scope.value === "document"
        ? {
            resourceType: (includeChildPages.value
              ? "document_tree"
              : "document") as DocumentPermissionResource,
            resourceId: props.documentId,
          }
        : scope.value === "category"
          ? { resourceType: "category", resourceId: selectedCategoryId.value }
          : {}),
    });
    newMemberEmail.value = "";
    await load();
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
      resourceType: perm.permission.resourceType || "document",
      resourceId: props.documentId,
    });
    await load();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to remove");
  }
}

async function removeCategoryPerm(perm: any) {
  if (
    !currentSpaceId.value ||
    !selectedCategoryId.value ||
    !confirm("Remove this person's category access?")
  )
    return;
  try {
    await api.permissions.revoke(currentSpaceId.value, {
      type: "role",
      roleOrFeature: perm.permission.permission,
      userId: perm.permission.userId,
      groupId: perm.permission.groupId,
      resourceType: "category",
      resourceId: selectedCategoryId.value,
    });
    await loadCategoryPermissions();
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

function permissionScopeLabel(perm: any) {
  return perm.permission.resourceType === "document_tree"
    ? "Includes child pages"
    : "This document only";
}

function isSelf(perm: any) {
  return perm.permission.userId === user.value?.id;
}

function canRemoveSpaceMember(perm: any) {
  if (!userIsOwner.value) return false;
  if (isSelf(perm)) return false;
  if (
    perm.permission.permission === "owner" &&
    currentSpace.value?.userId === perm.permission.userId
  )
    return false;
  return true;
}
</script>

<template>
  <Dialog
    :show="show"
    body-class="p-0 overflow-y-auto"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="min-w-0">
        <h2 class="text-size-title font-semibold text-neutral-900 leading-tight">
          Share
        </h2>
        <p v-if="documentTitle" class="text-size-small text-neutral-400 truncate mt-0.5">
          {{ documentTitle }}
        </p>
      </div>
    </template>

    <!-- Tabs -->
    <a-tabs ref="tabsEl" @tab-selected="onTabSelected">
      <a-tabs-list class="block h-[51px] py-4xs">
        <a-tabs-tab
          class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label text-black hover:[&_span]:bg-gray-200 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
        >
          <span
            class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
            >This document</span
          >
        </a-tabs-tab>
        <a-tabs-tab
          class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label text-black hover:[&_span]:bg-gray-200 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
        >
          <span
            class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
            >Category</span
          >
        </a-tabs-tab>
        <a-tabs-tab
          class="inline-flex h-[27px] items-center justify-center px-5xs rounded-sm text-label text-black hover:[&_span]:bg-gray-200 [&[selected]_span]:bg-gray-100 [&[selected]:hover_span]:bg-gray-100"
        >
          <span
            class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors"
            >Entire space</span
          >
        </a-tabs-tab>
      </a-tabs-list>

      <!-- Document panel -->
      <a-tabs-panel class="block">
        <div class="px-4 py-3 space-y-3">
          <form @submit.prevent="handleInvite">
            <div class="flex flex-wrap gap-2 items-center">
              <input
                v-model="newMemberEmail"
                type="email"
                required
                placeholder="person@example.com"
                class="flex-1 min-w-0 px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
              >
              <select
                v-model="newMemberRole"
                class="px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
              >
                <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
              <label
                class="inline-flex items-center gap-1.5 text-size-small text-neutral-600 whitespace-nowrap"
              >
                <input
                  v-model="includeChildPages"
                  type="checkbox"
                  class="h-4 w-4 rounded border-neutral-200 text-neutral-900 focus:ring-neutral-400"
                >
                <span>Include child pages</span>
              </label>
              <button
                type="submit"
                :disabled="addingMember || !newMemberEmail.trim()"
                class="button-primary px-3xs"
              >
                {{ addingMember ? "…" : "Invite" }}
              </button>
            </div>
            <p v-if="addMemberError" class="mt-1.5 text-size-small text-red-500">
              {{ addMemberError }}
            </p>
          </form>

          <div v-if="isLoading" class="flex justify-center py-6">
            <div
              class="animate-spin rounded-full h-5 w-5 border-2 border-neutral-200 border-t-neutral-600"
            />
          </div>

          <template v-else>
            <div
              v-if="docPermissions.length > 0"
              class="max-h-64 overflow-y-auto divide-y divide-neutral-100"
            >
              <div
                v-for="perm in docPermissions"
                :key="`${perm.permission.resourceType}-${perm.permission.userId || perm.permission.groupId}`"
                class="flex items-center gap-2.5 py-2"
              >
                <div
                  class="flex-shrink-0 h-7 w-7 rounded-full bg-neutral-200 flex items-center justify-center"
                >
                  <span class="text-neutral-700 text-size-small font-medium leading-none">
                    {{ getUserInitials(getMemberName(perm)) }}
                  </span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-size-medium text-neutral-900 truncate">
                    {{ getMemberName(perm) }}
                  </div>
                  <div
                    v-if="getMemberEmail(perm)"
                    class="text-size-small text-neutral-400 truncate"
                  >
                    {{ getMemberEmail(perm) }}
                  </div>
                  <div class="text-size-small text-neutral-400 truncate">
                    {{ permissionScopeLabel(perm) }}
                  </div>
                </div>
                <span
                  class="flex-shrink-0 text-size-small font-medium px-2 py-0.5 rounded-full"
                  :class="roleBadgeClass(perm.permission.permission)"
                >
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

            <p
              v-if="spacePermissions.length > 0"
              class="text-size-small text-neutral-400"
            >
              {{ spacePermissions.length }}
              space member{{ spacePermissions.length !== 1 ? 's' : '' }}
              can also access this document via their space role.
            </p>
          </template>
        </div>
      </a-tabs-panel>

      <!-- Category panel -->
      <a-tabs-panel class="block">
        <div class="px-4 py-3 space-y-3">
          <select
            v-model="selectedCategoryId"
            class="w-full px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
            @change="loadCategoryPermissions"
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

          <form @submit.prevent="handleInvite">
            <div class="flex flex-wrap gap-2 items-center">
              <input
                v-model="newMemberEmail"
                type="email"
                required
                placeholder="person@example.com"
                class="flex-1 min-w-0 px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
              >
              <select
                v-model="newMemberRole"
                class="px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
              >
                <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
              <button
                type="submit"
                :disabled="addingMember || !newMemberEmail.trim() || !selectedCategoryId"
                class="button-primary px-3xs"
              >
                {{ addingMember ? "..." : "Invite" }}
              </button>
            </div>
            <p v-if="addMemberError" class="mt-1.5 text-size-small text-red-500">
              {{ addMemberError }}
            </p>
          </form>

          <div v-if="isLoading" class="flex justify-center py-6">
            <div
              class="animate-spin rounded-full h-5 w-5 border-2 border-neutral-200 border-t-neutral-600"
            />
          </div>

          <template v-else>
            <div
              v-if="categoryPermissions.length > 0"
              class="max-h-64 overflow-y-auto divide-y divide-neutral-100"
            >
              <div
                v-for="perm in categoryPermissions"
                :key="`${perm.permission.resourceType}-${perm.permission.userId || perm.permission.groupId}`"
                class="flex items-center gap-2.5 py-2"
              >
                <div
                  class="flex-shrink-0 h-7 w-7 rounded-full bg-neutral-200 flex items-center justify-center"
                >
                  <span class="text-neutral-700 text-size-small font-medium leading-none">
                    {{ getUserInitials(getMemberName(perm)) }}
                  </span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-size-medium text-neutral-900 truncate">
                    {{ getMemberName(perm) }}
                  </div>
                  <div
                    v-if="getMemberEmail(perm)"
                    class="text-size-small text-neutral-400 truncate"
                  >
                    {{ getMemberEmail(perm) }}
                  </div>
                </div>
                <span
                  class="flex-shrink-0 text-size-small font-medium px-2 py-0.5 rounded-full"
                  :class="roleBadgeClass(perm.permission.permission)"
                >
                  {{ perm.permission.permission }}
                </span>
                <button
                  v-if="!isSelf(perm)"
                  type="button"
                  class="flex-shrink-0 text-size-small text-neutral-400 hover:text-red-500 transition-colors"
                  @click="removeCategoryPerm(perm)"
                >
                  Remove
                </button>
              </div>
            </div>
            <p v-else class="text-size-small text-neutral-400">
              No one has been given direct access to this category yet.
            </p>
          </template>
        </div>
      </a-tabs-panel>

      <!-- Space panel -->
      <a-tabs-panel class="block">
        <div class="px-4 py-3 space-y-3">
          <form @submit.prevent="handleInvite">
            <div class="flex gap-2 items-center">
              <input
                v-model="newMemberEmail"
                type="email"
                required
                placeholder="person@example.com"
                class="flex-1 min-w-0 px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
              >
              <select
                v-model="newMemberRole"
                class="px-2.5 py-1.5 border border-neutral-200 rounded-md text-size-medium bg-background focus:outline-none focus:ring-1 focus:ring-neutral-400 text-neutral-900"
              >
                <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
              <button
                type="submit"
                :disabled="addingMember || !newMemberEmail.trim()"
                class="button-primary px-3xs"
              >
                {{ addingMember ? "…" : "Invite" }}
              </button>
            </div>
            <p v-if="addMemberError" class="mt-1.5 text-size-small text-red-500">
              {{ addMemberError }}
            </p>
          </form>

          <div v-if="isLoading" class="flex justify-center py-6">
            <div
              class="animate-spin rounded-full h-5 w-5 border-2 border-neutral-200 border-t-neutral-600"
            />
          </div>

          <template v-else>
            <div
              v-if="spacePermissions.length > 0"
              class="max-h-64 overflow-y-auto divide-y divide-neutral-100"
            >
              <div
                v-for="perm in spacePermissions"
                :key="perm.permission.userId || perm.permission.groupId"
                class="flex items-center gap-2.5 py-2"
              >
                <div
                  class="flex-shrink-0 h-7 w-7 rounded-full bg-neutral-200 flex items-center justify-center"
                >
                  <span class="text-neutral-700 text-size-small font-medium leading-none">
                    {{ getUserInitials(getMemberName(perm)) }}
                  </span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-size-medium text-neutral-900 truncate">
                    {{ getMemberName(perm) }}
                  </div>
                  <div
                    v-if="getMemberEmail(perm)"
                    class="text-size-small text-neutral-400 truncate"
                  >
                    {{ getMemberEmail(perm) }}
                  </div>
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
                <span
                  v-else
                  class="flex-shrink-0 text-size-small font-medium px-2 py-0.5 rounded-full"
                  :class="roleBadgeClass(perm.permission.permission)"
                >
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
            <p v-else class="text-size-small text-neutral-400">No space members yet.</p>
          </template>
        </div>
      </a-tabs-panel>
    </a-tabs>
  </Dialog>
</template>
