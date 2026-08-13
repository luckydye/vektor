import { createMemo, For, Show } from "solid-js";
import { t } from "#utils/lang.ts";
import { memberCountLabel } from "#utils/utils.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import { SpaceLogo } from "./SpaceLogo.tsx";

export interface OverviewSpace {
  id: string;
  name: string;
  slug: string;
  description?: string;
  members?: number;
  role?: string;
  color?: string;
  logoSvg?: string;
  pinned: boolean;
}

interface Props {
  spaces: OverviewSpace[];
  loading?: boolean;
  onTogglePin?: (spaceId: string) => void;
  onCreate?: () => void;
}

function SpaceCard(props: {
  space: OverviewSpace;
  onTogglePin?: (spaceId: string) => void;
}) {
  return (
    <div class="group relative flex flex-col overflow-hidden rounded-xl border border-neutral-400/25 bg-neutral-25 transition-colors hover:border-neutral-400/70">
      <div
        class="h-14 w-full bg-primary-500"
        style={{ "background-color": props.space.color }}
      />

      {/* Over the banner, so it reads on whatever brand colour sits behind it.
          Beside the link rather than inside it: an anchor may not wrap a button. */}
      <button
        type="button"
        onClick={() => props.onTogglePin?.(props.space.id)}
        class="absolute top-2 right-2 z-10 rounded-md p-1.5 backdrop-blur-sm transition-colors"
        classList={{
          "bg-white/90 text-neutral-900": props.space.pinned,
          "bg-black/20 text-white hover:bg-black/35": !props.space.pinned,
        }}
        title={props.space.pinned ? t("Unpin space") : t("Pin space")}
        aria-pressed={props.space.pinned}
      >
        <Icon name="pin-to-home" class="block h-4 w-4" />
      </button>

      <div class="flex flex-1 flex-col px-3xs pb-3xs">
        <div
          class="-mt-7 mb-4xs flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-xl border-2 border-neutral-25 bg-primary-500"
          style={{ "background-color": props.space.color }}
        >
          <SpaceLogo logoSvg={props.space.logoSvg} class="h-full w-full object-cover" />
        </div>

        {/* The whole card follows this link; the pin button stacks above it. */}
        <a
          href={`/${props.space.slug}/`}
          class="truncate font-semibold text-foreground text-size-medium leading-snug after:absolute after:inset-0"
        >
          {props.space.name}
        </a>

        <Show when={props.space.description}>
          <p class="mt-6xs line-clamp-2 text-neutral-600 text-size-normal leading-snug">
            {props.space.description}
          </p>
        </Show>

        <p class="mt-auto pt-4xs text-neutral-500 text-size-small">
          {memberCountLabel(props.space.members)}
          <Show when={props.space.role}>
            {(role) => (
              <>
                <span class="px-1">·</span>
                <span class="capitalize">{role()}</span>
              </>
            )}
          </Show>
        </p>
      </div>
    </div>
  );
}

function SpaceGrid(props: {
  spaces: OverviewSpace[];
  onTogglePin?: (spaceId: string) => void;
}) {
  return (
    <div class="grid grid-cols-1 gap-2xs sm:grid-cols-2 xl:grid-cols-3">
      <For each={props.spaces}>
        {(space) => <SpaceCard space={space} onTogglePin={props.onTogglePin} />}
      </For>
    </div>
  );
}

export function SpacesOverview(props: Props) {
  const pinned = createMemo(() => props.spaces.filter((space) => space.pinned));
  const unpinned = createMemo(() => props.spaces.filter((space) => !space.pinned));

  return (
    <div class="space-y-8 px-xs pt-m pb-20 lg:px-xl">
      <div class="flex items-center justify-between gap-3xs">
        <h1 class="font-semibold text-foreground text-size-title">{t("Spaces")}</h1>
        <Button
          variant="secondary"
          icon="add"
          text={t("Create new Space")}
          onClick={() => props.onCreate?.()}
        />
      </div>

      <Show when={props.loading}>
        <div class="grid grid-cols-1 gap-2xs sm:grid-cols-2 xl:grid-cols-3">
          <For each={[0, 1, 2, 3]}>
            {() => (
              <div class="overflow-hidden rounded-xl border border-neutral-400/25">
                <div class="h-14 w-full animate-pulse bg-neutral-200" />
                <div class="px-3xs pb-3xs">
                  <div class="-mt-7 mb-4xs h-14 w-14 animate-pulse rounded-xl border-2 border-background bg-neutral-200" />
                  <div class="h-4 w-32 animate-pulse rounded-sm bg-neutral-200" />
                  <div class="mt-4xs h-3 w-full animate-pulse rounded-sm bg-neutral-100" />
                  <div class="mt-4xs h-3 w-20 animate-pulse rounded-sm bg-neutral-100" />
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={!props.loading && props.spaces.length === 0}>
        <div class="rounded-lg border border-neutral-400/25 border-dashed p-l text-center">
          <p class="text-neutral-600">{t("You are not a member of any space yet.")}</p>
        </div>
      </Show>

      <Show when={pinned().length > 0}>
        <section class="space-y-3xs">
          <h2 class="font-medium text-neutral-600 text-size-small">{t("Pinned")}</h2>
          <SpaceGrid spaces={pinned()} onTogglePin={props.onTogglePin} />
        </section>
      </Show>

      <Show when={unpinned().length > 0}>
        <section class="space-y-3xs">
          <Show when={pinned().length > 0}>
            <h2 class="font-medium text-neutral-600 text-size-small">
              {t("All spaces")}
            </h2>
          </Show>
          <SpaceGrid spaces={unpinned()} onTogglePin={props.onTogglePin} />
        </section>
      </Show>
    </div>
  );
}
