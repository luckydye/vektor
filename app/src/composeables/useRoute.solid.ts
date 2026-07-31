import { useLocation, useParams } from "@solidjs/router";
import { type Accessor, createContext, useContext } from "solid-js";

/**
 * The URL the server rendered, for the window before the router has matched.
 *
 * Was `provide("ssr:url", …)` from `SpaceApp.vue`. Still needed: on the client
 * the router resolves its initial navigation asynchronously, so params are
 * empty for the first tick and a component reading `documentSlug` would blank
 * out and then refill.
 */
export const SsrUrlContext = createContext<string>("");

export function useRoute(): {
  pathname: Accessor<string>;
  documentSlug: Accessor<string>;
} {
  const ssrUrl = useContext(SsrUrlContext);

  // Plain accessors, not memos.
  //
  // `useLocation()` throws outside a `Route`. Vue's `computed` was lazy, so a
  // component that never rendered a route-dependent branch never evaluated it
  // and never needed a router — `DocumentTree` in the sidebar is exactly that
  // when its category list is empty. A Solid `createMemo` computes eagerly on
  // creation, so it would throw for every caller; a plain function defers the
  // read to the point of use the way the `computed` did, and stays reactive
  // because it reads the location signal inside whatever tracks it.
  //
  // Both are cheap enough that losing memoisation costs nothing.
  return {
    pathname: () => useLocation().pathname || ssrUrl,
    documentSlug: () => {
      const params = useParams<{ documentSlug?: string }>();
      if (params.documentSlug) return params.documentSlug;
      // Only fall back to the SSR URL before the router has matched anything
      // (the pre-hydration window). Once a route is resolved, an empty
      // documentSlug means we are on a non-doc page — don't bleed the initial
      // SSR slug into unrelated pages.
      //
      // `vue-route.matched.length` becomes an empty pathname here: Solid's
      // location has no `matched`, and an unresolved location reports `""`.
      if (!useLocation().pathname) {
        const match = ssrUrl.match(/\/doc\/(.+)$/);
        return match ? match[1] : "";
      }
      return "";
    },
  };
}
