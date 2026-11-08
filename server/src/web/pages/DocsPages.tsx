import { For } from "solid-js";
import docStyles from "#editor/css/document.css?inline";
import docsProseStyles from "#styles/docs.css?inline";
import { raw } from "../raw.ts";
import { DocsLayout } from "./DocsLayout.tsx";

export interface DocsIndexPageProps {
  currentPath: string;
}

const INDEX_PAGES = [
  {
    href: "/docs/api",
    title: "API",
    description: "REST endpoints for spaces, documents, workflows, and extensions.",
  },
  {
    href: "/docs/permissions",
    title: "Permissions",
    description: "Roles, features, scopes, groups, and who may grant what.",
  },
  {
    href: "/docs/extensions",
    title: "Extensions",
    description: "Build and package extensions that add jobs, tools, and UI to Vektor.",
  },
];

export function DocsIndexPage(props: DocsIndexPageProps) {
  return (
    <DocsLayout currentPath={props.currentPath}>
      <h1
        class="text-2xl font-semibold text-neutral-900 mb-2"
        style="letter-spacing: -0.02em"
      >
        Documentation
      </h1>
      <p class="text-neutral-500 mb-8">
        Guides and references for building on and integrating with Vektor.
      </p>

      <div class="grid gap-4 sm:grid-cols-2">
        <For each={INDEX_PAGES}>
          {(page) => (
            <a
              href={page.href}
              class="group block p-5 rounded-xl border border-neutral-200 bg-background hover:border-primary-300 hover:shadow-sm transition-all"
            >
              <h2 class="font-semibold text-neutral-900 mb-1 flex items-center gap-1.5">
                {page.title}
                <svg
                  aria-hidden="true"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="text-neutral-400 group-hover:text-primary-500 group-hover:translate-x-0.5 transition-all"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </h2>
              <p class="text-size-medium text-neutral-500">{page.description}</p>
            </a>
          )}
        </For>
      </div>
    </DocsLayout>
  );
}

export interface DocsMarkdownPageProps {
  currentPath: string;
  /** Rendered by `renderMarkdown` from a docs file this repo ships, so trusted. */
  html: string;
  outline: { slug: string; text: string }[];
}

/**
 * A markdown docs page inside a shadow root, so the editor's document styles can
 * be reused without leaking into the surrounding site chrome. The markdown ends
 * up *inside* the declarative template, which is what puts it under these styles.
 */
export function DocsMarkdownPage(props: DocsMarkdownPageProps) {
  return (
    <DocsLayout currentPath={props.currentPath} outline={props.outline}>
      {raw(
        `<docs-content><template shadowrootmode="open"><style>${docStyles}</style><style>${docsProseStyles}</style>${props.html}</template></docs-content>`,
      )}
    </DocsLayout>
  );
}
