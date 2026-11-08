import { For, type JSX } from "solid-js";
import { DOCS_NAVIGATION } from "../docs/navigation.ts";
import { DocsNav, type OutlineEntry } from "./DocsNav.tsx";

export interface DocsLayoutProps {
  currentPath: string;
  outline?: OutlineEntry[];
  children: JSX.Element;
}

/** The docs site chrome: header, sidebar, mobile section nav and the content column. */
export function DocsLayout(props: DocsLayoutProps) {
  return (
    <div class="min-h-screen flex flex-col">
      <header class="sticky top-0 z-10 border-b border-primary-600/12 bg-background/80 backdrop-blur-sm">
        <div class="max-w-[84rem] mx-auto flex items-center gap-3 px-5 sm:px-6 h-16">
          <a href="/" class="docs-logo shrink-0">
            <img src="/favicon_dark.png" alt="" class="docs-logo-mark docs-logo-mark-light" />
            <img src="/favicon_light.png" alt="" class="docs-logo-mark docs-logo-mark-dark" />
            Vektor
          </a>
          <span class="text-neutral-300">/</span>
          <a
            href="/docs"
            class="text-size-medium font-medium text-neutral-500 hover:text-primary-700 transition-colors"
          >
            Docs
          </a>
        </div>
      </header>

      <main class="flex-1 max-w-[84rem] w-full mx-auto px-5 sm:px-6">
        <div class="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
          {/* Sidebar */}
          <aside class="hidden lg:block border-r border-primary-600/12">
            <nav
              class="docs-nav sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-10 pr-6"
              aria-label="Documentation"
            >
              <For each={DOCS_NAVIGATION}>
                {(group) => (
                  <div class="mb-8">
                    <DocsNav
                      title={group.title}
                      links={group.links}
                      currentPath={props.currentPath}
                      outline={props.outline}
                    />
                  </div>
                )}
              </For>
            </nav>
          </aside>

          {/* Content */}
          <article class="min-w-0 py-10 lg:py-14">
            {/* Mobile section nav */}
            <details class="mb-8 lg:hidden">
              <summary class="flex cursor-pointer items-center justify-between rounded-xl border border-primary-600/20 bg-primary-600/5 px-4 py-3 text-size-medium font-semibold text-primary-700">
                Browse documentation
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
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <div class="mt-3 rounded-xl border border-primary-600/15 p-4">
                <For each={DOCS_NAVIGATION}>
                  {(group) => (
                    <div class="mb-4 last:mb-0">
                      <DocsNav
                        title={group.title}
                        links={group.links}
                        currentPath={props.currentPath}
                        outline={props.outline}
                      />
                    </div>
                  )}
                </For>
              </div>
            </details>

            <div class="max-w-[64rem]">{props.children}</div>
          </article>
        </div>
      </main>
    </div>
  );
}
