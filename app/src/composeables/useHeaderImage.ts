import { computed, ref } from "vue";
import { useProperties } from "./useProperties.ts";
import { useSpace } from "./useSpace.ts";
import { useUploads } from "./useUploads.ts";

const HEADER_IMAGE_PROPERTY = "headerImage";
// Aspect ratio (width / height) of the header image, stored so the document
// layout can be chosen server-side without having to decode the image first.
const HEADER_IMAGE_ASPECT_PROPERTY = "headerImageAspect";

// Document types that don't render a header image.
const UNSUPPORTED_TYPES = ["app", "workflow"];

export function supportsHeaderImage(documentType?: string): boolean {
  return !UNSUPPORTED_TYPES.includes(documentType ?? "");
}

/**
 * Read the natural aspect ratio (width / height) of an image file in the
 * browser. Returns null when it cannot be determined (SSR, decode failure, or
 * an unsupported format), in which case the layout falls back to landscape.
 */
export async function readImageAspectRatio(file: File): Promise<number | null> {
  if (typeof window === "undefined") return null;

  const isValid = (ratio: number) => Number.isFinite(ratio) && ratio > 0;

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const ratio = bitmap.width / bitmap.height;
      bitmap.close?.();
      if (isValid(ratio)) return ratio;
    } catch {
      // Fall through to the <img> decode path (e.g. SVGs).
    }
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight;
      URL.revokeObjectURL(url);
      resolve(isValid(ratio) ? ratio : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Manage a document's header image (stored as the `headerImage` property).
 *
 * The header is server-rendered from `document.properties.headerImage`, so
 * mutations reload the page once saved — matching the pin/archive actions.
 */
export const uploadingDocumentId = ref<string | null>(null);

export function useHeaderImage() {
  const { currentSpaceId } = useSpace();
  const { updateProperty } = useProperties();
  const { uploadFile } = useUploads();

  const isUploading = computed(() => uploadingDocumentId.value !== null);
  const dialogOpen = ref(false);

  async function saveHeaderImage(
    documentId: string,
    url: string,
    aspectRatio?: number | null,
  ) {
    // Persist the aspect ratio first so the header image and its layout hint
    // never render out of sync (the header is server-rendered from properties).
    await updateProperty(
      documentId,
      HEADER_IMAGE_ASPECT_PROPERTY,
      aspectRatio && aspectRatio > 0 ? String(aspectRatio) : "",
    );
    await updateProperty(documentId, HEADER_IMAGE_PROPERTY, url);
  }

  /** Open the image picker dialog. */
  function changeHeaderImage(_documentId: string) {
    dialogOpen.value = true;
  }

  /** Upload the chosen file and set it as the document header. */
  async function uploadHeaderImage(documentId: string, file: File) {
    if (!currentSpaceId.value || uploadingDocumentId.value !== null) return;
    try {
      uploadingDocumentId.value = documentId;
      // Measure the aspect ratio from the local file while the upload runs so
      // the stored value is ready by the time the URL is persisted.
      const [result, aspectRatio] = await Promise.all([
        // The upload manager reports progress and surfaces failures via the
        // shared toast; this composable only tracks the per-document busy state.
        uploadFile(file, {
          spaceId: currentSpaceId.value,
          documentId,
        }),
        readImageAspectRatio(file),
      ]);
      const url = typeof result?.url === "string" ? result.url : "";
      if (!url) throw new Error("Upload did not return a URL");
      await saveHeaderImage(documentId, url, aspectRatio);
    } catch (error) {
      console.error("Failed to set header image:", error);
    } finally {
      uploadingDocumentId.value = null;
    }
  }

  /** Clear the document header image (after confirmation). */
  async function removeHeaderImage(documentId: string) {
    if (!currentSpaceId.value) return;
    if (!confirm("Remove the header image from this document?")) return;
    await saveHeaderImage(documentId, "");
  }

  return {
    isUploading,
    dialogOpen,
    supportsHeaderImage,
    changeHeaderImage,
    uploadHeaderImage,
    removeHeaderImage,
  };
}
