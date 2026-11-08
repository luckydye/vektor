import { For, Show } from "solid-js";
import { renderDocumentReadShadowHtml } from "#editor/readView.ts";
import { escapeHtml } from "#utils/html.ts";
import { raw } from "../raw.ts";

export interface SharePageProps {
  title: string;
  spaceId: string;
  documentId: string;
  /** The published content to show as a document; null for a type with no read view. */
  publishedContent: string | null;
  /** The type of a document that has no read view, named in the placeholder. */
  documentType: string;
  children: { href: string; title: string }[];
}

/**
 * A shared page, read-only. Rendered on the server only: the `document-view`
 * element upgrades itself in the browser, so there is nothing to hydrate.
 */
export function SharePage(props: SharePageProps) {
  return (
    <main class="mx-auto w-full max-w-(--document-width) px-xs py-10 md:px-s">
      <h1 class="mb-xl font-bold text-neutral-900 text-size-display">{props.title}</h1>

      <Show
        when={props.publishedContent !== null}
        fallback={
          <p class="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-600 text-size-medium">
            This page is a {props.documentType}, which only opens in Vektor. Sign in to
            view it.
          </p>
        }
      >
        {/* A string rather than JSX: the element is upgraded in the browser, and
            Solid drops un-namespaced dynamic attributes on custom elements. */}
        {raw(
          `<document-view space-id="${escapeHtml(props.spaceId)}" document-id="${escapeHtml(props.documentId)}" readonly>${renderDocumentReadShadowHtml(props.publishedContent ?? "", { readonly: true })}</document-view>`,
        )}
      </Show>

      <Show when={props.children.length > 0}>
        <nav class="mt-10 border-neutral-100 border-t pt-6">
          <h2 class="mb-2 text-neutral-400 text-size-small">Pages in this share</h2>
          <ul class="space-y-1">
            <For each={props.children}>
              {(child) => (
                <li>
                  <a class="text-neutral-900 text-size-medium underline" href={child.href}>
                    {child.title}
                  </a>
                </li>
              )}
            </For>
          </ul>
        </nav>
      </Show>

      <footer class="mt-10 border-neutral-100 border-t pt-6 text-neutral-400 text-size-small">
        Shared read-only through a link.
      </footer>
    </main>
  );
}
