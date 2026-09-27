import { createMemo, For, Show } from "solid-js";
import type { ExtensionInfo } from "#api/client.ts";
import { useExtensionStore } from "#composeables/useExtensionStore.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { config } from "#config";
import { formatDate } from "#utils/dateFormat.ts";
import { Dialog } from "./Dialog.tsx";
import { FileDrop } from "./FileDrop.tsx";

interface Props {
  show?: boolean;
  onUpdateShow?: (value: boolean) => void;
  /** Already-installed extensions, so the store can mark them. */
  installed: ExtensionInfo[];
  uploadAllowed: boolean;
  isUploading: boolean;
  uploadError: string | null;
  onUpload: (file: File) => void | Promise<void>;
}

/**
 * The one place an extension gets added to a space.
 *
 * Both routes in — the store and a local zip — end at the same privileged
 * action, so they belong in one dialog rather than split across a tab strip and
 * a drop target on the settings page. The store leads because it is the one a
 * reader can act on without having built anything; uploading is the escape
 * hatch, and an operator can switch either off with
 * `VEKTOR_EXTENSION_ALLOWED_SOURCES`.
 */
export function AddExtensionDialog(props: Props) {
  const lang = useLocale();
  const store = useExtensionStore(() => props.installed);

  const storeAllowed = createMemo(() => {
    if (config().MARKETPLACE_ENABLED !== "1") return false;
    const raw = config().EXTENSION_ALLOWED_SOURCES;
    if (!raw) return true;
    return raw
      .split(",")
      .map((source) => source.trim())
      .includes("marketplace");
  });

  function close() {
    props.onUpdateShow?.(false);
  }

  async function handleFile(file: File) {
    if (props.isUploading) return;
    await props.onUpload(file);
    close();
  }

  /**
   * The registry's listing page for an extension. The path shape is assumed
   * rather than carried in the registry contract, so it is only offered when a
   * registry is configured at all.
   */
  function pageUrl(extensionId: string): string | undefined {
    const registry = store.registry();
    return registry ? `${registry}/extensions/${extensionId}` : undefined;
  }

  async function handleInstall(extensionId: string) {
    await store.install(extensionId);
  }

  return (
    <Dialog
      show={props.show}
      title="Add extension"
      /* Explicit rather than `md:max-w-3xl`: this theme redefines the
         `--container-*` scale, and the named step resolved to 80px. */
      maxWidth="md:max-w-[64rem]"
      /* Sized to its content rather than forced to fill the screen: a store
         with a handful of listings should not open a near-full-height panel.
         The Dialog's own max-height still caps it and the body scrolls. */
      bodyClass="px-5 pb-5 overflow-y-auto"
      onUpdateShow={props.onUpdateShow}
    >
      <Show when={storeAllowed()}>
        <Show when={store.installError()}>
          <div class="mb-3 rounded-md border border-red-200 bg-red-50 p-3">
            <p class="text-red-600 text-size-medium">{store.installError()}</p>
          </div>
        </Show>

        <Show when={store.error()}>
          <div class="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3">
            <p class="text-amber-700 text-size-medium">
              {store.error()?.message ?? "Could not reach the extension store."}
            </p>
            <button
              type="button"
              onClick={() => void store.refresh()}
              class="mt-1 text-amber-800 text-size-small underline"
            >
              Try again
            </button>
          </div>
        </Show>

        <input
          type="search"
          value={store.search()}
          onInput={(event) => store.setSearch(event.currentTarget.value)}
          placeholder="Search the store"
          class="w-full rounded-md border border-neutral-200 px-3 py-2 text-size-medium outline-none focus:border-neutral-400"
        />

        <Show
          when={!store.isLoading()}
          fallback={
            <p class="py-8 text-center text-neutral text-size-medium">
              Loading the extension store...
            </p>
          }
        >
          <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <For each={store.listings()}>
              {(listing) => (
                <div class="flex flex-col rounded-lg border border-neutral-100 p-4 transition-all hover:border-neutral-200 hover:shadow-sm">
                  <div class="flex items-start gap-3">
                    <Show
                      when={listing.extension.icon}
                      fallback={
                        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-neutral-100 font-semibold text-neutral-500 text-size-large">
                          {listing.extension.name.charAt(0).toUpperCase()}
                        </div>
                      }
                    >
                      <img
                        src={listing.extension.icon}
                        alt=""
                        class="h-11 w-11 shrink-0 rounded-lg"
                      />
                    </Show>
                    <div class="min-w-0 flex-1">
                      {/* The name links to the registry's listing page, where
                          the screenshots and full description live. */}
                      <Show
                        when={pageUrl(listing.extension.id)}
                        fallback={
                          <h3
                            class="truncate font-medium text-neutral-900"
                            title={listing.extension.name}
                          >
                            {listing.extension.name}
                          </h3>
                        }
                      >
                        <a
                          href={pageUrl(listing.extension.id)}
                          target="_blank"
                          rel="noreferrer"
                          class="group/link flex items-center gap-1 font-medium text-neutral-900"
                          title={`${listing.extension.name} on the extension store`}
                        >
                          <span class="truncate group-hover/link:underline">
                            {listing.extension.name}
                          </span>
                          <svg
                            class="h-3.5 w-3.5 shrink-0 text-neutral-300 transition-colors group-hover/link:text-neutral-500"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke-width="2"
                            stroke="currentColor"
                            aria-hidden="true"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                            />
                          </svg>
                        </a>
                      </Show>
                      <p class="truncate text-neutral-400 text-size-small">
                        {listing.extension.publisher}
                      </p>
                    </div>
                  </div>

                  <Show when={listing.extension.description}>
                    <p class="mt-3 line-clamp-2 text-neutral-500 text-size-small">
                      {listing.extension.description}
                    </p>
                  </Show>

                  <div class="mt-3 mb-3 flex flex-wrap items-center gap-1.5">
                    <span class="whitespace-nowrap rounded-sm bg-neutral-100 px-1.5 py-0.5 font-mono text-neutral-600 text-size-small">
                      v{listing.extension.version}
                    </span>
                    <Show when={listing.extension.capabilities.views}>
                      <span class="whitespace-nowrap rounded-sm bg-purple-50 px-1.5 py-0.5 text-purple-700 text-size-small">
                        views
                      </span>
                    </Show>
                    <Show when={listing.extension.capabilities.jobs}>
                      <span class="whitespace-nowrap rounded-sm bg-blue-50 px-1.5 py-0.5 text-blue-700 text-size-small">
                        jobs
                      </span>
                    </Show>
                    <Show when={listing.extension.capabilities.integrations}>
                      <span class="whitespace-nowrap rounded-sm bg-emerald-50 px-1.5 py-0.5 text-emerald-700 text-size-small">
                        integration
                      </span>
                    </Show>
                  </div>

                  <div class="mt-auto flex items-center justify-between gap-2 border-neutral-100 border-t pt-3">
                    <span class="text-neutral-400 text-size-small">
                      {formatDate(listing.extension.publishedAt, lang)}
                    </span>
                    <Show
                      when={listing.installed}
                      fallback={
                        <button
                          type="button"
                          disabled={store.isInstalling()}
                          onClick={() => void handleInstall(listing.extension.id)}
                          class="rounded-md bg-neutral-900 px-2.5 py-1 text-size-small text-white disabled:opacity-50"
                        >
                          {store.installingId() === listing.extension.id
                            ? "Installing..."
                            : "Install"}
                        </button>
                      }
                    >
                      <Show
                        when={listing.updateAvailable}
                        fallback={
                          /* Same vertical padding as the buttons it replaces,
                             so the footer row keeps one height across cards. */
                          <span class="py-1 text-neutral-400 text-size-small">
                            Installed
                          </span>
                        }
                      >
                        <button
                          type="button"
                          disabled={store.isInstalling()}
                          onClick={() => void handleInstall(listing.extension.id)}
                          class="rounded-md border border-neutral-900 px-2.5 py-1 text-neutral-900 text-size-small disabled:opacity-50"
                          title={`Installed v${listing.installed?.version}`}
                        >
                          {store.installingId() === listing.extension.id
                            ? "Updating..."
                            : "Update"}
                        </button>
                      </Show>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>

          <Show when={store.listings().length === 0 && !store.error()}>
            <p class="py-10 text-center text-neutral-400 text-size-medium">
              {store.total() === 0
                ? "The extension store is empty."
                : "No extensions match that search."}
            </p>
          </Show>
        </Show>
      </Show>

      {/* Both routes on one screen: the store is what most visits are for, and
          a local package is a short strip beneath it rather than a tab that
          hides one behind the other. */}
      <Show when={props.uploadAllowed}>
        <Show when={props.uploadError}>
          <div class="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
            <p class="text-red-600 text-size-medium">{props.uploadError}</p>
          </div>
        </Show>

        <div classList={{ "mt-5 border-neutral-100 border-t pt-4": storeAllowed() }}>
          <FileDrop
            accept=".zip,application/zip"
            /* Trailing `!` is Tailwind v4's important modifier; FileDrop's own
               base classes are a centred column with generous padding. */
            class="flex-row! cursor-pointer gap-2 rounded-lg px-4! py-3! text-left"
            onSelect={(file) => void handleFile(file)}
          >
            {({ isDragging, openPicker }) => (
              <>
                <span class="text-neutral-500 text-size-small">Built one yourself?</span>
                <button
                  type="button"
                  disabled={props.isUploading}
                  class="text-size-small underline disabled:opacity-50"
                  classList={{
                    "text-neutral-900": isDragging(),
                    "text-neutral": !isDragging(),
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    openPicker();
                  }}
                >
                  {props.isUploading
                    ? "Uploading..."
                    : "Drag & drop a .zip or choose a file"}
                </button>
              </>
            )}
          </FileDrop>
        </div>
      </Show>

      <Show when={storeAllowed() && store.registry()}>
        <p class="mt-4 border-neutral-100 border-t pt-3 text-neutral-400 text-size-small">
          {store.total()} available from {store.registry()}
        </p>
      </Show>
    </Dialog>
  );
}
