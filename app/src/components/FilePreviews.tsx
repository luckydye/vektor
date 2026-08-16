import "@atrium-ui/elements/lightbox";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import { useSpace } from "#composeables/useSpace.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import { t } from "#utils/lang.ts";
import { formatFileSize } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

export interface FilePreviewItem {
  id: string;
  title: string;
  /** The upload URL, used both as the thumbnail source and as the link target */
  url: string;
  size?: number;
  documentUrl: string;
}

interface Props {
  items: FilePreviewItem[];
  class?: string;
  selectedIds: Set<string>;
  onToggleSelect: (id: string, event: { shiftKey: boolean }) => void;
  expanded: boolean;
  onExpand: () => void;
}

/**
 * Tiles shown before the group is expanded. A space's whole upload history can
 * land in one group, and a wall of thumbnails would push its documents off the
 * screen.
 */
const COLLAPSED_TILES = 11;

/**
 * Trade the lightbox's zoom for the page staying painted: `startViewTransition`
 * is document-wide, and for its duration Chrome stops painting the sidebar's
 * composited scroller. The element reaches the API only through this method, so
 * a stand-in that runs the update and resolves is all it takes.
 */
function openWithoutViewTransition(element: HTMLElement) {
  (
    element as HTMLElement & { requireStartViewTransition: () => unknown }
  ).requireStartViewTransition = () => (update: () => unknown) => {
    const done = Promise.resolve(update()).then(() => undefined);
    return { updateCallbackDone: done, ready: done, finished: done };
  };
}

function ThumbnailFrame(props: { selected: boolean; children: JSX.Element }) {
  return (
    <div
      class="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border border-neutral-100 bg-neutral-50"
      classList={{ "ring-2 ring-primary-500": props.selected }}
    >
      {props.children}
    </div>
  );
}

interface TileProps {
  item: FilePreviewItem;
  selected: boolean;
  onToggleSelect: (id: string, event: { shiftKey: boolean }) => void;
}

function FilePreviewTile(props: TileProps) {
  const { currentSpace } = useSpace();
  const [broken, setBroken] = createSignal(false);
  let lightbox: (HTMLElement & { hide: () => void }) | undefined;

  return (
    <page-target
      attr:data-document-id={props.item.id}
      attr:data-document-type="file"
      attr:data-space-id={currentSpace()?.id}
      attr:data-document-url={props.item.documentUrl}
      class="group/preview relative block [&[data-dragging]]:opacity-50"
    >
      <Show
        when={!broken()}
        fallback={
          <ThumbnailFrame selected={props.selected}>
            <Icon class="h-6 w-6 text-neutral-300" name="image" />
          </ThumbnailFrame>
        }
      >
        <a-lightbox
          ref={(el) => {
            lightbox = el as HTMLElement & { hide: () => void };
            openWithoutViewTransition(el);
          }}
          class="block"
        >
          <button
            slot="trigger"
            type="button"
            class="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
            title={props.item.title}
            onKeyDown={(event) => {
              // Space falls through to the button's own activation, which is what
              // opens the lightbox; Enter is claimed here for selection instead.
              if (event.key !== "Enter") return;
              event.preventDefault();
              props.onToggleSelect(props.item.id, event);
            }}
          >
            <ThumbnailFrame selected={props.selected}>
              <img
                src={withTransformParams(props.item.url, { w: 320, format: "webp" })}
                onError={() => setBroken(true)}
                loading="lazy"
                class="h-full w-full object-cover"
                alt={props.item.title}
              />
            </ThumbnailFrame>
          </button>

          {/* Lazy: the slot is unrendered until the lightbox opens, so the variant
              is only fetched for the image actually being viewed. The zoom waits
              on that fetch and decode, which is what a larger preset costs. */}
          <img
            slot="content"
            src={withTransformParams(props.item.url, { w: 1280, format: "webp" })}
            loading="lazy"
            class="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            alt={props.item.title}
          />

          {/* One `content` element rather than a `close` slot, which would
              dismiss the lightbox on any click inside it — the download link
              included. Closing is the element's own `hide()` instead. */}
          <div slot="content" class="fixed top-4 right-4 flex items-center gap-4xs">
            {/* The original, not the variant on screen. */}
            <a href={props.item.url} download={props.item.title} class="button-primary">
              <Icon name="download" />
              <span>{t("Download")}</span>
            </a>

            {/* `on:click` rather than Solid's delegated `onClick`: the element's
                stage handler stops the click before it reaches the document,
                where a delegated listener would be waiting for it. */}
            <button
              type="button"
              class="button-primary"
              on:click={() => lightbox?.hide()}
              aria-label={t("Close")}
              title={t("Close")}
            >
              <Icon name="cancel" />
            </button>
          </div>
        </a-lightbox>
      </Show>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only stops the tile's click from reaching the lightbox trigger; the checkbox is the control. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: nothing is activated here, so there is no keyboard equivalent to add. */}
      <div
        class="absolute top-1 left-1 rounded bg-background/90 p-1 opacity-0 transition-opacity group-focus-within/preview:opacity-100 group-hover/preview:opacity-100"
        classList={{ "!opacity-100": props.selected }}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={props.selected}
          onClick={(event) => props.onToggleSelect(props.item.id, event)}
          tabindex={-1}
          class="block h-3.5 w-3.5 cursor-pointer accent-primary-500"
        />
      </div>

      {/* Out of the tab order, along with the checkbox: the whole tile is one
          stop, and its keys reach both of them. */}
      <a
        href={props.item.url}
        target="_blank"
        rel="noopener noreferrer"
        tabindex={-1}
        class="mt-1.5 block"
      >
        <p class="truncate text-neutral-700 text-size-extra-small hover:underline">
          {props.item.title}
        </p>
        <Show when={props.item.size !== undefined}>
          <p class="text-neutral-400 text-size-extra-small tabular-nums">
            {formatFileSize(props.item.size ?? 0)}
          </p>
        </Show>
      </a>
    </page-target>
  );
}

/** Image uploads as a grid of thumbnails, one tile per file. */
export function FilePreviews(props: Props) {
  const visible = createMemo(() =>
    props.expanded ? props.items : props.items.slice(0, COLLAPSED_TILES),
  );
  const hiddenCount = createMemo(() => props.items.length - visible().length);

  return (
    <div
      class={twMerge(
        "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3",
        props.class,
      )}
    >
      <For each={visible()}>
        {(item) => (
          <FilePreviewTile
            item={item}
            selected={props.selectedIds.has(item.id)}
            onToggleSelect={props.onToggleSelect}
          />
        )}
      </For>

      <Show when={hiddenCount() > 0}>
        <button
          type="button"
          onClick={() => props.onExpand()}
          class="flex aspect-[4/3] items-center justify-center rounded-md border border-neutral-100 border-dashed font-medium text-neutral-500 text-size-small transition-colors hover:border-neutral-300 hover:text-neutral-700"
          title={t("Show all images")}
        >
          +{hiddenCount()}
        </button>
      </Show>
    </div>
  );
}
