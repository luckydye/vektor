import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { type AccessToken, api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { formatAbsoluteDate } from "#utils/datetime.ts";
import { Button } from "./Button.tsx";

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

export function SpaceAccessTokensSettings() {
  const { currentSpace, currentSpaceId } = useSpace();

  const [accessTokens, setAccessTokens] = createSignal<AccessToken[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = createSignal(false);
  const [tokenError, setTokenError] = createSignal<string | null>(null);
  const [isCreatingToken, setIsCreatingToken] = createSignal(false);
  const [isSubmittingToken, setIsSubmittingToken] = createSignal(false);
  const [newTokenName, setNewTokenName] = createSignal("");
  const [newTokenPermission, setNewTokenPermission] = createSignal("editor");
  const [newTokenResourceType, setNewTokenResourceType] = createSignal("space");
  const [newTokenResourceId, setNewTokenResourceId] = createSignal("");
  const [newTokenExpiresInDays, setNewTokenExpiresInDays] = createSignal<number | null>(
    null,
  );
  const [createdTokenValue, setCreatedTokenValue] = createSignal<string | null>(null);
  const [tokenCopied, setTokenCopied] = createSignal(false);

  async function loadAccessTokens() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsLoadingTokens(true);
    setTokenError(null);

    try {
      const response = await api.accessTokens.get(spaceId);
      setAccessTokens(response.tokens || []);
    } catch {
      setTokenError("Failed to load access tokens");
      setAccessTokens([]);
    } finally {
      setIsLoadingTokens(false);
    }
  }

  async function handleRevokeToken(tokenId: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm("Are you sure you want to revoke this token?")) return;
    setTokenError(null);

    try {
      await api.accessTokens.revoke(spaceId, tokenId);
      await loadAccessTokens();
    } catch {
      setTokenError("Failed to revoke token");
    }
  }

  async function handleDeleteToken(tokenId: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm("Are you sure you want to delete this token?")) return;
    setTokenError(null);

    try {
      await api.accessTokens.delete(spaceId, tokenId);
      await loadAccessTokens();
    } catch {
      setTokenError("Failed to delete token");
    }
  }

  function handleStartCreateToken() {
    setIsCreatingToken(true);
    setNewTokenName("");
    setNewTokenPermission("editor");
    setNewTokenResourceType("space");
    setNewTokenResourceId(currentSpace()?.id ?? "");
    setNewTokenExpiresInDays(null);
    setTokenError(null);
  }

  async function handleCreateToken() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsSubmittingToken(true);
    setTokenError(null);

    try {
      const isExtensionsCapability = newTokenPermission() === "extensions";
      const result = await api.accessTokens.create(spaceId, {
        name: newTokenName().trim(),
        permission: newTokenPermission(),
        // The "extensions" capability is space-wide and has no resource target.
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
      await loadAccessTokens();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Failed to create token");
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

  onMount(() => void loadAccessTokens());
  createEffect(
    on(
      currentSpaceId,
      (id) => {
        if (id) void loadAccessTokens();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      newTokenResourceType,
      (type) => {
        setNewTokenResourceId(type === "space" ? (currentSpace()?.id ?? "") : "");
      },
      { defer: true },
    ),
  );

  return (
    <section class="mt-8 pt-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="mt-2 mb-4 font-semibold text-neutral-900 text-size-large">
          Access Tokens
        </h2>
        <Show when={!isCreatingToken()}>
          <button
            type="button"
            onClick={handleStartCreateToken}
            class="font-medium text-blue-600 text-size-small hover:text-blue-800"
          >
            + Create Token
          </button>
        </Show>
      </div>
      <div>
        <Show when={tokenError()}>
          <div class="mb-3 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
            {tokenError()}
          </div>
        </Show>

        {/* Create Token Form */}
        <Show when={isCreatingToken()}>
          <div class="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
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
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
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

        {/* Created Token Display (shown once after creation) */}
        <Show when={createdTokenValue()}>
          {(value) => (
            <div class="mb-4 rounded-md border border-green-200 bg-green-50 p-3">
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

        <Show when={isLoadingTokens()}>
          <div class="py-6 text-center text-neutral-500 text-size-medium">
            Loading tokens...
          </div>
        </Show>
        <Show
          when={!isLoadingTokens() && accessTokens().length === 0 && !isCreatingToken()}
        >
          <div class="py-6 text-center text-neutral-500 text-size-medium">
            No access tokens created yet
          </div>
        </Show>
        <Show when={!isLoadingTokens() && accessTokens().length > 0}>
          <div class="overflow-x-auto rounded-md border border-neutral-100">
            <table class="min-w-full text-size-medium">
              <thead class="bg-neutral-50">
                <tr>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Name
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Status
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Resources
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Last Used
                  </th>
                  <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Expires
                  </th>
                  <th class="px-4 py-2.5 text-right font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-100">
                <For each={accessTokens()}>
                  {(token) => (
                    <tr class="hover:bg-neutral-50">
                      <td class="px-4 py-2.5 font-medium text-neutral-900">
                        {token.name}
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5">
                        <Show
                          when={token.revokedAt}
                          fallback={
                            <Show
                              when={
                                token.expiresAt && new Date(token.expiresAt) < new Date()
                              }
                              fallback={
                                <span class="rounded-sm bg-green-100 px-1.5 py-0.5 text-green-700 text-size-small">
                                  Active
                                </span>
                              }
                            >
                              <span class="rounded-sm bg-yellow-100 px-1.5 py-0.5 text-size-small text-yellow-700">
                                Expired
                              </span>
                            </Show>
                          }
                        >
                          <span class="rounded-sm bg-red-100 px-1.5 py-0.5 text-red-700 text-size-small">
                            Revoked
                          </span>
                        </Show>
                      </td>
                      <td class="px-4 py-2.5">
                        <div class="flex flex-wrap gap-1">
                          <For each={token.resources}>
                            {(resource) => (
                              <span class="rounded-sm bg-blue-50 px-1.5 py-0.5 text-blue-700 text-size-small">
                                {resourceLabel(resource)}
                              </span>
                            )}
                          </For>
                          <Show when={!token.resources?.length}>
                            <span class="text-neutral-400 text-size-small italic">
                              None
                            </span>
                          </Show>
                        </div>
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                        {token.lastUsedAt ? formatAbsoluteDate(token.lastUsedAt) : "—"}
                      </td>
                      <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                        {token.expiresAt ? formatAbsoluteDate(token.expiresAt) : "—"}
                      </td>
                      <td class="space-x-2 whitespace-nowrap px-4 py-2.5 text-right">
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
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </section>
  );
}
