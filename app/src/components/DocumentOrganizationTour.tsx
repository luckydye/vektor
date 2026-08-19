import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";

interface Props {
  show?: boolean;
  onUpdateShow?: (value: boolean) => void;
}

/**
 * The three gestures, in the order someone meets them.
 *
 * `scripts/record-onboarding.ts` films the clips this references from the real
 * sidebar; a caption stays one sentence because the clip is the explanation.
 */
const STEPS = [
  {
    clip: "categories",
    title: "Sort documents into categories",
    caption: "Drag a document onto a category to file it there.",
  },
  {
    clip: "nesting",
    title: "Nest pages under a page",
    caption: "Drop a document onto another to make it a sub-page.",
  },
  {
    clip: "rearrange",
    title: "Put the categories in order",
    caption: "Open a category's menu, choose Rearrange, then drag it into place.",
  },
] as const;

export function DocumentOrganizationTour(props: Props) {
  const [index, setIndex] = createSignal(0);
  const step = createMemo(() => STEPS[index()]);
  const isLast = createMemo(() => index() === STEPS.length - 1);

  /**
   * Whether the clips play themselves.
   *
   * Read after mount because the server has no `matchMedia`; reduced motion gets
   * the same clips with controls instead of a loop.
   */
  const [autoplay, setAutoplay] = createSignal(true);
  onMount(() => {
    setAutoplay(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  });

  function close() {
    props.onUpdateShow?.(false);
  }

  return (
    <Dialog
      show={props.show}
      title={t("Organizing documents")}
      maxWidth="md:max-w-lg"
      bodyClass="px-5 pt-2 pb-4 overflow-y-auto"
      onUpdateShow={props.onUpdateShow}
      footer={
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-1.5">
            <For each={STEPS}>
              {(item, position) => (
                <button
                  type="button"
                  class="rounded-full p-1 transition-colors"
                  aria-label={t(item.title)}
                  aria-current={position() === index()}
                  onClick={() => setIndex(position())}
                >
                  <span
                    class="block h-1.5 w-1.5 rounded-full transition-colors"
                    classList={{
                      "bg-primary-600": position() === index(),
                      "bg-neutral-300": position() !== index(),
                    }}
                  />
                </button>
              )}
            </For>
          </div>

          <div class="flex items-center gap-2xs">
            <Show when={index() > 0}>
              <Button
                variant="secondary"
                text={t("Back")}
                onClick={() => setIndex(index() - 1)}
              />
            </Show>
            <Button
              text={isLast() ? t("Got it") : t("Next")}
              onClick={() => (isLast() ? close() : setIndex(index() + 1))}
            />
          </div>
        </div>
      }
    >
      {/* Keyed so a step change replaces the element, restarting the clip from its
          first frame instead of resuming the previous one. */}
      <Show when={step()} keyed>
        {(current) => (
          <div class="flex flex-col gap-3">
            {/* biome-ignore lint/a11y/useMediaCaption: these clips are silent screen recordings, so there is no audio to caption; the sentence below each one is the description. */}
            <video
              aria-label={t(current.caption)}
              class="w-full rounded-lg border border-neutral-100 bg-neutral-50"
              style={{ "aspect-ratio": "47 / 28" }}
              src={`/onboarding/${current.clip}.webm`}
              autoplay={autoplay()}
              loop={autoplay()}
              controls={!autoplay()}
              preload="auto"
              playsinline
              // Autoplay is refused for anything audible; these have no audio track.
              ref={(element) => {
                element.muted = true;
              }}
            />
            <div>
              <p class="font-semibold text-neutral-900 text-size-normal">
                {t(current.title)}
              </p>
              <p class="mt-0.5 text-neutral-500 text-size-normal">{t(current.caption)}</p>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
