import { createMemo, createSignal } from "solid-js";
import { useProperties } from "./useProperties.solid.ts";
import { useSpace } from "./useSpace.solid.ts";
import { useUploads } from "./useUploads.ts";

const HEADER_IMAGE_PROPERTY = "headerImage";

// Document types that don't render a header image.
const UNSUPPORTED_TYPES = ["app", "workflow"];

export function supportsHeaderImage(documentType?: string): boolean {
  return !UNSUPPORTED_TYPES.includes(documentType ?? "");
}

/**
 * Manage a document's header image (stored as the `headerImage` property).
 *
 * The header is server-rendered from `document.properties.headerImage`, so
 * mutations reload the page once saved — matching the pin/archive actions.
 */
export const [uploadingDocumentId, setUploadingDocumentId] = createSignal<string | null>(
  null,
);

export function useHeaderImage() {
  const { currentSpaceId } = useSpace();
  const { updateProperty } = useProperties();
  const { uploadFile } = useUploads();

  const isUploading = createMemo(() => uploadingDocumentId() !== null);
  const [dialogOpen, setDialogOpen] = createSignal(false);

  async function saveHeaderImage(documentId: string, url: string) {
    await updateProperty(documentId, HEADER_IMAGE_PROPERTY, url);
  }

  /** Open the image picker dialog. */
  function changeHeaderImage(_documentId: string) {
    setDialogOpen(true);
  }

  /** Upload the chosen file and set it as the document header. */
  async function uploadHeaderImage(documentId: string, file: File) {
    const spaceId = currentSpaceId();
    if (!spaceId || uploadingDocumentId() !== null) return;
    try {
      setUploadingDocumentId(documentId);
      // The upload manager reports progress and surfaces failures via the
      // shared toast; this composable only tracks the per-document busy state.
      const result = await uploadFile(file, {
        spaceId,
        documentId,
      });
      const url = typeof result?.url === "string" ? result.url : "";
      if (!url) throw new Error("Upload did not return a URL");
      await saveHeaderImage(documentId, url);
    } catch (error) {
      console.error("Failed to set header image:", error);
    } finally {
      setUploadingDocumentId(null);
    }
  }

  /** Clear the document header image (after confirmation). */
  async function removeHeaderImage(documentId: string) {
    const spaceId = currentSpaceId();
    if (!spaceId) return;
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
