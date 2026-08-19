import { createEffect, createSignal, on, onMount, Show } from "solid-js";
import { api } from "#api/client.ts";
import { slugify } from "#utils/utils.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

export function FirstSpacePrompt() {
  const [showPrompt, setShowPrompt] = createSignal(false);
  const [spaceName, setSpaceName] = createSignal("");
  const [spaceSlug, setSpaceSlug] = createSignal("");
  const [brandColor, setBrandColor] = createSignal("#1e293b");
  const [logoSvg, setLogoSvg] = createSignal("");
  const [isCreating, setIsCreating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(on(spaceName, (name) => setSpaceSlug(slugify(name)), { defer: true }));

  async function handleLogoUpload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    if (!file.type.includes("svg")) {
      setError("Only SVG files are supported");
      return;
    }

    if (file.size > 300 * 1024) {
      setError("Logo file must be smaller than 300 KB");
      return;
    }

    try {
      let text = await file.text();

      text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
      text = text.replace(/on\w+="[^"]*"/g, "");
      text = text.replace(/on\w+='[^']*'/g, "");

      setLogoSvg(text);
      setError(null);
    } catch (err) {
      setError("Failed to read SVG file");
      console.error("Failed to read SVG file:", err);
    }
  }

  async function checkForSpaces() {
    try {
      const spaces = await api.spaces.get();
      setShowPrompt(spaces.length === 0);
    } catch (err) {
      console.error("Failed to check spaces:", err);
    }
  }

  async function handleCreateSpace() {
    if (!spaceName().trim() || !spaceSlug().trim()) return;

    setIsCreating(true);
    setError(null);

    try {
      const newSpace = await api.spaces.post({
        name: spaceName().trim(),
        slug: spaceSlug().trim(),
        preferences: {
          brandColor: brandColor(),
          logoSvg: logoSvg(),
        },
      });
      window.location.href = `/${newSpace.slug}/`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred");
      console.error("Failed to create space:", err);
    } finally {
      setIsCreating(false);
    }
  }

  onMount(() => {
    void checkForSpaces();
  });

  return (
    <Show when={showPrompt()}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div class="mx-4 w-full max-w-lg rounded-lg bg-background p-8 shadow-2xl">
          <div class="mb-6 text-center">
            <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
              <Icon class="h-8 w-8 text-blue-600" name="folder" />
            </div>
            <h2 class="mb-2 font-bold text-neutral-900 text-size-title">
              Welcome to Your Space!
            </h2>
            <p class="text-neutral">
              G'day! Let's get you sorted by creating your first space. Spaces help
              organize your documents and knowledge.
            </p>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateSpace();
            }}
            class="space-y-4"
          >
            <div>
              <label
                for="space-name"
                class="mb-1 block font-medium text-neutral-900 text-size-medium"
              >
                Space Name
              </label>
              <input
                id="space-name"
                value={spaceName()}
                onInput={(e) => setSpaceName(e.currentTarget.value)}
                type="text"
                required
                placeholder="Engineering, Product, Design ..."
                class="focus-ring w-full rounded-md border border-neutral-100 px-4 py-2 focus:border-transparent"
                disabled={isCreating()}
              />
            </div>

            <div>
              <label
                for="space-slug"
                class="mb-1 block font-medium text-neutral-900 text-size-medium"
              >
                Slug
              </label>
              <input
                id="space-slug"
                value={spaceSlug()}
                onInput={(e) => setSpaceSlug(e.currentTarget.value)}
                type="text"
                required
                placeholder="engineering"
                pattern="[a-z0-9-]+"
                class="focus-ring w-full rounded-md border border-neutral-100 px-4 py-2 focus:border-transparent"
                disabled={isCreating()}
              />
              <p class="mt-1 text-neutral text-size-small">
                Only lowercase letters, numbers, and hyphens
              </p>
            </div>

            <div>
              <label
                for="brand-color"
                class="mb-1 block font-medium text-neutral-900 text-size-medium"
              >
                Brand Color
              </label>
              <div class="flex items-center gap-2">
                <input
                  id="brand-color"
                  value={brandColor()}
                  onInput={(e) => setBrandColor(e.currentTarget.value)}
                  type="color"
                  class="h-10 w-20 cursor-pointer rounded-md border border-neutral-100"
                />
                <input
                  value={brandColor()}
                  onInput={(e) => setBrandColor(e.currentTarget.value)}
                  type="text"
                  placeholder="#1e293b"
                  pattern="^#[0-9A-Fa-f]{6}$"
                  class="focus-ring flex-1 rounded-md border border-neutral-100 px-3 py-2"
                />
              </div>
              <p class="mt-1 text-neutral text-size-small">
                Used for the header and sidebar
              </p>
            </div>

            <div>
              <label
                for="logo-svg"
                class="mb-1 block font-medium text-neutral-900 text-size-medium"
              >
                Logo (SVG)
              </label>
              <div class="space-y-2">
                <input
                  id="logo-svg"
                  type="file"
                  accept=".svg,image/svg+xml"
                  onChange={(event) => void handleLogoUpload(event)}
                  disabled={isCreating()}
                  class="focus-ring w-full rounded-md border border-neutral-100 px-4 py-2 focus:border-transparent"
                />
                <Show when={logoSvg()}>
                  <div class="flex items-center gap-2 rounded-md border border-neutral-100 bg-neutral-300 p-2">
                    <Icon class="h-8" svg={logoSvg()} />
                    <button
                      type="button"
                      onClick={() => setLogoSvg("")}
                      disabled={isCreating()}
                      class="ml-auto text-red-600 text-size-small hover:text-red-800"
                    >
                      Remove
                    </button>
                  </div>
                </Show>
              </div>
              <p class="mt-1 text-neutral text-size-small">
                Upload an SVG file for your space logo
              </p>
            </div>

            <Show when={error()}>
              <div class="rounded-md border border-red-200 bg-red-50 p-3">
                <p class="text-red-600 text-size-medium">{error()}</p>
              </div>
            </Show>

            <Button
              type="submit"
              class="focus-ring w-full justify-center px-4 py-3 text-base focus:ring-offset-2"
              disabled={isCreating()}
              text={isCreating() ? "Creating Space..." : "Create Your First Space"}
            />
          </form>

          <div class="mt-6 border-neutral border-t pt-4">
            <p class="text-center text-neutral-900 text-size-small">
              You can create more spaces later from the space selector
            </p>
          </div>
        </div>
      </div>
    </Show>
  );
}
