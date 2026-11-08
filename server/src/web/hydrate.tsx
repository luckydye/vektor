import { type Component, Suspense } from "solid-js";
import { hydrate } from "solid-js/web";
import { PAGE_ROOT_ID } from "./pages.ts";

/**
 * Takes over the server-rendered page. The props are the ones the server
 * rendered with, so both sides produce the same markup.
 */
export function hydratePage<P extends object>(Page: Component<P>, props: unknown): void {
  const root = document.getElementById(PAGE_ROOT_ID);
  if (!root) return;
  hydrate(
    () => (
      <Suspense>
        <Page {...(props as P)} />
      </Suspense>
    ),
    root,
  );
}
