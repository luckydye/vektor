import { createMemo, For, Show } from "solid-js";
import type { DocumentWithProperties } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { withTransformParams } from "#files/transformUrl.ts";
import { formatDate } from "#utils/datetime.ts";
import { spacePath } from "#utils/utils.ts";

interface Props {
  doc: DocumentWithProperties;
}

function docHeaderImage(doc: DocumentWithProperties): string | null {
  const headerImage = doc.properties?.headerImage;
  if (Array.isArray(headerImage)) return headerImage[0] ?? null;
  return headerImage ?? null;
}

function docTitle(doc: DocumentWithProperties) {
  const title = doc.properties?.title ?? doc.properties?.name;
  return title ? propertyValueToText(title) : "Untitled";
}

function docTags(doc: DocumentWithProperties): string[] {
  if (!doc.properties) return [];
  const excluded = new Set(["title", "name", "headerImage"]);
  return Object.entries(doc.properties)
    .filter(([k, v]) => !excluded.has(k) && v)
    .flatMap(([, v]) => (Array.isArray(v) ? v : [propertyValueToText(v)]));
}

export function DocumentTeaser(props: Props) {
  const { currentSpace } = useSpace();
  const tags = createMemo(() => docTags(props.doc));
  const headerImage = createMemo(() => docHeaderImage(props.doc));

  return (
    <page-target
      attr:data-document-id={props.doc.id}
      attr:data-document-type={props.doc.type ?? undefined}
      attr:data-space-id={currentSpace()?.id}
      attr:data-document-url={spacePath(currentSpace()?.slug, `/doc/${props.doc.slug}`)}
      class="block w-60 flex-none pr-4 [&[data-dragging]]:opacity-50"
    >
      {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
      <a
        href={
          props.doc.fileUrl ?? spacePath(currentSpace()?.slug, `/doc/${props.doc.slug}`)
        }
        target={props.doc.fileUrl ? "_blank" : undefined}
        rel={props.doc.fileUrl ? "noopener noreferrer" : undefined}
        class="group block"
      >
        <div class="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-neutral-200">
          <Show
            when={headerImage()}
            fallback={
              <span class="select-none font-medium text-neutral-400 text-sm">
                {props.doc.type ? props.doc.type.toUpperCase() : "DOC"}
              </span>
            }
          >
            {(url) => (
              <img
                src={withTransformParams(url(), { w: 400, format: "webp" })}
                class="absolute inset-0 h-full w-full object-cover"
                alt=""
              />
            )}
          </Show>
          <Show when={tags().length > 0}>
            <div class="absolute right-3 bottom-3 left-3 flex min-w-0 max-w-full gap-1.5">
              <For each={tags().slice(0, 1)}>
                {(tag) => (
                  <span
                    class="min-w-0 max-w-full truncate rounded-full bg-neutral-10 px-2.5 py-1 font-medium text-neutral-700 text-size-extra-small shadow-sm"
                    title={tag}
                  >
                    {tag}
                  </span>
                )}
              </For>
              <Show when={tags().length > 1}>
                <span class="shrink-0 rounded-full bg-neutral-10 px-2.5 py-1 font-medium text-neutral-700 text-size-extra-small shadow-sm">
                  +{tags().length - 1}
                </span>
              </Show>
            </div>
          </Show>
        </div>

        <div class="mt-3">
          <p class="mb-1 font-semibold text-neutral-500 text-size-extra-small tabular-nums">
            {formatDate(props.doc.updatedAt)}
          </p>
          <h4 class="line-clamp-3 font-bold text-primary-700 text-size-medium italic leading-snug transition-colors group-hover:text-primary-500">
            {docTitle(props.doc)}
          </h4>
          <Show when={tags().length > 0}>
            <p
              class="mt-1.5 line-clamp-2 min-w-0 break-words text-neutral-400 text-size-small"
              title={tags().join(" | ")}
            >
              {tags().join(" | ")}
            </p>
          </Show>
        </div>
      </a>
    </page-target>
  );
}
