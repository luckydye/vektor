import { createMemo, createSignal, For, Show } from "solid-js";
import { useExtensions } from "#composeables/useExtensions.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { config } from "#config";
import { formatDate } from "#utils/dateFormat.ts";
import { AddExtensionDialog } from "./AddExtensionDialog.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";

const AVATAR_COLORS = [
  "#e11d48",
  "#db2777",
  "#9333ea",
  "#7c3aed",
  "#4f46e5",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#16a34a",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
];

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function avatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function ExtensionSettings() {
  const lang = useLocale();
  // Adding an extension happens in one dialog, whichever way it arrives.
  const [showAdd, setShowAdd] = createSignal(false);

  const uploadAllowed = createMemo(() => {
    const raw = config().EXTENSION_ALLOWED_SOURCES;
    if (!raw) return true;
    return raw
      .split(",")
      .map((s) => s.trim())
      .includes("upload");
  });

  const {
    extensions,
    extensionErrors,
    isLoading,
    uploadError,
    isUploading,
    isDeleting,
    isUpdating,
    uploadExtension,
    deleteExtension,
    setExtensionEnabled,
    downloadPackage,
  } = useExtensions();

  async function handleExtensionSelect(file: File) {
    if (isUploading()) return;
    await uploadExtension(file);
  }

  async function handleDelete(extensionId: string) {
    if (!confirm("Are you sure you want to delete this extension?")) return;
    await deleteExtension(extensionId);
  }

  return (
    <div class="flex flex-1 flex-col">
      <div class="space-y-4 pt-6">
        <Show when={uploadError()}>
          <div class="rounded-md border border-red-200 bg-red-50 p-3">
            <p class="text-red-600 text-size-medium">{uploadError()}</p>
          </div>
        </Show>

        <Show
          when={!isLoading()}
          fallback={
            <div class="py-8 text-center text-neutral text-size-medium">
              Loading extensions...
            </div>
          }
        >
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <For each={extensions()}>
              {(ext) => (
                <div class="group relative flex flex-col rounded-lg border border-neutral-100 p-4 transition-all hover:border-neutral-200 hover:shadow-sm">
                  <div class="flex items-start justify-between gap-3">
                    <div
                      class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg font-semibold text-size-large text-white"
                      style={{ "background-color": avatarColor(ext.id) }}
                    >
                      {initial(ext.name)}
                    </div>
                    <SwitchToggle
                      value={ext.enabled}
                      disabled={isUpdating()}
                      onInput={(enabled) => void setExtensionEnabled(ext.id, enabled)}
                    />
                  </div>

                  <div class="mt-3 flex-1">
                    <h3 class="truncate font-medium text-neutral-900" title={ext.name}>
                      {ext.name}
                    </h3>
                    <Show when={ext.description}>
                      <p class="mt-1 line-clamp-2 text-neutral-500 text-size-small">
                        {ext.description}
                      </p>
                    </Show>
                  </div>

                  <div class="mt-3 flex flex-wrap items-center gap-1.5">
                    <span class="whitespace-nowrap rounded-sm bg-neutral-100 px-1.5 py-0.5 font-mono text-neutral-600 text-size-small">
                      v{ext.version}
                    </span>
                    <Show when={ext.entries.frontend}>
                      <span class="whitespace-nowrap rounded-sm bg-blue-50 px-1.5 py-0.5 text-blue-700 text-size-small">
                        frontend
                      </span>
                    </Show>
                    <Show when={ext.entries.view}>
                      <span class="whitespace-nowrap rounded-sm bg-purple-50 px-1.5 py-0.5 text-purple-700 text-size-small">
                        view
                      </span>
                    </Show>
                  </div>

                  <div class="mt-3 flex items-center justify-between border-neutral-100 border-t pt-3">
                    <span class="text-neutral-400 text-size-small">
                      {formatDate(ext.updatedAt, lang)}
                    </span>
                    <span class="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => downloadPackage(ext.id)}
                        class="text-neutral text-size-small hover:text-neutral-900"
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(ext.id)}
                        disabled={isDeleting()}
                        class="text-red-600 text-size-small hover:text-red-800 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </For>

            <For each={extensionErrors()}>
              {(item) => (
                <div class="flex flex-col rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-amber-200 text-amber-800">
                      <svg
                        class="h-6 w-6"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="2"
                        stroke="currentColor"
                        role="img"
                        aria-label="Invalid extension"
                      >
                        <title>Invalid extension</title>
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                        />
                      </svg>
                    </div>
                  </div>

                  <div class="mt-3 flex-1">
                    <h3
                      class="truncate font-mono text-neutral-900 text-size-small"
                      title={item.id}
                    >
                      {item.id}
                    </h3>
                    <p class="mt-1 line-clamp-2 text-amber-700 text-size-small">
                      {item.error}
                    </p>
                  </div>

                  <div class="mt-3 flex items-center justify-between border-amber-200 border-t pt-3">
                    <span class="text-amber-700 text-size-small">Invalid</span>
                    <span class="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => downloadPackage(item.id)}
                        class="text-neutral text-size-small hover:text-neutral-900"
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(item.id)}
                        disabled={isDeleting()}
                        class="text-red-600 text-size-small hover:text-red-800 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </For>

            {/* Adding is one action with two sources, so the tile opens the
                dialog rather than being a drop target for one of them. */}
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              class="flex min-h-[168px] flex-col items-center justify-center gap-3 rounded-lg border border-neutral-200 border-dashed text-center transition-colors hover:border-neutral-300 hover:bg-neutral-50"
            >
              <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-400">
                {/* Decorative: the button's own label already names it, and a
                    titled icon made it read "Add extension Add extension". */}
                <svg
                  class="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="2"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 4.5v15m7.5-7.5h-15"
                  />
                </svg>
              </span>
              <span class="text-neutral text-size-medium">Add extension</span>
            </button>
          </div>
        </Show>
      </div>

      <AddExtensionDialog
        show={showAdd()}
        onUpdateShow={setShowAdd}
        installed={extensions()}
        uploadAllowed={uploadAllowed()}
        isUploading={isUploading()}
        uploadError={uploadError()}
        onUpload={handleExtensionSelect}
      />
    </div>
  );
}
