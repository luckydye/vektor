import { For, Show } from "solid-js";

export interface OutlineEntry {
  slug: string;
  text: string;
}

export interface DocsNavProps {
  title: string;
  links: { href: string; label: string }[];
  currentPath: string;
  outline?: OutlineEntry[];
}

/**
 * The docs sidebar: page links, and under the current page its section outline.
 * Rendered twice by the docs layout — once for the sticky sidebar, once inside
 * the mobile disclosure.
 */
export function DocsNav(props: DocsNavProps) {
  return (
    <>
      <p class="docs-nav-title">{props.title}</p>
      <ul class="mt-3 space-y-0.5">
        <For each={props.links}>
          {(link) => (
            <li>
              <a
                href={link.href}
                class={
                  props.currentPath === link.href
                    ? "docs-nav-link docs-nav-link-active"
                    : "docs-nav-link"
                }
              >
                {link.label}
              </a>
              <Show when={props.currentPath === link.href && props.outline?.length}>
                <ul class="docs-nav-outline">
                  <For each={props.outline}>
                    {(section) => (
                      <li>
                        <a href={`#${section.slug}`} class="docs-nav-outline-link">
                          {section.text}
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </>
  );
}
