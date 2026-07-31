import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { type AIConfigMeta, api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { Button } from "./Button.tsx";

type Provider = "anthropic" | "openai" | "openrouter" | "opencode-zen" | "ollama";

export function AgentSettings() {
  const { currentSpace } = useSpace();

  const [meta, setMeta] = createSignal<AIConfigMeta | null>(null);
  const [isLoading, setIsLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const [form, setForm] = createStore({
    provider: "anthropic" as Provider,
    model: "",
    apiKey: "",
    baseUrl: "",
  });

  const modelPlaceholder = createMemo(() => {
    if (form.provider === "anthropic") return "claude-sonnet-4-6";
    if (form.provider === "openai") return "gpt-5";
    if (form.provider === "openrouter") return "qwen/qwen3.5-397b-a17b";
    if (form.provider === "opencode-zen") return "claude-sonnet-4-6";
    return "qwen3:latest";
  });

  async function load() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await api.agentSettings.get(spaceId);
      setMeta(res.aiProvider);
      if (res.aiProvider.configured) {
        setForm({
          provider: res.aiProvider.provider as Provider,
          model: res.aiProvider.model,
          baseUrl: res.aiProvider.baseUrl ?? "",
          apiKey: "",
        });
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load AI config");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const { provider, model, apiKey, baseUrl } = form;
      let body: Parameters<typeof api.agentSettings.put>[1];
      if (provider === "ollama") {
        body = { provider: "ollama", model, baseUrl };
      } else {
        // Keep existing key if blank and one already exists
        const current = meta();
        const existingKeyOk =
          !apiKey && current?.configured && (current as { hasApiKey: boolean }).hasApiKey;
        if (!existingKeyOk && !apiKey) {
          setSaveError("API key is required");
          return;
        }
        if (existingKeyOk) {
          // Re-fetching the existing key isn't possible, and the backend
          // requires apiKey for these providers — ask for it again.
          setSaveError("Enter the API key to save changes.");
          return;
        }
        body = { provider, model, apiKey };
      }
      const res = await api.agentSettings.put(spaceId, body);
      setMeta(res.aiProvider);
      setForm("apiKey", "");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save AI config");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIsDeleting(true);
    try {
      await api.agentSettings.delete(spaceId);
      setMeta({ configured: false });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to remove AI config");
    } finally {
      setIsDeleting(false);
    }
  }

  createEffect(
    on(
      () => currentSpace()?.id,
      (id) => {
        if (id) void load();
      },
    ),
  );

  const configured = () => {
    const current = meta();
    return current?.configured ? current : null;
  };

  return (
    <div>
      <div class="mb-4 flex items-center justify-between">
        <h2 class="mb-4 font-semibold text-neutral-900 text-size-large">AI Provider</h2>
      </div>

      <Show when={loadError()}>
        <div class="mb-4 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
          {loadError()}
        </div>
      </Show>

      <Show
        when={!isLoading()}
        fallback={<div class="py-4 text-neutral-500 text-size-medium">Loading…</div>}
      >
        <div>
          {/* Current config status */}
          <Show
            when={configured()}
            fallback={
              <div class="mb-5 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-neutral-500 text-size-medium">
                No AI provider configured. The agent will not work until one is set.
              </div>
            }
          >
            {(current) => (
              <div class="mb-5 flex items-center justify-between gap-4 rounded-md border border-green-200 bg-green-50 p-3">
                <div class="text-green-800 text-size-medium">
                  <span class="font-medium">{current().provider}</span>
                  <span class="mx-1.5 text-green-400">·</span>
                  <code class="font-mono text-size-small">{current().model}</code>
                  <Show when={current().baseUrl}>
                    <span class="mx-1.5 text-green-400">·</span>
                    <span class="text-green-700 text-size-small">
                      {current().baseUrl}
                    </span>
                  </Show>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={isDeleting()}
                  class="shrink-0 text-red-600 text-size-small hover:text-red-800 disabled:opacity-50"
                >
                  {isDeleting() ? "Removing…" : "Remove"}
                </button>
              </div>
            )}
          </Show>

          {/* Configuration form */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
            class="space-y-4"
          >
            <div>
              <label
                for="agent-provider"
                class="mb-1 block font-medium text-neutral-700 text-size-small"
              >
                Provider
              </label>
              <select
                id="agent-provider"
                value={form.provider}
                onChange={(e) => setForm("provider", e.currentTarget.value as Provider)}
                class="focus-ring w-full rounded-md border border-neutral-200 px-3 py-1.5 text-size-medium"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="opencode-zen">opencode Zen</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>

            <div>
              <label
                for="agent-model"
                class="mb-1 block font-medium text-neutral-700 text-size-small"
              >
                Model
              </label>
              <input
                id="agent-model"
                value={form.model}
                onInput={(e) => setForm("model", e.currentTarget.value)}
                type="text"
                required
                placeholder={modelPlaceholder()}
                class="focus-ring w-full rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-size-medium"
              />
            </div>

            <Show
              when={form.provider === "ollama"}
              fallback={
                <div>
                  <label
                    for="agent-api-key"
                    class="mb-1 block font-medium text-neutral-700 text-size-small"
                  >
                    API Key
                    <Show when={configured()?.hasApiKey}>
                      <span class="ml-1 font-normal text-neutral-400">
                        (leave blank to keep existing)
                      </span>
                    </Show>
                  </label>
                  <input
                    id="agent-api-key"
                    value={form.apiKey}
                    onInput={(e) => setForm("apiKey", e.currentTarget.value)}
                    type="password"
                    required={!configured()?.hasApiKey}
                    placeholder={configured()?.hasApiKey ? "••••••••" : "sk-…"}
                    class="focus-ring w-full rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-size-medium"
                  />
                </div>
              }
            >
              <div>
                <label
                  for="agent-base-url"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Base URL
                </label>
                <input
                  id="agent-base-url"
                  value={form.baseUrl}
                  onInput={(e) => setForm("baseUrl", e.currentTarget.value)}
                  type="url"
                  required
                  placeholder="http://127.0.0.1:11434"
                  class="focus-ring w-full rounded-md border border-neutral-200 px-3 py-1.5 font-mono text-size-medium"
                />
              </div>
            </Show>

            <Show when={saveError()}>
              <div class="rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
                {saveError()}
              </div>
            </Show>

            <div class="flex justify-end">
              <Button
                type="submit"
                disabled={isSaving()}
                text={isSaving() ? "Saving…" : "Save"}
              />
            </div>
          </form>
        </div>
      </Show>
    </div>
  );
}
