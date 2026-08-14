import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { api, type SpaceSecret } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { Button } from "./Button.tsx";

export function SpaceSecretsSettings() {
  const { currentSpace, currentSpaceId } = useSpace();

  const [secrets, setSecrets] = createSignal<SpaceSecret[]>([]);
  const [isLoadingSecrets, setIsLoadingSecrets] = createSignal(false);
  const [secretsError, setSecretsError] = createSignal<string | null>(null);
  const [isCreatingSecret, setIsCreatingSecret] = createSignal(false);
  const [isSubmittingSecret, setIsSubmittingSecret] = createSignal(false);
  const [newSecretName, setNewSecretName] = createSignal("");
  const [newSecretDescription, setNewSecretDescription] = createSignal("");
  const [newSecretValue, setNewSecretValue] = createSignal("");
  const [selectedSecretName, setSelectedSecretName] = createSignal<string | null>(null);
  const [selectedSecretValue, setSelectedSecretValue] = createSignal<string | null>(null);
  const [isLoadingSecretValue, setIsLoadingSecretValue] = createSignal(false);

  async function loadSecrets() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsLoadingSecrets(true);
    setSecretsError(null);

    try {
      const response = await api.secrets.get(spaceId);
      setSecrets(response.secrets || []);
    } catch (err) {
      setSecretsError(err instanceof Error ? err.message : "Failed to load secrets");
      setSecrets([]);
    } finally {
      setIsLoadingSecrets(false);
    }
  }

  function handleCancelCreateSecret() {
    setIsCreatingSecret(false);
    setNewSecretName("");
    setNewSecretDescription("");
    setNewSecretValue("");
  }

  async function handleCreateSecret() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsSubmittingSecret(true);
    setSecretsError(null);

    try {
      await api.secrets.create(spaceId, {
        name: newSecretName().trim(),
        value: newSecretValue(),
        description: newSecretDescription().trim() || null,
      });
      handleCancelCreateSecret();
      await loadSecrets();
    } catch (err) {
      setSecretsError(err instanceof Error ? err.message : "Failed to save secret");
    } finally {
      setIsSubmittingSecret(false);
    }
  }

  async function handleRevealSecret(name: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setSelectedSecretName(name);
    setSelectedSecretValue(null);
    setIsLoadingSecretValue(true);
    setSecretsError(null);

    try {
      const secret = await api.secrets.getByName(spaceId, name);
      setSelectedSecretValue(secret.value);
    } catch (err) {
      setSecretsError(err instanceof Error ? err.message : "Failed to load secret");
    } finally {
      setIsLoadingSecretValue(false);
    }
  }

  async function handleRotateSecret(name: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    const newValue = window.prompt(`Enter new value for ${name}`);
    if (!newValue) return;

    const meta = secrets().find((s) => s.name === name);
    try {
      await api.secrets.update(spaceId, name, {
        value: newValue,
        description: meta?.description || null,
      });
      if (selectedSecretName() === name) setSelectedSecretValue(null);
      await loadSecrets();
    } catch (err) {
      setSecretsError(err instanceof Error ? err.message : "Failed to rotate secret");
    }
  }

  async function handleDeleteSecret(name: string) {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm(`Delete secret '${name}'?`)) return;

    try {
      await api.secrets.delete(spaceId, name);
      if (selectedSecretName() === name) {
        setSelectedSecretName(null);
        setSelectedSecretValue(null);
      }
      await loadSecrets();
    } catch (err) {
      setSecretsError(err instanceof Error ? err.message : "Failed to delete secret");
    }
  }

  async function handleCopySelectedSecret() {
    const value = selectedSecretValue();
    if (!value) return;
    await navigator.clipboard.writeText(value);
  }

  function reload() {
    void loadSecrets();
  }

  onMount(reload);
  createEffect(
    on(
      currentSpaceId,
      (id) => {
        if (id) reload();
      },
      { defer: true },
    ),
  );

  return (
    <div class="mt-8 pt-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="mt-2 mb-4 font-semibold text-neutral-900 text-size-large">Secrets</h2>
        <Show when={!isCreatingSecret()}>
          <button
            type="button"
            onClick={() => setIsCreatingSecret(true)}
            class="font-medium text-blue-600 text-size-small hover:text-blue-800"
          >
            + Create Secret
          </button>
        </Show>
      </div>

      <Show when={secretsError()}>
        <div class="mb-3 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
          {secretsError()}
        </div>
      </Show>

      <Show when={isCreatingSecret()}>
        <div class="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateSecret();
            }}
            class="space-y-3"
          >
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label
                  for="secret-name"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Name
                </label>
                <input
                  id="secret-name"
                  value={newSecretName()}
                  onInput={(e) => setNewSecretName(e.currentTarget.value)}
                  type="text"
                  required
                  placeholder="e.g. OPENAI_API_KEY"
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 font-mono text-size-medium"
                />
              </div>
              <div>
                <label
                  for="secret-description"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Description
                </label>
                <input
                  id="secret-description"
                  value={newSecretDescription()}
                  onInput={(e) => setNewSecretDescription(e.currentTarget.value)}
                  type="text"
                  placeholder="Optional description"
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                />
              </div>
              <div class="md:col-span-2">
                <label
                  for="secret-value"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Secret Value
                </label>
                <input
                  id="secret-value"
                  value={newSecretValue()}
                  onInput={(e) => setNewSecretValue(e.currentTarget.value)}
                  type="password"
                  required
                  placeholder="Will be encrypted at rest"
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 font-mono text-size-medium"
                />
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelCreateSecret}
                class="px-3 py-1.5 text-neutral-600 text-size-medium hover:text-neutral-800"
              >
                Cancel
              </button>
              <Button
                type="submit"
                disabled={isSubmittingSecret()}
                text={isSubmittingSecret() ? "Saving..." : "Save Secret"}
              />
            </div>
          </form>
        </div>
      </Show>

      <Show when={isLoadingSecrets()}>
        <div class="py-6 text-center text-neutral-500 text-size-medium">
          Loading secrets...
        </div>
      </Show>
      <Show when={!isLoadingSecrets() && secrets().length === 0 && !isCreatingSecret()}>
        <div class="py-6 text-center text-neutral-500 text-size-medium">
          No secrets configured
        </div>
      </Show>
      <Show when={!isLoadingSecrets() && secrets().length > 0}>
        <div class="overflow-x-auto rounded-md border border-neutral-100">
          <table class="min-w-full text-size-medium">
            <thead class="bg-neutral-50">
              <tr>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Name
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Description
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Last Used
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Updated
                </th>
                <th class="px-4 py-2.5 text-right font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              <For each={secrets()}>
                {(secret) => (
                  <tr class="hover:bg-neutral-50">
                    <td class="px-4 py-2.5 font-medium font-mono text-neutral-900">
                      {secret.name}
                    </td>
                    <td class="px-4 py-2.5 text-neutral-600">
                      {secret.description || "—"}
                    </td>
                    <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                      {secret.lastUsedAt ? formatAbsoluteDate(secret.lastUsedAt) : "—"}
                    </td>
                    <td class="whitespace-nowrap px-4 py-2.5 text-neutral-500">
                      {formatAbsoluteDate(secret.updatedAt)}
                    </td>
                    <td class="space-x-2 whitespace-nowrap px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => void handleRevealSecret(secret.name)}
                        class="text-blue-600 text-size-small hover:text-blue-800"
                      >
                        Reveal
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRotateSecret(secret.name)}
                        class="text-neutral-500 text-size-small hover:text-neutral-700"
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteSecret(secret.name)}
                        class="text-red-600 text-size-small hover:text-red-800"
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

      <Show when={selectedSecretName()}>
        {(name) => (
          <div class="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
            <div class="mb-2 flex items-center justify-between">
              <p class="font-medium text-neutral-700 text-size-small">
                Secret: <span class="font-mono">{name()}</span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedSecretName(null);
                  setSelectedSecretValue(null);
                }}
                class="text-neutral-500 text-size-small hover:text-neutral-700"
              >
                Close
              </button>
            </div>
            <div class="mb-3 flex items-center gap-2">
              <code class="flex-1 select-all break-all rounded-sm border border-neutral-200 bg-background px-2 py-1.5 font-mono text-size-small">
                {selectedSecretValue() ??
                  (isLoadingSecretValue() ? "Loading..." : "Not loaded")}
              </code>
              <button
                type="button"
                onClick={() => void handleCopySelectedSecret()}
                disabled={!selectedSecretValue()}
                class="shrink-0 rounded-sm border border-neutral-200 bg-neutral-100 px-2 py-1.5 font-medium text-neutral-700 text-size-small hover:bg-neutral-200 disabled:opacity-50"
              >
                Copy
              </button>
            </div>

          </div>
        )}
      </Show>
    </div>
  );
}
