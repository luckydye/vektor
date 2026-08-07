import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, on, Show } from "solid-js";
import { api } from "#api/client.ts";

interface Props {
  title: string;
  spaceId?: string;
  documentId?: string;
  initialEditMode?: boolean;
  canEdit?: boolean;
  onTitleUpdated?: (title: string) => void;
}

export function TitleEditor(props: Props) {
  const navigate = useNavigate();
  const [localTitle, setLocalTitle] = createSignal(props.title);
  const [isEditing, setIsEditing] = createSignal(
    Boolean(props.initialEditMode && props.canEdit),
  );
  let inputEl: HTMLInputElement | undefined;

  createEffect(
    on(
      () => props.title,
      (next) => setLocalTitle(next),
      { defer: true },
    ),
  );

  function startEditing() {
    if (!props.canEdit) return;
    setIsEditing(true);
    // No `nextTick`: the signal write renders synchronously, so the input is
    // already in the document.
    inputEl?.focus({ preventScroll: true });
  }

  async function updateTitle() {
    if (localTitle() !== props.title) {
      if (!props.canEdit) {
        setLocalTitle(props.title);
        setIsEditing(false);
        return;
      }
      props.onTitleUpdated?.(localTitle());
      window.dispatchEvent(
        new CustomEvent("title-changed", { detail: { title: localTitle() } }),
      );

      if (!props.documentId) {
        window.dispatchEvent(
          new CustomEvent("pending-title-changed", { detail: { title: localTitle() } }),
        );
        return;
      }

      try {
        if (!props.spaceId) throw new Error("No space selected");

        const data = await api.document.patch(props.spaceId, props.documentId, {
          properties: { title: { value: localTitle() } },
        });

        // Only a document still on its placeholder slug gets a new one, so this
        // fires once per document at most.
        if (data.slug && /\/doc\/[^/]+/.test(window.location.pathname)) {
          // Router paths are relative to its base ("/{spaceSlug}/"), so no
          // spacePath() prefix here.
          navigate(`/doc/${data.slug}`, { replace: true });
        }
      } catch (error) {
        console.error("Error saving title:", error);
      }
    }
    setIsEditing(false);
  }

  return (
    <div class="-ml-1 flex flex-1 items-center gap-3">
      <Show
        when={isEditing()}
        fallback={
          <div data-document-id={props.documentId} class="pointer-events-auto">
            <h1
              class="flex items-center gap-3 px-1 font-bold text-neutral-900 text-size-display"
              classList={{
                "cursor-text hover:bg-neutral-50": props.canEdit,
                "cursor-default": !props.canEdit,
              }}
              onDblClick={() => props.canEdit && startEditing()}
            >
              {localTitle() || "Untitled Document"}
            </h1>
          </div>
        }
      >
        <input
          ref={inputEl}
          type="text"
          placeholder="Untitled Document"
          class="pointer-events-auto flex-1 bg-neutral-50 px-1 font-bold text-neutral-900 text-size-display outline-none transition-colors placeholder:text-[#9ca3af] focus:border-blue-500 focus:ring-0"
          value={localTitle()}
          onInput={(event) => setLocalTitle(event.currentTarget.value)}
          onBlur={updateTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") void updateTitle();
          }}
        />
      </Show>
    </div>
  );
}
