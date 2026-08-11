import { createEffect, createSignal, onMount, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import { api, type DocumentWithProperties } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import docStyles from "#editor/css/document.css?inline";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  spaceId: string;
  pinnedDocumentId: string;
}

function docTitle(document: DocumentWithProperties): string {
  const title = document.properties?.title;
  return title ? propertyValueToText(title) : "Untitled";
}

export function PinnedDocument(props: Props) {
  const [doc, setDoc] = createSignal<DocumentWithProperties | null>(null);
  const { currentSpace } = useSpace();
  const userCanEdit = () => canEdit(currentSpace()?.userRole);

  let viewEl: HTMLElement | undefined;

  onMount(async () => {
    setDoc(await api.document.get(props.spaceId, props.pinnedDocumentId));
  });

  function renderContent(html: string) {
    if (!viewEl) return;
    const root = viewEl.shadowRoot;
    if (!root) {
      requestAnimationFrame(() => renderContent(html));
      return;
    }
    root.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = docStyles;
    const content = document.createElement("div");
    content.setAttribute("part", "content");
    const inner = document.createElement("div");
    inner.innerHTML = html;
    content.appendChild(inner);
    root.appendChild(style);
    root.appendChild(content);
  }

  createEffect(() => {
    const current = doc();
    if (current && (!current.type || current.type === "document")) {
      renderContent(current.content ?? "");
    }
  });

  async function unpin() {
    const space = currentSpace();
    if (!space) throw new Error("No space loaded");
    await api.space.patch(space.id, { preferences: { pinnedDocumentId: "" } });
    window.location.reload();
  }

  return (
    <div class="mb-10 overflow-hidden">
      <div class="flex items-center justify-between">
        {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
        <a
          href={
            doc() ? spacePath(currentSpace()?.slug, `/doc/${doc()?.slug}`) : undefined
          }
          class="group flex items-center gap-2"
        >
          <Icon class="h-3.5 w-3.5 shrink-0 text-amber-500" name="pin-to-home" />
          <span class="font-semibold text-amber-600 text-size-small uppercase tracking-wide">
            Pinned
          </span>
          <Show
            when={doc()}
            fallback={<span class="h-4 w-40 animate-pulse rounded-sm bg-amber-100" />}
          >
            {(current) => (
              <span class="font-semibold text-neutral-800 text-size-medium transition-colors group-hover:text-blue-600">
                {docTitle(current())}
              </span>
            )}
          </Show>
        </a>
        <Show when={userCanEdit()}>
          <button
            type="button"
            onClick={unpin}
            class="text-neutral-400 text-size-small transition-colors hover:text-neutral-700"
          >
            Unpin
          </button>
        </Show>
      </div>

      <div class="relative overflow-hidden">
        <Show
          when={doc()?.type && doc()?.type !== "document"}
          fallback={<document-view ref={viewEl} class="block" />}
        >
          {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
          <a
            href={spacePath(currentSpace()?.slug, `/doc/${doc()?.slug}`)}
            class="mt-3 flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 transition-colors hover:bg-neutral-100"
          >
            <span class="font-medium text-neutral-800 text-size-medium">
              {docTitle(doc() as DocumentWithProperties)}
            </span>
            <span class="ml-auto text-neutral-400 text-size-small capitalize">
              {doc()?.type}
            </span>
          </a>
        </Show>
      </div>
    </div>
  );
}
