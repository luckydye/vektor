import "@atrium-ui/elements/lightbox";
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
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

type GroupLightbox = HTMLElement & {
  opened: boolean;
  lastActiveElement: HTMLElement | null;
  show: () => Promise<void>;
  hide: () => Promise<void>;
};

/**
 * Tiles shown before the group is expanded. A space's whole upload history can
 * land in one group, and a wall of thumbnails would push its documents off the
 * screen.
 */
const COLLAPSED_TILES = 11;

function thumbnailUrl(item: FilePreviewItem) {
  return withTransformParams(item.url, { w: 320, format: "webp" });
}

function viewUrl(item: FilePreviewItem) {
  return withTransformParams(item.url, { w: 1280, format: "webp" });
}

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
  onTrigger: (element: HTMLButtonElement) => void;
  onOpen: () => void;
}

function FilePreviewTile(props: TileProps) {
  const { currentSpace } = useSpace();
  const [broken, setBroken] = createSignal(false);

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
        <button
          ref={props.onTrigger}
          type="button"
          aria-haspopup="dialog"
          class="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          title={props.item.title}
          onClick={() => props.onOpen()}
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
              src={thumbnailUrl(props.item)}
              onError={() => setBroken(true)}
              loading="lazy"
              class="h-full w-full object-cover"
              alt={props.item.title}
            />
          </ThumbnailFrame>
        </button>
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

  const [viewedIndex, setViewedIndex] = createSignal(0);
  const viewed = createMemo(() => visible()[viewedIndex()]);
  const triggers: HTMLButtonElement[] = [];
  let lightbox: GroupLightbox | undefined;
  let content: HTMLImageElement | undefined;
  let animation: Animation | undefined;
  /** Where stepping has got to, which runs ahead of the image being shown. */
  const [cursor, setCursor] = createSignal(0);
  /** Guards a step that a later one has overtaken mid-animation. */
  let generation = 0;

  /** Resolves once the image is ready to be shown without a blank frame. */
  function preload(index: number) {
    const item = visible()[index];
    if (!item) return Promise.resolve();

    const image = new Image();
    image.src = viewUrl(item);
    return image.decode?.().catch(() => {}) ?? Promise.resolve();
  }

  function open(index: number) {
    setCursor(index);
    setViewedIndex(index);
    void preload(index - 1);
    void preload(index + 1);
    void lightbox?.show();
  }

  /**
   * Slides the outgoing image out in the direction of travel and the incoming
   * one in behind it, once it has decoded — the swap itself is instant.
   */
  async function swap(index: number, offset: number) {
    const image = content;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!image || reduced) {
      await preload(index);
      setViewedIndex(index);
      return;
    }

    const token = ++generation;
    animation?.cancel();
    animation = image.animate(
      [{ opacity: 0, transform: `translateX(${offset * -24}px)` }],
      { duration: 90, easing: "ease-in", fill: "forwards" },
    );

    await Promise.all([animation.finished.catch(() => {}), preload(index)]);
    if (token !== generation) return;

    setViewedIndex(index);
    animation.cancel();
    animation = image.animate(
      [
        { opacity: 0, transform: `translateX(${offset * 24}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: 140, easing: "ease-out" },
    );
  }

  /** The ends of the group are walls: stepping off them is not a wrap-around. */
  function step(offset: number) {
    const next = cursor() + offset;
    if (next < 0 || next >= visible().length) return;

    setCursor(next);
    void preload(next + offset);
    void swap(next, offset);

    // Closing hands focus back to the tile being viewed rather than the one the
    // overlay was opened from.
    const trigger = triggers[next];
    if (lightbox && trigger) lightbox.lastActiveElement = trigger;
  }

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!lightbox?.opened) return;

      const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (offset === 0) return;

      event.preventDefault();
      step(offset);
    };

    // On the window, where the element listens for Escape too: the overlay is
    // rendered in a portal, so its keys never reach this component's tree.
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <>
      <div
        class={twMerge(
          "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3",
          props.class,
        )}
      >
        <For each={visible()}>
          {(item, index) => (
            <FilePreviewTile
              item={item}
              selected={props.selectedIds.has(item.id)}
              onToggleSelect={props.onToggleSelect}
              onTrigger={(element) => {
                triggers[index()] = element;
              }}
              onOpen={() => open(index())}
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

      {/* One overlay for the whole group, so the arrow keys can step it through
          the tiles. It is taken out of the flow because nothing in it is meant
          to be seen here — the content moves into a portal when it opens. */}
      <Show when={viewed()}>
        {(item) => (
          <a-lightbox
            ref={(el) => {
              lightbox = el as GroupLightbox;
              openWithoutViewTransition(el);
            }}
            class="pointer-events-none fixed h-0 w-0 overflow-hidden opacity-0"
          >
            {/* The element pairs one trigger with one content image and measures
                its (here disabled) zoom between them. The tiles open the overlay
                themselves, so this stands in for the one that was clicked. */}
            <img slot="trigger" src={thumbnailUrl(item())} alt="" aria-hidden="true" />

            {/* Lazy: an unassigned slot is not rendered, so the variant is only
                fetched for a group whose overlay is actually opened. */}
            <img
              ref={(el) => {
                content = el;
              }}
              slot="content"
              src={viewUrl(item())}
              loading="lazy"
              class="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
              alt={item().title}
            />

            {/* One `content` element rather than a `close` slot, which would
                dismiss the lightbox on any click inside it — the download link
                included. Closing is the element's own `hide()` instead. */}
            <div slot="content" class="fixed top-4 right-4 flex items-center gap-4xs">
              {/* The original, not the variant on screen. */}
              <a href={item().url} download={item().title} class="button-primary">
                <Icon name="download" />
                <span>{t("Download")}</span>
              </a>

              {/* `on:click` rather than Solid's delegated `onClick`: the element's
                  stage handler stops the click before it reaches the document,
                  where a delegated listener would be waiting for it. */}
              <button
                type="button"
                class="button-primary"
                on:click={() => void lightbox?.hide()}
                aria-label={t("Close")}
                title={t("Close")}
              >
                <Icon name="cancel" />
              </button>
            </div>

            {/* Transparent to the pointer so that clicking beside the image
                still closes the overlay; only the buttons take clicks. */}
            <div slot="content" class="pointer-events-none fixed inset-0">
              <Show when={cursor() > 0}>
                <button
                  type="button"
                  class="button-primary pointer-events-auto absolute top-1/2 left-4 -translate-y-1/2"
                  on:click={() => step(-1)}
                  aria-label={t("Previous image")}
                  title={t("Previous image")}
                >
                  <Icon name="chevron-left-thin" />
                </button>
              </Show>

              <Show when={cursor() < visible().length - 1}>
                <button
                  type="button"
                  class="button-primary pointer-events-auto absolute top-1/2 right-4 -translate-y-1/2"
                  on:click={() => step(1)}
                  aria-label={t("Next image")}
                  title={t("Next image")}
                >
                  <Icon name="chevron-right-thin" />
                </button>
              </Show>
            </div>
          </a-lightbox>
        )}
      </Show>
    </>
  );
}
