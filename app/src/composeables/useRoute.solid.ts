import { useLocation, useParams } from "@solidjs/router";
import { type Accessor, createContext, createMemo, useContext } from "solid-js";

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
  const location = useLocation();
  const params = useParams<{ documentSlug?: string }>();
  const ssrUrl = useContext(SsrUrlContext);

  return {
    pathname: createMemo(() => location.pathname || ssrUrl),
    documentSlug: createMemo(() => {
      if (params.documentSlug) return params.documentSlug;
      // Only fall back to the SSR URL before the router has matched anything
      // (the pre-hydration window). Once a route is resolved, an empty
      // documentSlug means we are on a non-doc page — don't bleed the initial
      // SSR slug into unrelated pages.
      //
      // `vue-route.matched.length` becomes an empty pathname here: Solid's
      // location has no `matched`, and an unresolved location reports `""`.
      if (!location.pathname) {
        const match = ssrUrl.match(/\/doc\/(.+)$/);
        return match ? match[1] : "";
      }
      return "";
    }),
  };
}
