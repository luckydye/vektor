<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { type AccessToken, api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { formatAbsoluteDate } from "#utils/datetime.ts";

const { currentSpace } = useSpace();
const toast = useToast();

const accessTokens = ref<AccessToken[]>([]);
const isLoadingTokens = ref(false);
const tokenError = ref<string | null>(null);
const isCreatingToken = ref(false);
const isSubmittingToken = ref(false);
const newTokenName = ref("");
const newTokenPermission = ref("editor");
const newTokenResourceType = ref("space");
const newTokenResourceId = ref("");
const newTokenExpiresInDays = ref<number | null>(null);
const createdTokenValue = ref<string | null>(null);
const tokenCopied = ref(false);

function resourceLabel(resource: {
  resourceType: string;
  resourceId: string;
  permission: string;
}): string {
  if (
    resource.resourceType === "feature" &&
    resource.resourceId === "manage_extensions"
  ) {
    return "Extensions (install/update)";
  }
  if (resource.resourceType === "feature") {
    return `Feature: ${resource.resourceId}`;
  }
  return `${resource.resourceType}: ${resource.resourceId} (${resource.permission})`;
}

async function loadAccessTokens() {
  if (!currentSpace.value?.id) return;
  isLoadingTokens.value = true;
  tokenError.value = null;

  try {
    const response = await api.accessTokens.get(currentSpace.value.id);
    accessTokens.value = response.tokens || [];
  } catch {
    tokenError.value = "Failed to load access tokens";
    accessTokens.value = [];
  } finally {
    isLoadingTokens.value = false;
  }
}

async function handleRevokeToken(tokenId: string) {
  if (!currentSpace.value?.id) return;
  if (!confirm("Are you sure you want to revoke this token?")) return;
  tokenError.value = null;

  try {
    await api.accessTokens.revoke(currentSpace.value.id, tokenId);
    await loadAccessTokens();
  } catch {
    tokenError.value = "Failed to revoke token";
  }
}

async function handleDeleteToken(tokenId: string) {
  if (!currentSpace.value?.id) return;
  if (!confirm("Are you sure you want to delete this token?")) return;
  tokenError.value = null;

  try {
    await api.accessTokens.delete(currentSpace.value.id, tokenId);
    await loadAccessTokens();
  } catch {
    tokenError.value = "Failed to delete token";
  }
}

function handleStartCreateToken() {
  isCreatingToken.value = true;
  newTokenName.value = "";
  newTokenPermission.value = "editor";
  newTokenResourceType.value = "space";
  newTokenResourceId.value = currentSpace.value?.id ?? "";
  newTokenExpiresInDays.value = null;
  tokenError.value = null;
}

function handleCancelCreateToken() {
  isCreatingToken.value = false;
}

async function handleCreateToken() {
  if (!currentSpace.value?.id) return;
  isSubmittingToken.value = true;
  tokenError.value = null;

  try {
    const isExtensionsCapability = newTokenPermission.value === "extensions";
    const result = await api.accessTokens.create(currentSpace.value.id, {
      name: newTokenName.value.trim(),
      permission: newTokenPermission.value,
      // The "extensions" capability is space-wide and has no resource target.
      ...(isExtensionsCapability
        ? {}
        : {
            resourceType: newTokenResourceType.value,
            resourceId:
              newTokenResourceType.value === "space"
                ? currentSpace.value.id
                : newTokenResourceId.value.trim(),
          }),
      ...(newTokenExpiresInDays.value
        ? { expiresInDays: newTokenExpiresInDays.value }
        : {}),
    });
    createdTokenValue.value = result.token;
    tokenCopied.value = false;
    isCreatingToken.value = false;
    await loadAccessTokens();
  } catch (err) {
    tokenError.value = err instanceof Error ? err.message : "Failed to create token";
  } finally {
    isSubmittingToken.value = false;
  }
}

async function handleCopyToken() {
  if (!createdTokenValue.value) return;
  await navigator.clipboard.writeText(createdTokenValue.value);
  tokenCopied.value = true;
}

onMounted(loadAccessTokens);
watch(
  () => currentSpace.value?.id,
  (id) => {
    if (id) loadAccessTokens();
  },
);

watch(newTokenResourceType, (type) => {
  if (type === "space") {
    newTokenResourceId.value = currentSpace.value?.id ?? "";
  } else {
    newTokenResourceId.value = "";
  }
});
</script>

<template>
  <section class="mt-8 pt-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">
        Access Tokens
      </h2>
      <button
        type="button"
        v-if="!isCreatingToken"
        @click="handleStartCreateToken"
        class="text-size-small text-blue-600 hover:text-blue-800 font-medium"
      >
        + Create Token
      </button>
    </div>
    <div>
      <div
        v-if="tokenError"
        class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600"
      >
        {{ tokenError }}
      </div>

      <!-- Create Token Form -->
      <div
        v-if="isCreatingToken"
        class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md"
      >
        <form @submit.prevent="handleCreateToken" class="space-y-3">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
              <label class="block text-size-small font-medium text-neutral-700 mb-1"
                >Name</label
              >
              <input
                v-model="newTokenName"
                type="text"
                required
                placeholder="e.g. CI Deploy Token"
                class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring"
              >
            </div>
            <div>
              <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
              <label class="block text-size-small font-medium text-neutral-700 mb-1"
                >Permission</label
              >
              <select
                v-model="newTokenPermission"
                class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="extensions">Extensions (install/update)</option>
              </select>
            </div>
            <template v-if="newTokenPermission !== 'extensions'">
              <div>
                <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
                <label class="block text-size-small font-medium text-neutral-700 mb-1"
                  >Resource Type</label
                >
                <select
                  v-model="newTokenResourceType"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring"
                >
                  <option value="space">Space</option>
                  <option value="document">Document</option>
                  <option value="extension">Extension</option>
                </select>
              </div>
              <div>
                <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
                <label class="block text-size-small font-medium text-neutral-700 mb-1">
                  Resource ID
                  <span
                    v-if="newTokenResourceType === 'space'"
                    class="text-neutral-400 font-normal"
                    >(space ID auto-filled)</span
                  >
                </label>
                <input
                  v-model="newTokenResourceId"
                  type="text"
                  required
                  :disabled="newTokenResourceType === 'space'"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring disabled:bg-neutral-100 disabled:text-neutral-400"
                >
              </div>
            </template>
            <div
              v-else
              class="md:col-span-2 text-size-small text-neutral-500 self-center"
            >
              Grants space-wide permission to install and update extensions. No resource
              needed.
            </div>
            <div>
              <!-- biome-ignore lint/a11y/noLabelWithoutControl: The Vue template control association is resolved by the rendered component. -->
              <label class="block text-size-small font-medium text-neutral-700 mb-1"
                >Expires in days
                <span class="text-neutral-400 font-normal">(optional)</span></label
              >
              <input
                v-model.number="newTokenExpiresInDays"
                type="number"
                min="1"
                placeholder="Never"
                class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus-ring"
              >
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              @click="handleCancelCreateToken"
              class="px-3 py-1.5 text-size-medium text-neutral-600 hover:text-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              :disabled="isSubmittingToken"
              class="px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {{ isSubmittingToken ? 'Creating...' : 'Create Token' }}
            </button>
          </div>
        </form>
      </div>

      <!-- Created Token Display (shown once after creation) -->
      <div
        v-if="createdTokenValue"
        class="mb-4 p-3 bg-green-50 border border-green-200 rounded-md"
      >
        <p class="text-size-small font-medium text-green-800 mb-2">
          Token created — copy it now, it won't be shown again.
        </p>
        <div class="flex items-center gap-2">
          <code
            class="flex-1 px-2 py-1.5 text-size-small bg-background border border-green-200 rounded-sm font-mono break-all select-all"
            >{{ createdTokenValue }}</code
          >
          <button
            type="button"
            @click="handleCopyToken"
            class="shrink-0 px-2 py-1.5 text-size-small font-medium text-green-700 bg-green-100 border border-green-300 rounded-sm hover:bg-green-200"
          >
            {{ tokenCopied ? 'Copied!' : 'Copy' }}
          </button>
        </div>
        <button
          type="button"
          @click="createdTokenValue = null; tokenCopied = false"
          class="mt-2 text-size-small text-green-700 hover:text-green-900"
        >
          Dismiss
        </button>
      </div>

      <div
        v-if="isLoadingTokens"
        class="text-center py-6 text-size-medium text-neutral-500"
      >
        Loading tokens...
      </div>
      <div
        v-else-if="accessTokens.length === 0 && !isCreatingToken"
        class="text-center py-6 text-size-medium text-neutral-500"
      >
        No access tokens created yet
      </div>
      <div
        v-else-if="accessTokens.length > 0"
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
                Status
              </th>
              <th
                class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
              >
                Resources
              </th>
              <th
                class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
              >
                Last Used
              </th>
              <th
                class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide"
              >
                Expires
              </th>
              <th
                class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-neutral-100">
            <tr v-for="token in accessTokens" :key="token.id" class="hover:bg-neutral-50">
              <td class="px-4 py-2.5 font-medium text-neutral-900">
                {{ token.name }}
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap">
                <span
                  v-if="token.revokedAt"
                  class="px-1.5 py-0.5 text-size-small rounded-sm bg-red-100 text-red-700"
                  >Revoked</span
                >
                <span
                  v-else-if="token.expiresAt && new Date(token.expiresAt) < new Date()"
                  class="px-1.5 py-0.5 text-size-small rounded-sm bg-yellow-100 text-yellow-700"
                  >Expired</span
                >
                <span
                  v-else
                  class="px-1.5 py-0.5 text-size-small rounded-sm bg-green-100 text-green-700"
                  >Active</span
                >
              </td>
              <td class="px-4 py-2.5">
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="resource in token.resources"
                    :key="`${resource.resourceType}-${resource.resourceId}`"
                    class="px-1.5 py-0.5 text-size-small bg-blue-50 text-blue-700 rounded-sm"
                  >
                    {{ resourceLabel(resource) }}
                  </span>
                  <span
                    v-if="!token.resources?.length"
                    class="text-size-small text-neutral-400 italic"
                    >None</span
                  >
                </div>
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">
                {{ token.lastUsedAt ? formatAbsoluteDate(token.lastUsedAt) : '—' }}
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">
                {{ token.expiresAt ? formatAbsoluteDate(token.expiresAt) : '—' }}
              </td>
              <td class="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
                <button
                  type="button"
                  v-if="!token.revokedAt"
                  @click="handleRevokeToken(token.id)"
                  class="text-size-small text-red-600 hover:text-red-800"
                >
                  Revoke
                </button>
                <button
                  type="button"
                  @click="handleDeleteToken(token.id)"
                  class="text-size-small text-neutral-500 hover:text-neutral-700"
                >
                  Delete
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
