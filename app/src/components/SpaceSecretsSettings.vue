<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, type SpaceSecret } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import Button from "./Button.vue";

const { currentSpace } = useSpace();
const toast = useToast();

const secrets = ref<SpaceSecret[]>([]);
const isLoadingSecrets = ref(false);
const secretsError = ref<string | null>(null);
const isCreatingSecret = ref(false);
const isSubmittingSecret = ref(false);
const newSecretName = ref("");
const newSecretDescription = ref("");
const newSecretValue = ref("");
const selectedSecretName = ref<string | null>(null);
const selectedSecretValue = ref<string | null>(null);
const isLoadingSecretValue = ref(false);
const selectedGrantUserId = ref("");
const isGrantingSecretAccess = ref(false);
const secretPermissions = ref<
  Array<{ userId?: string; groupId?: string; permission: string }>
>([]);
const isLoadingSecretPermissions = ref(false);
const secretAssignableUsers = ref<Array<{ id: string; name: string; email: string }>>([]);
const isLoadingSecretUsers = ref(false);

const availableSecretGrantUsers = computed(() => {
  const grantedUserIds = new Set(
    secretPermissions.value.map((p) => p.userId).filter((id): id is string => !!id),
  );
  return secretAssignableUsers.value.filter((u) => !grantedUserIds.has(u.id));
});

const secretUsersById = computed(() => {
  const byId = new Map<string, { id: string; name: string; email: string }>();
  for (const u of secretAssignableUsers.value) {
    byId.set(u.id, u);
  }
  return byId;
});

function formatSecretPermissionTarget(perm: {
  userId?: string;
  groupId?: string;
  permission: string;
}): string {
  if (perm.userId) {
    const user = secretUsersById.value.get(perm.userId);
    if (user) {
      return `${user.name} (${user.email})`;
    }
    return perm.userId;
  }
  return perm.groupId ? `Group: ${perm.groupId}` : "Unknown";
}

async function loadSecretAssignableUsers() {
  if (!currentSpace.value?.id) return;
  isLoadingSecretUsers.value = true;
  try {
    const members = await api.spaceMembers.get(currentSpace.value.id);
    const users = new Map<string, { id: string; name: string; email: string }>();

    for (const member of members) {
      if (member.userId && member.user) {
        users.set(member.userId, {
          id: member.user.id,
          name: member.user.name || member.user.email,
          email: member.user.email,
        });
      }
    }

    secretAssignableUsers.value = [...users.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    console.error("Failed to load secret assignable users", error);
    secretAssignableUsers.value = [];
  } finally {
    isLoadingSecretUsers.value = false;
  }
}

async function loadSecrets() {
  if (!currentSpace.value?.id) return;
  isLoadingSecrets.value = true;
  secretsError.value = null;

  try {
    const response = await api.secrets.get(currentSpace.value.id);
    secrets.value = response.secrets || [];
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to load secrets";
    secrets.value = [];
  } finally {
    isLoadingSecrets.value = false;
  }
}

function handleCancelCreateSecret() {
  isCreatingSecret.value = false;
  newSecretName.value = "";
  newSecretDescription.value = "";
  newSecretValue.value = "";
}

async function handleCreateSecret() {
  if (!currentSpace.value?.id) return;
  isSubmittingSecret.value = true;
  secretsError.value = null;

  try {
    await api.secrets.create(currentSpace.value.id, {
      name: newSecretName.value.trim(),
      value: newSecretValue.value,
      description: newSecretDescription.value.trim() || null,
    });
    handleCancelCreateSecret();
    await loadSecrets();
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to save secret";
  } finally {
    isSubmittingSecret.value = false;
  }
}

async function handleRevealSecret(name: string) {
  if (!currentSpace.value?.id) return;
  selectedSecretName.value = name;
  selectedSecretValue.value = null;
  secretPermissions.value = [];
  selectedGrantUserId.value = "";
  isLoadingSecretValue.value = true;
  isLoadingSecretPermissions.value = true;
  secretsError.value = null;

  try {
    const [secret, perms] = await Promise.all([
      api.secrets.getByName(currentSpace.value.id, name),
      api.permissions.list(currentSpace.value.id, "role", {
        resourceType: "secret",
        resourceId: name,
      }),
    ]);
    selectedSecretValue.value = secret.value;
    secretPermissions.value = (perms.permissions || [])
      .filter((p) => p.type === "role")
      .map((p) => p.permission)
      .filter((p) => p.userId || p.groupId);
    selectedGrantUserId.value = availableSecretGrantUsers.value[0]?.id || "";
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to load secret";
  } finally {
    isLoadingSecretValue.value = false;
    isLoadingSecretPermissions.value = false;
  }
}

async function handleRotateSecret(name: string) {
  if (!currentSpace.value?.id) return;
  const newValue = window.prompt(`Enter new value for ${name}`);
  if (!newValue) return;

  const meta = secrets.value.find((s) => s.name === name);
  try {
    await api.secrets.update(currentSpace.value.id, name, {
      value: newValue,
      description: meta?.description || null,
    });
    if (selectedSecretName.value === name) {
      selectedSecretValue.value = null;
    }
    await loadSecrets();
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to rotate secret";
  }
}

async function handleDeleteSecret(name: string) {
  if (!currentSpace.value?.id) return;
  if (!confirm(`Delete secret '${name}'?`)) return;

  try {
    await api.secrets.delete(currentSpace.value.id, name);
    if (selectedSecretName.value === name) {
      selectedSecretName.value = null;
      selectedSecretValue.value = null;
      secretPermissions.value = [];
    }
    await loadSecrets();
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to delete secret";
  }
}

async function handleGrantSecretAccess() {
  if (!currentSpace.value?.id || !selectedSecretName.value || !selectedGrantUserId.value)
    return;
  isGrantingSecretAccess.value = true;
  secretsError.value = null;

  try {
    await api.permissions.grant(currentSpace.value.id, {
      type: "role",
      roleOrFeature: "viewer",
      userId: selectedGrantUserId.value,
      resourceType: "secret",
      resourceId: selectedSecretName.value,
    });
    selectedGrantUserId.value = "";
    await handleRevealSecret(selectedSecretName.value);
  } catch (err) {
    secretsError.value =
      err instanceof Error ? err.message : "Failed to grant secret access";
  } finally {
    isGrantingSecretAccess.value = false;
  }
}

async function handleRevokeSecretAccess(userId: string) {
  if (!currentSpace.value?.id || !selectedSecretName.value) return;

  try {
    await api.permissions.revoke(currentSpace.value.id, {
      type: "role",
      roleOrFeature: "viewer",
      userId,
      resourceType: "secret",
      resourceId: selectedSecretName.value,
    });
    await handleRevealSecret(selectedSecretName.value);
  } catch (err) {
    secretsError.value =
      err instanceof Error ? err.message : "Failed to revoke secret access";
  }
}

async function handleCopySelectedSecret() {
  if (!selectedSecretValue.value) return;
  await navigator.clipboard.writeText(selectedSecretValue.value);
}

function reload() {
  loadSecrets();
  loadSecretAssignableUsers();
}

onMounted(reload);
watch(
  () => currentSpace.value?.id,
  (id) => {
    if (id) reload();
  },
);
</script>

<template>
  <div class="mt-8 pt-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">Secrets</h2>
      <button
        type="button"
        v-if="!isCreatingSecret"
        @click="isCreatingSecret = true"
        class="text-size-small text-blue-600 hover:text-blue-800 font-medium"
      >
        + Create Secret
      </button>
    </div>

    <div
      v-if="secretsError"
      class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600"
    >
      {{ secretsError }}
    </div>

    <div
      v-if="isCreatingSecret"
      class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md"
    >
      <form @submit.prevent="handleCreateSecret" class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
            <label class="block text-size-small font-medium text-neutral-700 mb-1"
              >Name</label
            >
            <input
              v-model="newSecretName"
              type="text"
              required
              placeholder="e.g. OPENAI_API_KEY"
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring font-mono"
            >
          </div>
          <div>
            <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
            <label class="block text-size-small font-medium text-neutral-700 mb-1"
              >Description</label
            >
            <input
              v-model="newSecretDescription"
              type="text"
              placeholder="Optional description"
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring"
            >
          </div>
          <div class="md:col-span-2">
            <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
            <label class="block text-size-small font-medium text-neutral-700 mb-1"
              >Secret Value</label
            >
            <input
              v-model="newSecretValue"
              type="password"
              required
              placeholder="Will be encrypted at rest"
              class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring font-mono"
            >
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            @click="handleCancelCreateSecret"
            class="px-3 py-1.5 text-size-medium text-neutral-600 hover:text-neutral-800"
          >
            Cancel
          </button>
          <Button
            type="submit"
            :disabled="isSubmittingSecret"
            :text="isSubmittingSecret ? 'Saving...' : 'Save Secret'"
          />
        </div>
      </form>
    </div>

    <div
      v-if="isLoadingSecrets"
      class="text-center py-6 text-size-medium text-neutral-500"
    >
      Loading secrets...
    </div>
    <div
      v-else-if="secrets.length === 0 && !isCreatingSecret"
      class="text-center py-6 text-size-medium text-neutral-500"
    >
      No secrets configured
    </div>
    <div
      v-else-if="secrets.length > 0"
      class="overflow-x-auto border border-neutral-100 rounded-md"
    >
      <table class="min-w-full text-size-medium">
        <thead class="bg-neutral-50">
          <tr>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Name
            </th>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Description
            </th>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Last Used
            </th>
            <th
              class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Updated
            </th>
            <th
              class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide"
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-100">
          <tr v-for="secret in secrets" :key="secret.name" class="hover:bg-neutral-50">
            <td class="px-4 py-2.5 font-medium text-neutral-900 font-mono">
              {{ secret.name }}
            </td>
            <td class="px-4 py-2.5 text-neutral-600">
              {{ secret.description || "—" }}
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">
              {{ secret.lastUsedAt ? formatAbsoluteDate(secret.lastUsedAt) : "—" }}
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">
              {{ formatAbsoluteDate(secret.updatedAt) }}
            </td>
            <td class="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
              <button
                type="button"
                @click="handleRevealSecret(secret.name)"
                class="text-size-small text-blue-600 hover:text-blue-800"
              >
                Reveal
              </button>
              <button
                type="button"
                @click="handleRotateSecret(secret.name)"
                class="text-size-small text-neutral-500 hover:text-neutral-700"
              >
                Rotate
              </button>
              <button
                type="button"
                @click="handleDeleteSecret(secret.name)"
                class="text-size-small text-red-600 hover:text-red-800"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="selectedSecretName"
      class="mt-4 p-3 bg-neutral-50 border border-neutral-200 rounded-md"
    >
      <div class="flex items-center justify-between mb-2">
        <p class="text-size-small font-medium text-neutral-700">
          Secret: <span class="font-mono">{{ selectedSecretName }}</span>
        </p>
        <button
          type="button"
          @click="selectedSecretName = null; selectedSecretValue = null;"
          class="text-size-small text-neutral-500 hover:text-neutral-700"
        >
          Close
        </button>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <code
          class="flex-1 px-2 py-1.5 text-size-small bg-background border border-neutral-200 rounded-sm font-mono break-all select-all"
          >{{ selectedSecretValue ?? (isLoadingSecretValue ? "Loading..." : "Not loaded") }}</code
        >
        <button
          type="button"
          @click="handleCopySelectedSecret"
          :disabled="!selectedSecretValue"
          class="shrink-0 px-2 py-1.5 text-size-small font-medium text-neutral-700 bg-neutral-100 border border-neutral-200 rounded-sm hover:bg-neutral-200 disabled:opacity-50"
        >
          Copy
        </button>
      </div>

      <div class="pt-3 border-t border-neutral-200">
        <p class="text-size-small font-medium text-neutral-700 mb-2">Grant Access</p>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <select
            v-model="selectedGrantUserId"
            class="flex-1 px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring min-w-[200px]"
          >
            <option value="" disabled>
              {{ isLoadingSecretUsers
                        ? "Loading users..."
                        : availableSecretGrantUsers.length > 0
                            ? "Select user"
                            : "No available users" }}
            </option>
            <option v-for="u in availableSecretGrantUsers" :key="u.id" :value="u.id">
              {{ u.name }}
              ({{ u.email }})
            </option>
          </select>
          <Button
            class="text-size-small"
            :disabled="!selectedGrantUserId || !selectedSecretName || isGrantingSecretAccess"
            :text="isGrantingSecretAccess ? 'Granting...' : 'Grant Viewer'"
            @click="handleGrantSecretAccess"
          />
        </div>

        <div
          v-if="isLoadingSecretPermissions"
          class="mt-2 text-size-small text-neutral-500"
        >
          Loading grants...
        </div>
        <div v-else-if="secretPermissions.length > 0" class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="perm in secretPermissions"
            :key="`${perm.userId || perm.groupId}-${perm.permission}`"
            class="inline-flex items-center gap-1 px-2 py-1 text-size-small bg-blue-50 text-blue-700 rounded-sm"
          >
            {{ formatSecretPermissionTarget(perm) }}
            ({{ perm.permission }})
            <button
              type="button"
              v-if="perm.userId"
              @click="handleRevokeSecretAccess(perm.userId)"
              class="text-blue-500 hover:text-blue-700"
            >
              ×
            </button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
