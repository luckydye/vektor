import { createMemo, Show } from "solid-js";
import { useDocument } from "#composeables/useDocument.ts";
import { uploadingDocumentId } from "#composeables/useHeaderImage.ts";
import { withTransformParams } from "#files/transformUrl.ts";

interface Props {
  documentId: string;
  initialSrc?: string | null;
  orientation?: "landscape" | "portrait";
  aspectRatio?: number | null;
  class?: string;
}

export function HeaderImage(props: Props) {
  const isPortrait = () => props.orientation === "portrait";
  const aspectStyle = () =>
    isPortrait() && props.aspectRatio && props.aspectRatio > 0
      ? { "aspect-ratio": String(props.aspectRatio) }
      : undefined;

  const { document: doc, isLoading } = useDocument(() => props.documentId);

  const src = createMemo(() => {
    const headerImage = doc()?.properties?.headerImage;
    const url = Array.isArray(headerImage)
      ? headerImage[0]
      : (headerImage ?? props.initialSrc);
    return url ? withTransformParams(url, { w: 1600, format: "webp", q: 85 }) : null;
  });

  const isUploadingHeader = () => uploadingDocumentId() === props.documentId;
  const showSkeleton = createMemo(
    () => isUploadingHeader() || (isLoading() && !!props.initialSrc),
  );

  return (
    <Show when={src() || showSkeleton()}>
      <div
        class={`${isPortrait() ? "" : "px-xs md:px-m print:px-0"} ${props.class ?? ""}`}
      >
        <Show when={showSkeleton() && !src()}>
          <div
            class={
              isPortrait()
                ? "w-full animate-pulse rounded-lg bg-neutral-50"
                : "h-[240px] w-full animate-pulse rounded-lg bg-neutral-50"
            }
            style={aspectStyle()}
          />
        </Show>
        <Show when={src()}>
          {(url) => (
            <img
              src={url()}
              alt=""
              class={
                isPortrait()
                  ? "h-auto w-full rounded-lg object-cover"
                  : "h-[240px] w-full rounded-lg object-cover"
              }
              style={aspectStyle()}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}
