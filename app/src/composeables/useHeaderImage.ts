import { computed, ref } from "vue";
import { api } from "#api/client.ts";
import { useProperties } from "./useProperties.ts";
import { useSpace } from "./useSpace.ts";

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
export const uploadingDocumentId = ref<string | null>(null);

export function useHeaderImage() {
  const { currentSpaceId } = useSpace();
  const { updateProperty } = useProperties();

  const isUploading = computed(() => uploadingDocumentId.value !== null);
  const dialogOpen = ref(false);

  async function saveHeaderImage(documentId: string, url: string) {
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
      const result = await api.uploads.post(
        currentSpaceId.value,
        file,
        file.name,
        documentId,
      );
      const url = typeof result?.url === "string" ? result.url : "";
      if (!url) throw new Error("Upload did not return a URL");
      await saveHeaderImage(documentId, url);
    } catch (error) {
      console.error("Failed to set header image:", error);
      alert("❌ Failed to upload header image. Please try again.");
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
