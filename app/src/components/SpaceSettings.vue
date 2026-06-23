<template>
  <SettingsLayout :tabs="tabs" :initial-tab="tabFromHash()" @tab-change="setTab">

    <!-- General Settings -->
    <template #general>
      <div>

        <!-- Profile: form + sticky preview -->
        <div class="flex flex-col-reverse sm:flex-row gap-8 sm:gap-10 items-start">

          <!-- Form -->
          <form class="flex-1 min-w-0 w-full" @submit.prevent="handleSave">
            <div class="space-y-4">
              <div>
                <label for="settings-space-name" class="block text-size-small font-medium text-neutral-700 mb-1">Name</label>
                <input id="settings-space-name" v-model="localName" type="text" required
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label for="settings-space-slug" class="block text-size-small font-medium text-neutral-700 mb-1">Slug</label>
                <input id="settings-space-slug" v-model="localSlug" type="text" required pattern="[a-z0-9-]+"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
                <p class="mt-1 text-size-small text-neutral-400">Lowercase letters, numbers and hyphens only</p>
              </div>
              <div>
                <label for="settings-space-description" class="block text-size-small font-medium text-neutral-700 mb-1">Description</label>
                <input id="settings-space-description" v-model="localDescription" type="text"
                  placeholder="e.g., Engineering / Documentation"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div v-if="error" class="mt-4 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
              {{ error }}
            </div>
            <div class="mt-6 flex justify-end">
              <button type="submit" :disabled="isSaving"
                class="px-4 py-1.5 text-size-medium font-medium text-neutral-10 bg-neutral-900 rounded-md hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-500 disabled:opacity-50 transition-colors">
                {{ isSaving ? 'Saving…' : 'Save Changes' }}
              </button>
            </div>
          </form>

          <!-- Interactive preview card — sticky -->
          <div class="w-full sm:w-72 shrink-0 sm:sticky top-4">
            <p class="text-size-small text-neutral-400 mb-2">Click to edit</p>
            <div class="rounded-xl border border-neutral-200 overflow-hidden">

              <!-- Banner — click to pick color -->
              <a-popover-trigger showdelay="0" hidedelay="100" class="block">
                <div slot="trigger" class="relative h-24 w-full cursor-pointer group transition-colors duration-300"
                  :style="{ backgroundColor: localBrandColor }" title="Change color">
                  <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                    <span class="text-[11px] font-medium text-white drop-shadow">Change color</span>
                  </div>
                </div>
                <a-popover class="group" placements="bottom-start">
                  <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                    <div class="bg-background border border-neutral-100 rounded-lg p-2 origin-top-left scale-95 transition-all shadow-large duration-150 group-[&[enabled]]:scale-100">
                      <a-color-picker
                        class="w-[220px]"
                        :value="localBrandColor"
                        @change="localBrandColor = ($event.target as HTMLElement & { value: string }).value"
                      ></a-color-picker>
                    </div>
                  </div>
                </a-popover>
              </a-popover-trigger>

              <div class="px-3 pb-3">
                <div class="-mt-8 mb-2.5 flex items-end gap-1.5">
                  <!-- Logo — click to upload, ×  to remove -->
                  <label class="relative w-16 h-16 rounded-xl border-2 border-white shadow-sm flex items-center justify-center overflow-hidden cursor-pointer group"
                    :style="{ backgroundColor: localBrandColor }" title="Change logo">
                    <input type="file" accept="image/svg+xml,image/png,image/jpeg" @change="handleLogoUpload" class="sr-only" />
                    <template v-if="localLogoSvg">
                      <div v-if="localLogoSvg.startsWith('<')" v-html="localLogoSvg"
                        class="w-full h-full p-1.5 [&>svg]:w-full [&>svg]:h-full" />
                      <img v-else :src="localLogoSvg" class="w-full h-full object-cover" />
                    </template>
                    <span v-else class="text-sm font-bold text-white select-none leading-none">
                      {{ (localName || '?')[0].toUpperCase() }}
                    </span>
                    <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 rounded-lg">
                      <svg class="w-4 h-4 text-white" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
                    </div>
                  </label>
                  <button v-if="localLogoSvg" type="button" @click="localLogoSvg = ''"
                    class="text-[11px] text-neutral-400 hover:text-red-500 transition-colors leading-none pb-0.5">
                    Remove
                  </button>
                </div>

                <p class="text-size-medium font-semibold text-neutral-900 leading-snug truncate">{{ localName || 'Untitled Space' }}</p>
                <p v-if="localDescription" class="text-size-small text-neutral-500 mt-0.5 line-clamp-2 leading-snug">{{ localDescription }}</p>
                <p class="text-[11px] text-neutral-400 mt-1 font-mono truncate">{{ localSlug }}</p>
              </div>
            </div>
          </div>

        </div>

        <!-- Members -->
        <div class="mt-10 pt-8 border-t border-neutral-100">
          <SpaceMembers />
        </div>

        <!-- Danger Zone -->
        <div class="mt-10 pt-6 border-t border-primary-200">
          <h2 class="text-size-medium font-semibold text-red-700 mb-3">Danger Zone</h2>
          <div class="border border-primary-200 rounded-lg p-4 flex items-center justify-between gap-4">
            <div>
              <p class="text-size-medium font-medium text-neutral-900">Delete this space</p>
              <p class="text-size-small text-neutral-500 mt-0.5">All documents and data will be archived. This cannot be undone.</p>
            </div>
            <button type="button" @click="showDeleteConfirm = true"
              class="shrink-0 px-3 py-1.5 text-size-medium font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors">
              Delete Space
            </button>
          </div>
        </div>

      </div>
    </template>

    <!-- Integrations -->
    <template #integrations>
    <section>
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">Access Tokens</h2>
        <button v-if="!isCreatingToken" @click="handleStartCreateToken" class="text-size-small text-blue-600 hover:text-blue-800 font-medium">+ Create Token</button>
      </div>
      <div>
        <div v-if="tokenError" class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
          {{ tokenError }}
        </div>

        <!-- Create Token Form -->
        <div v-if="isCreatingToken" class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
          <form @submit.prevent="handleCreateToken" class="space-y-3">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="block text-size-small font-medium text-neutral-700 mb-1">Name</label>
                <input v-model="newTokenName" type="text" required placeholder="e.g. CI Deploy Token" autofocus
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label class="block text-size-small font-medium text-neutral-700 mb-1">Permission</label>
                <select v-model="newTokenPermission"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="extensions">Extensions (install/update)</option>
                </select>
              </div>
              <template v-if="newTokenPermission !== 'extensions'">
                <div>
                  <label class="block text-size-small font-medium text-neutral-700 mb-1">Resource Type</label>
                  <select v-model="newTokenResourceType"
                    class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="space">Space</option>
                    <option value="document">Document</option>
                    <option value="extension">Extension</option>
                  </select>
                </div>
                <div>
                  <label class="block text-size-small font-medium text-neutral-700 mb-1">
                    Resource ID
                    <span v-if="newTokenResourceType === 'space'" class="text-neutral-400 font-normal">(space ID auto-filled)</span>
                  </label>
                  <input v-model="newTokenResourceId" type="text" required
                    :disabled="newTokenResourceType === 'space'"
                    class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-neutral-100 disabled:text-neutral-400" />
                </div>
              </template>
              <div v-else class="md:col-span-2 text-size-small text-neutral-500 self-center">
                Grants space-wide permission to install and update extensions. No resource needed.
              </div>
              <div>
                <label class="block text-size-small font-medium text-neutral-700 mb-1">Expires in days <span class="text-neutral-400 font-normal">(optional)</span></label>
                <input v-model.number="newTokenExpiresInDays" type="number" min="1" placeholder="Never"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <button type="button" @click="handleCancelCreateToken" class="px-3 py-1.5 text-size-medium text-neutral-600 hover:text-neutral-800">Cancel</button>
              <button type="submit" :disabled="isSubmittingToken"
                class="px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                {{ isSubmittingToken ? 'Creating...' : 'Create Token' }}
              </button>
            </div>
          </form>
        </div>

        <!-- Created Token Display (shown once after creation) -->
        <div v-if="createdTokenValue" class="mb-4 p-3 bg-green-50 border border-green-200 rounded-md">
          <p class="text-size-small font-medium text-green-800 mb-2">Token created — copy it now, it won't be shown again.</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 px-2 py-1.5 text-size-small bg-background border border-green-200 rounded-sm font-mono break-all select-all">{{ createdTokenValue }}</code>
            <button type="button" @click="handleCopyToken"
              class="shrink-0 px-2 py-1.5 text-size-small font-medium text-green-700 bg-green-100 border border-green-300 rounded-sm hover:bg-green-200">
              {{ tokenCopied ? 'Copied!' : 'Copy' }}
            </button>
          </div>
          <button type="button" @click="createdTokenValue = null; tokenCopied = false" class="mt-2 text-size-small text-green-700 hover:text-green-900">Dismiss</button>
        </div>

        <div v-if="isLoadingTokens" class="text-center py-6 text-size-medium text-neutral-500">Loading tokens...</div>
        <div v-else-if="accessTokens.length === 0 && !isCreatingToken" class="text-center py-6 text-size-medium text-neutral-500">No access tokens created yet</div>
        <div v-else-if="accessTokens.length > 0" class="overflow-x-auto border border-neutral-100 rounded-md">
          <table class="min-w-full text-size-medium">
            <thead class="bg-neutral-50">
              <tr>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Name</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Status</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Resources</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Last Used</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Expires</th>
                <th class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              <tr v-for="token in accessTokens" :key="token.id" class="hover:bg-neutral-50">
                <td class="px-4 py-2.5 font-medium text-neutral-900">{{ token.name }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap">
                  <span v-if="token.revokedAt" class="px-1.5 py-0.5 text-size-small rounded-sm bg-red-100 text-red-700">Revoked</span>
                  <span v-else-if="token.expiresAt && new Date(token.expiresAt) < new Date()" class="px-1.5 py-0.5 text-size-small rounded-sm bg-yellow-100 text-yellow-700">Expired</span>
                  <span v-else class="px-1.5 py-0.5 text-size-small rounded-sm bg-green-100 text-green-700">Active</span>
                </td>
                <td class="px-4 py-2.5">
                  <div class="flex flex-wrap gap-1">
                    <span v-for="resource in token.resources" :key="`${resource.resourceType}-${resource.resourceId}`"
                      class="px-1.5 py-0.5 text-size-small bg-blue-50 text-blue-700 rounded-sm">
                      {{ resource.resourceType }}: {{ resource.permission }}
                    </span>
                    <span v-if="!token.resources?.length" class="text-size-small text-neutral-400 italic">None</span>
                  </div>
                </td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ token.lastUsedAt ? formatDate(token.lastUsedAt) : '—' }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ token.expiresAt ? formatDate(token.expiresAt) : '—' }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
                  <button v-if="!token.revokedAt" @click="handleRevokeToken(token.id)" class="text-size-small text-red-600 hover:text-red-800">Revoke</button>
                  <button @click="handleDeleteToken(token.id)" class="text-size-small text-neutral-500 hover:text-neutral-700">Delete</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- MCP Server -->
    <section class="mt-8 pt-6 border-t border-neutral-100">
      <h2 class="text-size-medium font-semibold text-neutral-900 mb-2">MCP Server</h2>
      <p class="text-size-medium text-neutral-600 mb-4">
        Connect AI tools like Claude Desktop, Cursor, or Claude Code to this space via the
        <a href="https://modelcontextprotocol.io" target="_blank" class="text-blue-600 hover:text-blue-800 underline">Model Context Protocol</a>.
        Create an access token above, then add this configuration to your MCP client:
      </p>
      <div class="relative">
        <pre class="p-3 text-size-small font-mono bg-neutral-50 border border-neutral-200 rounded-md overflow-x-auto whitespace-pre">{{ mcpConfigJson }}</pre>
        <button type="button" @click="handleCopyMcpConfig" :disabled="isCopyingMcpConfig"
          class="absolute top-2 right-2 px-2 py-1 text-size-small font-medium text-neutral-600 bg-white border border-neutral-200 rounded-sm hover:bg-neutral-100 disabled:opacity-50">
          {{ isCopyingMcpConfig ? 'Creating token...' : mcpConfigCopied ? 'Copied with token!' : 'Copy with new token' }}
        </button>
      </div>
      <p class="mt-3 text-size-small text-neutral-500">
        Clicking copy creates a new access token and includes it in the copied config.
        Available tools: <code class="px-1 py-0.5 bg-neutral-100 rounded-sm">list_documents</code>,
        <code class="px-1 py-0.5 bg-neutral-100 rounded-sm">search_documents</code>,
        <code class="px-1 py-0.5 bg-neutral-100 rounded-sm">get_document</code>,
        <code class="px-1 py-0.5 bg-neutral-100 rounded-sm">upload_artifact</code>,
        <code class="px-1 py-0.5 bg-neutral-100 rounded-sm">install_extension</code>.
      </p>
    </section>

    <section class="mt-8 pt-6 border-t border-neutral-100">
      <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">Extensions</h2>
      <p class="text-size-medium text-neutral-900 mt-1">Install and manage extensions to add functionality</p>
      <ExtensionSettings />

      <div class="mt-8 pt-6 border-t border-neutral-200">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">Secrets</h2>
          <button
            v-if="!isCreatingSecret"
            @click="isCreatingSecret = true"
            class="text-size-small text-blue-600 hover:text-blue-800 font-medium"
          >
            + Create Secret
          </button>
        </div>

        <div v-if="secretsError" class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
          {{ secretsError }}
        </div>

        <div
          v-if="isCreatingSecret"
          class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md"
        >
          <form @submit.prevent="handleCreateSecret" class="space-y-3">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="block text-size-small font-medium text-neutral-700 mb-1">Name</label>
                <input
                  v-model="newSecretName"
                  type="text"
                  required
                  placeholder="e.g. OPENAI_API_KEY"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <div>
                <label class="block text-size-small font-medium text-neutral-700 mb-1">Description</label>
                <input
                  v-model="newSecretDescription"
                  type="text"
                  placeholder="Optional description"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div class="md:col-span-2">
                <label class="block text-size-small font-medium text-neutral-700 mb-1">Secret Value</label>
                <input
                  v-model="newSecretValue"
                  type="password"
                  required
                  placeholder="Will be encrypted at rest"
                  class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
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
              <button
                type="submit"
                :disabled="isSubmittingSecret"
                class="px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {{ isSubmittingSecret ? "Saving..." : "Save Secret" }}
              </button>
            </div>
          </form>
        </div>

        <div v-if="isLoadingSecrets" class="text-center py-6 text-size-medium text-neutral-500">Loading secrets...</div>
        <div v-else-if="secrets.length === 0 && !isCreatingSecret" class="text-center py-6 text-size-medium text-neutral-500">
          No secrets configured
        </div>
        <div v-else-if="secrets.length > 0" class="overflow-x-auto border border-neutral-100 rounded-md">
          <table class="min-w-full text-size-medium">
            <thead class="bg-neutral-50">
              <tr>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Name</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Description</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Last Used</th>
                <th class="px-4 py-2.5 text-left text-size-small font-medium text-neutral-500 uppercase tracking-wide">Updated</th>
                <th class="px-4 py-2.5 text-right text-size-small font-medium text-neutral-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              <tr v-for="secret in secrets" :key="secret.name" class="hover:bg-neutral-50">
                <td class="px-4 py-2.5 font-medium text-neutral-900 font-mono">{{ secret.name }}</td>
                <td class="px-4 py-2.5 text-neutral-600">{{ secret.description || "—" }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ secret.lastUsedAt ? formatDate(secret.lastUsedAt) : "—" }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-neutral-500">{{ formatDate(secret.updatedAt) }}</td>
                <td class="px-4 py-2.5 whitespace-nowrap text-right space-x-2">
                  <button
                    @click="handleRevealSecret(secret.name)"
                    class="text-size-small text-blue-600 hover:text-blue-800"
                  >
                    Reveal
                  </button>
                  <button @click="handleRotateSecret(secret.name)" class="text-size-small text-neutral-500 hover:text-neutral-700">
                    Rotate
                  </button>
                  <button @click="handleDeleteSecret(secret.name)" class="text-size-small text-red-600 hover:text-red-800">
                    Delete
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="selectedSecretName" class="mt-4 p-3 bg-neutral-50 border border-neutral-200 rounded-md">
          <div class="flex items-center justify-between mb-2">
            <p class="text-size-small font-medium text-neutral-700">Secret: <span class="font-mono">{{ selectedSecretName }}</span></p>
            <button @click="selectedSecretName = null; selectedSecretValue = null;" class="text-size-small text-neutral-500 hover:text-neutral-700">Close</button>
          </div>
          <div class="flex items-center gap-2 mb-3">
            <code class="flex-1 px-2 py-1.5 text-size-small bg-background border border-neutral-200 rounded-sm font-mono break-all select-all">{{
              selectedSecretValue ?? (isLoadingSecretValue ? "Loading..." : "Not loaded")
            }}</code>
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
                class="flex-1 px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
              >
                <option value="" disabled>
                  {{
                    isLoadingSecretUsers
                      ? "Loading users..."
                      : availableSecretGrantUsers.length > 0
                        ? "Select user"
                        : "No available users"
                  }}
                </option>
                <option v-for="u in availableSecretGrantUsers" :key="u.id" :value="u.id">
                  {{ u.name }} ({{ u.email }})
                </option>
              </select>
              <button
                @click="handleGrantSecretAccess"
                :disabled="!selectedGrantUserId || !selectedSecretName || isGrantingSecretAccess"
                class="px-3 py-1.5 text-size-small font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {{ isGrantingSecretAccess ? "Granting..." : "Grant Viewer" }}
              </button>
            </div>

            <div v-if="isLoadingSecretPermissions" class="mt-2 text-size-small text-neutral-500">Loading grants...</div>
            <div v-else-if="secretPermissions.length > 0" class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="perm in secretPermissions"
                :key="`${perm.userId || perm.groupId}-${perm.permission}`"
                class="inline-flex items-center gap-1 px-2 py-1 text-size-small bg-blue-50 text-blue-700 rounded-sm"
              >
                {{ formatSecretPermissionTarget(perm) }} ({{ perm.permission }})
                <button
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
    </section>
    </template>

    <!-- Jobs -->
    <template #jobs>
    <section>
      <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">Jobs</h2>
      <JobsSettings />
    </section>
    </template>

    <!-- Archive -->
    <template #archive>
    <section>
      <h2 class="text-size-large font-semibold text-neutral-900 mb-4 mt-2">Archived Documents</h2>
      <ArchivedDocuments v-if="currentSpace" :space-id="currentSpace.id" :space-slug="currentSpace.slug" />
    </section>
    </template>

  </SettingsLayout>

  <!-- Delete Confirmation Modal -->
  <div v-if="showDeleteConfirm" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" @click.self="showDeleteConfirm = false">
    <div class="bg-background rounded-lg shadow-xl w-full mx-4 p-5">
      <h3 class="text-base font-semibold text-neutral-900 mb-3">Delete Space</h3>
      <p class="text-size-medium text-neutral-600 mb-3">
        Are you sure you want to delete <strong>{{ currentSpace?.name }}</strong>? This action will archive all documents and data.
      </p>
      <p class="text-size-medium text-neutral-600 mb-3">
        Type <code class="px-1.5 py-0.5 bg-neutral-100 rounded-sm font-mono text-size-medium">{{ currentSpace?.slug }}</code> to confirm:
      </p>
      <input v-model="deleteConfirmText" type="text" placeholder="Type space slug"
        class="w-full px-3 py-1.5 text-size-medium border border-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 mb-3" />
      <div v-if="deleteError" class="mb-3 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
        {{ deleteError }}
      </div>
      <div class="flex gap-2">
        <button type="button" @click="showDeleteConfirm = false; deleteConfirmText = ''; deleteError = null;"
          class="flex-1 px-3 py-1.5 text-size-medium font-medium text-neutral-700 bg-neutral-100 rounded-md hover:bg-neutral-200">
          Cancel
        </button>
        <button type="button" @click="handleDeleteSpace" :disabled="deleteConfirmText !== currentSpace?.slug || isDeleting"
          class="flex-1 px-3 py-1.5 text-size-medium font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">
          {{ isDeleting ? 'Deleting...' : 'Delete Space' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import "@sv/elements/color-picker";
import "@sv/elements/popover";
import { computed, onMounted, ref, watch } from "vue";
import { closeXIcon } from "~/src/assets/icons.ts";
import { config } from "../config.ts";
import ArchivedDocuments from "./ArchivedDocuments.vue";
import ExtensionSettings from "./ExtensionSettings.vue";
import JobsSettings from "./JobsSettings.vue";
import SettingsLayout from "./SettingsLayout.vue";
import SpaceMembers from "./SpaceMembers.vue";

const tabs = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "jobs", label: "Jobs" },
  { id: "archive", label: "Archive" },
] as const;

type TabId = (typeof tabs)[number]["id"];
const validTabIds = tabs.map((t) => t.id) as string[];

function tabFromHash(): TabId {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.slice(1);
  return validTabIds.includes(hash) ? (hash as TabId) : "general";
}

function setTab(id: string) {
  window.location.hash = id;
}

import { type AccessToken, api, type SpaceSecret } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";

const emit = defineEmits(["saved"]);

const { currentSpace, updateSpace } = useSpace();

const localName = ref("");
const localSlug = ref("");
const localDescription = ref("");
const localBrandColor = ref("#1e293b");
const localLogoSvg = ref("");
const isSaving = ref(false);
const error = ref<string | null>(null);

// MCP config
const mcpConfigCopied = ref(false);
const isCopyingMcpConfig = ref(false);

function mcpOrigin(): string {
  const cfg = config();
  return cfg.API_URL || cfg.SITE_URL || window.location.origin;
}

function mcpConfigWithToken(token: string): string {
  const id = currentSpace.value?.id ?? "";
  return JSON.stringify(
    {
      vektor: {
        type: "streamable-http",
        url: `${mcpOrigin()}/api/v1/spaces/${id}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
    null,
    2,
  );
}

const mcpConfigJson = computed(() => mcpConfigWithToken("<your-access-token>"));

async function handleCopyMcpConfig() {
  if (!currentSpace.value?.id || isCopyingMcpConfig.value) return;
  isCopyingMcpConfig.value = true;
  try {
    const result = await api.accessTokens.create(currentSpace.value.id, {
      name: `MCP ${new Date().toLocaleDateString()}`,
      permission: "editor",
      resourceType: "space",
      resourceId: currentSpace.value.id,
    });
    await loadAccessTokens();
    await navigator.clipboard.writeText(mcpConfigWithToken(result.token));
    mcpConfigCopied.value = true;
    setTimeout(() => {
      mcpConfigCopied.value = false;
    }, 3000);
  } catch (err) {
    tokenError.value = err instanceof Error ? err.message : "Failed to create token";
  } finally {
    isCopyingMcpConfig.value = false;
  }
}

// Access Tokens state
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

// Space secrets state
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

// Delete space state
const showDeleteConfirm = ref(false);
const deleteConfirmText = ref("");
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

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

watch(
  () => currentSpace.value,
  () => {
    if (currentSpace.value) {
      localName.value = currentSpace.value.name;
      localSlug.value = currentSpace.value.slug;
      localDescription.value = currentSpace.value.preferences?.description || "";
      localBrandColor.value = currentSpace.value.preferences?.brandColor || "#1e293b";
      localLogoSvg.value = currentSpace.value.preferences?.logoSvg || "";
      error.value = null;
    }
  },
  {
    immediate: true,
  },
);

async function handleLogoUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const validTypes = ["image/svg+xml", "image/png", "image/jpeg"];
  if (!validTypes.includes(file.type)) {
    error.value = "Only SVG, PNG, and JPG files are supported";
    return;
  }

  try {
    if (file.type === "image/svg+xml") {
      let text = await file.text();
      text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
      text = text.replace(/on\w+="[^"]*"/g, "");
      text = text.replace(/on\w+='[^']*'/g, "");
      localLogoSvg.value = text;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        localLogoSvg.value = e.target?.result as string;
      };
      reader.onerror = () => {
        error.value = "Failed to read image file";
      };
      reader.readAsDataURL(file);
    }
    error.value = null;
  } catch {
    error.value = "Failed to read image file";
  }
}

async function handleSave() {
  if (!currentSpace.value) return;

  isSaving.value = true;
  error.value = null;

  try {
    await updateSpace(
      currentSpace.value.id,
      localName.value.trim(),
      localSlug.value.trim(),
      {
        description: localDescription.value.trim(),
        brandColor: localBrandColor.value,
        logoSvg: localLogoSvg.value,
      },
    );
    emit("saved");
    window.location.href = `/${localSlug.value.trim()}`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Failed to update space";
  } finally {
    isSaving.value = false;
  }
}

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function handleDeleteSpace() {
  if (!currentSpace.value?.id || deleteConfirmText.value !== currentSpace.value.slug)
    return;
  deleteError.value = null;
  isDeleting.value = true;

  try {
    await api.space.delete(currentSpace.value.id);
    window.location.href = "/";
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : "Failed to delete space";
    isDeleting.value = false;
  }
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
  } catch {
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

onMounted(() => {
  loadAccessTokens();
  loadSecrets();
  loadSecretAssignableUsers();
});

watch(
  () => currentSpace.value?.id,
  () => {
    if (currentSpace.value?.id) {
      loadAccessTokens();
      loadSecrets();
      loadSecretAssignableUsers();
    }
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
