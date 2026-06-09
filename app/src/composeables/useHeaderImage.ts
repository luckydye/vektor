import { ref } from "vue";
import { api } from "../api/client.ts";
import { useProperties } from "./useProperties.ts";
import { useSpace } from "./useSpace.ts";

const HEADER_IMAGE_PROPERTY = "headerImage";
const HEADER_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

// Document types that don't render a header image.
const UNSUPPORTED_TYPES = ["canvas", "app", "workflow"];

export function supportsHeaderImage(documentType?: string): boolean {
  return !UNSUPPORTED_TYPES.includes(documentType ?? "");
}

/**
 * Manage a document's header image (stored as the `headerImage` property).
 *
 * The header is server-rendered from `document.properties.headerImage`, so
 * mutations reload the page once saved — matching the pin/archive actions.
 */
export function useHeaderImage() {
  const { currentSpaceId } = useSpace();
  const { updateProperty } = useProperties();

  const isUploading = ref(false);

  async function saveHeaderImage(documentId: string, url: string) {
    await updateProperty(documentId, HEADER_IMAGE_PROPERTY, url);
    window.location.reload();
  }

  function pickImageFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = HEADER_IMAGE_ACCEPT;
      input.style.display = "none";

      input.addEventListener("change", () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      });
      // If the dialog is dismissed, the change event never fires; the input is
      // simply left detached and garbage-collected.
      document.body.appendChild(input);
      input.click();
    });
  }

  /** Prompt for an image, upload it, and set it as the document header. */
  async function changeHeaderImage(documentId: string) {
    if (!currentSpaceId.value || isUploading.value) return;

    const file = await pickImageFile();
    if (!file) return;

    try {
      isUploading.value = true;
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
      isUploading.value = false;
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
    supportsHeaderImage,
    changeHeaderImage,
    removeHeaderImage,
  };
}
