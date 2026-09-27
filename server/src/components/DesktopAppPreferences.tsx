import { createMemo, createSignal, For, Show } from "solid-js";
import type { Space } from "#api/client.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import type { NativeApp, NativeMount } from "#utils/nativeApp.ts";
import { Button } from "./Button.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";

interface Props {
  app: NativeApp;
  /** Spaces the user can mint an access token for, which is what a mount needs. */
  spaces: Space[];
  /** Preselected in the picker. */
  currentSpaceId: string | null;
  mounts: NativeMount[];
  error: string | null;
  onMount: (space: Space, writable: boolean) => void;
  onAuthorize: (mount: NativeMount) => void;
  onUnmount: (spaceId: string) => void;
  onReveal: (spaceId: string) => void;
}

/** Preferences that only exist inside the desktop app. */
export function DesktopAppPreferences(props: Props) {
  const t = useTranslation();
  const available = createMemo(() =>
    props.spaces.filter((space) => !props.mounts.some((m) => m.spaceId === space.id)),
  );
  // Several spaces can share a name; the slug tells them apart.
  const label = (space: Space) =>
    props.spaces.some((other) => other !== space && other.name === space.name)
      ? `${space.name} (${space.slug})`
      : space.name;
  const [picked, setPicked] = createSignal<string | null>(null);
  const selected = createMemo(() => {
    const id = picked() ?? props.currentSpaceId;
    return available().find((space) => space.id === id) ?? available()[0];
  });
  const [writable, setWritable] = createSignal(false);
  const nameOf = (mount: NativeMount) =>
    props.spaces.find((space) => space.id === mount.spaceId)?.name ?? mount.spaceSlug;

  return (
    <>
      <section>
        <div class="mb-3">
          <h2 class="font-semibold text-foreground text-size-medium">{t("Desktop App")}</h2>
          <p class="mt-1 text-neutral-500 text-size-small">
            {t("Settings for the Vektor app on this device.")}
          </p>
        </div>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-background p-3">
          <p class="font-medium text-foreground text-size-small">{t("Version")}</p>
          <p class="text-label text-neutral-500">
            {props.app.version} · {props.app.platform}
          </p>
        </div>
      </section>

      <section class="mt-6">
        <div class="mb-3">
          <h2 class="font-semibold text-foreground text-size-medium">
            {t("Mounted spaces")}
          </h2>
          <p class="mt-1 text-neutral-500 text-size-small">
            {t("Show a space's files as a folder in Finder, grouped by document.")}
          </p>
        </div>

        <Show when={props.error}>
          <div class="mb-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-600 text-size-small">
            {props.error}
          </div>
        </Show>

        <div class="rounded-lg border border-neutral-200 bg-background">
          <For each={props.mounts}>
            {(mount) => (
              <div class="flex items-center justify-between gap-4 border-neutral-100 border-b p-3">
                <div class="min-w-0">
                  <p class="truncate font-medium text-foreground text-size-small">
                    {nameOf(mount)}
                    <span class="ml-2 font-normal text-label text-neutral-500">
                      {mount.writable ? t("Editable") : t("Read-only")}
                    </span>
                  </p>
                  <p class="mt-0.5 truncate text-label text-neutral-500">
                    <Show when={mount.status === "mounted"}>
                      <span class="font-mono">{mount.path}</span>
                    </Show>
                    <Show when={mount.status === "mounting"}>{t("Mounting…")}</Show>
                    <Show when={mount.status === "unmounting"}>{t("Unmounting…")}</Show>
                    <Show when={mount.status === "needs-credentials"}>
                      {t("The app needs an access token for this space.")}
                    </Show>
                  </p>
                  <Show when={mount.error}>
                    <p class="mt-0.5 text-label text-red-600">{mount.error}</p>
                  </Show>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Show when={mount.status === "mounted"}>
                    <Button
                      size="small"
                      variant="ghost"
                      text={t("Show in Finder")}
                      onClick={() => props.onReveal(mount.spaceId)}
                    />
                  </Show>
                  <Show when={mount.status === "needs-credentials"}>
                    <Button
                      size="small"
                      text={t("Create token and mount")}
                      onClick={() => props.onAuthorize(mount)}
                    />
                  </Show>
                  <Show when={mount.status === "failed"}>
                    <Button
                      size="small"
                      variant="ghost"
                      text={t("Retry with a new token")}
                      onClick={() => props.onAuthorize(mount)}
                    />
                  </Show>
                  <Button
                    size="small"
                    variant="outline"
                    disabled={mount.status === "mounting" || mount.status === "unmounting"}
                    text={mount.status === "mounted" ? t("Unmount") : t("Remove")}
                    onClick={() => props.onUnmount(mount.spaceId)}
                  />
                </div>
              </div>
            )}
          </For>

          <Show
            when={selected()}
            fallback={
              <p class="p-3 text-neutral-500 text-size-small">{t("No spaces to mount.")}</p>
            }
          >
            {(space) => (
              <div class="flex flex-wrap items-center gap-3 p-3">
                <select
                  aria-label={t("Space")}
                  value={space().id}
                  onChange={(event) => setPicked(event.currentTarget.value)}
                  class="focus-ring min-w-0 flex-1 rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                >
                  <For each={available()}>
                    {(option) => <option value={option.id}>{label(option)}</option>}
                  </For>
                </select>
                <SwitchToggle label={t("Editable")} value={writable()} onInput={setWritable} />
                <Button
                  size="small"
                  text={t("Mount")}
                  onClick={() => props.onMount(space(), writable())}
                />
              </div>
            )}
          </Show>
        </div>
      </section>
    </>
  );
}
