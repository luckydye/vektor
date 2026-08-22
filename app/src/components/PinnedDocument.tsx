import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { canEdit } from "#acl/permissions.ts";
import { api, type DocumentWithProperties } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { propertyValueToText } from "#documents/properties.ts";
import docStyles from "#editor/css/document.css?inline";
import { sanitizeDocumentHtml } from "#utils/html.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  spaceId: string;
  pinnedDocumentId: string;
}

interface CardProps {
  document: DocumentWithProperties;
  href: string;
  title: string;
  canUnpin: boolean;
  labels: {
    pinned: string;
    unpin: string;
    open: string;
  };
  onUnpin: () => void;
  viewRef: (element: HTMLElement) => void;
}

function docTitle(document: DocumentWithProperties, untitled: string): string {
  const title = document.properties?.title;
  return title ? propertyValueToText(title) : untitled;
}

function PinnedDocumentCard(props: CardProps) {
  return (
    <section class="overflow-hidden rounded-lg border border-neutral-100 bg-neutral-25">
      <div class="flex items-center gap-2.5 px-4 py-3">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-100">
          <Icon class="h-3.5 w-3.5 text-amber-600" name="pin-to-home" />
        </span>

        <div class="flex min-w-0 flex-1 items-center gap-2">
          <span class="shrink-0 font-semibold text-amber-700 text-size-extra-small uppercase tracking-[0.1em]">
            {props.labels.pinned}
          </span>
          <span class="text-neutral-300">·</span>
          <h2 class="truncate font-medium text-neutral-600 text-size-normal">
            {props.title}
          </h2>
        </div>

        <Show when={props.canUnpin}>
          <button
            type="button"
            onClick={props.onUnpin}
            class="shrink-0 rounded-md px-2 py-1 text-neutral-400 text-size-extra-small transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          >
            {props.labels.unpin}
          </button>
        </Show>
      </div>

      {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
      <a
        href={props.href}
        class="group block border-neutral-100 border-t bg-background px-4 py-3.5 transition-colors hover:bg-neutral-50"
      >
        <Show
          when={!props.document.type || props.document.type === "document"}
          fallback={
            <p class="text-neutral-400 text-size-medium capitalize">
              {props.document.type ?? "document"}
            </p>
          }
        >
          <div class="relative max-h-72 overflow-hidden">
            <document-view
              ref={props.viewRef}
              class="pointer-events-none block text-size-normal"
            />
            <div class="pointer-events-none absolute right-0 bottom-0 left-0 h-10 bg-linear-to-t from-background to-transparent transition-colors group-hover:from-neutral-50" />
          </div>
        </Show>

        <span class="mt-3 inline-flex items-center gap-1 font-medium text-neutral-600 text-size-small transition-colors group-hover:text-primary-700">
          {props.labels.open}
          <Icon
            class="h-3 w-3 transition-transform group-hover:translate-x-0.5"
            name="chevron-right-thin"
          />
        </span>
      </a>
    </section>
  );
}

function PinnedDocumentSkeleton() {
  return (
    <div class="overflow-hidden rounded-lg border border-neutral-100">
      <div class="flex items-center gap-2.5 bg-neutral-25 px-4 py-3">
        <span class="h-6 w-6 animate-pulse rounded-md bg-neutral-100" />
        <div class="h-3 w-60 animate-pulse rounded bg-neutral-100" />
      </div>
      <div class="space-y-2 border-neutral-100 border-t px-4 py-3.5">
        <div class="h-3 w-full animate-pulse rounded bg-neutral-100" />
        <div class="h-3 w-4/5 animate-pulse rounded bg-neutral-100" />
      </div>
    </div>
  );
}

export function PinnedDocument(props: Props) {
  const [doc, setDoc] = createSignal<DocumentWithProperties | null>(null);
  const { currentSpace } = useSpace();
  const navigate = useNavigate();
  const toast = useToast();
  const t = useTranslation();
  const userCanEdit = () => canEdit(currentSpace()?.userRole);
  const documentHref = createMemo(() =>
    spacePath(currentSpace()?.slug, `/doc/${doc()?.slug}`),
  );
  let viewEl: HTMLElement | undefined;

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
    inner.innerHTML = sanitizeDocumentHtml(html);
    content.appendChild(inner);
    root.appendChild(style);
    root.appendChild(content);
  }

  function setViewElement(element: HTMLElement) {
    viewEl = element;
    const current = doc();
    if (current) renderContent(current.content ?? "");
  }

  onMount(async () => {
    setDoc(await api.document.get(props.spaceId, props.pinnedDocumentId));
  });

  createEffect(() => {
    const current = doc();
    if (current && (!current.type || current.type === "document")) {
      renderContent(current.content ?? "");
    }
  });

  async function unpin() {
    const space = currentSpace();
    if (!space) throw new Error("No space loaded");
    const documentRoute = `/doc/${doc()?.slug}`;
    await api.space.patch(space.id, { preferences: { pinnedDocumentId: "" } });
    toast.show(t("Unpinned from Home"), "success", 8000, {
      action: {
        label: t("Open document"),
        run: () => navigate(documentRoute),
      },
    });
  }

  return (
    <Show when={doc()} fallback={<PinnedDocumentSkeleton />}>
      {(current) => (
        <PinnedDocumentCard
          document={current()}
          href={documentHref()}
          title={docTitle(current(), t("Untitled"))}
          canUnpin={userCanEdit()}
          labels={{
            pinned: t("Pinned"),
            unpin: t("Unpin"),
            open: t("Open document"),
          }}
          onUnpin={() => void unpin()}
          viewRef={setViewElement}
        />
      )}
    </Show>
  );
}
