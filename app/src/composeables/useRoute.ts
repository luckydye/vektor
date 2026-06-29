import { computed, inject } from "vue";
import { useRoute as useVueRoute } from "vue-router";

export function useRoute() {
  const vueRoute = useVueRoute();
  // Fallback for the brief window before Vue Router resolves its initial
  // async navigation — params are empty until then.
  const ssrUrl = inject<string>("ssr:url", "");

  const pathname = computed(() => vueRoute.path || ssrUrl);

  const documentSlug = computed(() => {
    if (vueRoute.params.documentSlug) return vueRoute.params.documentSlug as string;
    // Only fall back to the SSR URL before Vue Router has matched any route
    // (the pre-hydration window). Once routes are resolved, an empty
    // documentSlug param means we are on a non-doc page — don't bleed
    // the initial SSR slug into unrelated pages.
    if (!vueRoute.matched.length) {
      const match = ssrUrl.match(/\/doc\/(.+)$/);
      return match ? match[1] : "";
    }
    return "";
  });

  return { pathname, documentSlug };
}
