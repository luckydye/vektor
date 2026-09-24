import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, on, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { api } from "#api/client.ts";

interface Props {
  title: string;
  spaceId?: string;
  documentId?: string;
  initialEditMode?: boolean;
  canEdit?: boolean;
  variant?: "display" | "breadcrumb";
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

  createEffect(() => {
    if (!isEditing()) return;
    inputEl?.focus({ preventScroll: true });
  });

  function startEditing() {
    if (!props.canEdit) return;
    setIsEditing(true);
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

        if (data.slug && /\/doc\/[^/]+/.test(window.location.pathname)) {
          navigate(`/doc/${data.slug}`, { replace: true });
        }
      } catch (error) {
        console.error("Error saving title:", error);
      }
    }
    setIsEditing(false);
  }

  const variant = () => props.variant ?? "display";
  const titleTag = () => (variant() === "breadcrumb" ? "span" : "h1");
  const displayClasses = () =>
    variant() === "breadcrumb"
      ? "block px-1 font-medium text-neutral-900"
      : "flex items-center gap-3 px-1 font-bold text-neutral-900 text-size-display";
  const inputClasses = () =>
    variant() === "breadcrumb"
      ? "[field-sizing:content] bg-neutral-50 px-1 font-medium text-neutral-900 outline-none transition-colors placeholder:text-[#9ca3af] focus:border-blue-500 focus:ring-0"
      : "flex-1 bg-neutral-50 px-1 font-bold text-neutral-900 text-size-display outline-none transition-colors placeholder:text-[#9ca3af] focus:border-blue-500 focus:ring-0";

  return (
    <div
      class={twMerge(
        "flex min-w-0 items-center",
        variant() === "display" && "-ml-1 flex-1 gap-3",
      )}
    >
      <Show
        when={isEditing()}
        fallback={
          <div data-document-id={props.documentId} class="pointer-events-auto">
            <Dynamic
              component={titleTag()}
              class={displayClasses()}
              classList={{
                "cursor-text hover:bg-neutral-50": props.canEdit,
                "cursor-default": !props.canEdit,
              }}
              title={localTitle()}
              onDblClick={() => props.canEdit && startEditing()}
            >
              {localTitle() || "Untitled Document"}
            </Dynamic>
          </div>
        }
      >
        <input
          ref={inputEl}
          type="text"
          placeholder="Untitled Document"
          class={twMerge("pointer-events-auto", inputClasses())}
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
