import { createSignal } from "solid-js";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";
import { useToast } from "#composeables/useToast.ts";

interface Props {
  documentId: string;
}

export function RestoreButton(props: Props) {
  const [isLoading, setIsLoading] = createSignal(false);
  const { currentSpaceId } = useSpace();

  async function handleRestore() {
    if (!(await confirmDialog("Are you sure you want to restore this document?"))) return;

    const spaceId = currentSpaceId();
    if (!spaceId) {
      useToast().error("No space selected");
      return;
    }

    setIsLoading(true);
    try {
      await api.document.restore(spaceId, props.documentId);
      window.location.reload();
    } catch (err) {
      useToast().error(err instanceof Error ? err.message : "Failed to restore document");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleRestore}
      disabled={isLoading()}
      class="whitespace-nowrap rounded-sm bg-green-600 px-3 py-1 font-medium text-size-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isLoading() ? "Restoring..." : "Restore"}
    </button>
  );
}
