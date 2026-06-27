import { computed, inject } from "vue";
import { useRoute as useVueRoute } from "vue-router";

export function useRoute() {
  const vueRoute = useVueRoute();
  // Fallback for the brief window before Vue Router resolves its initial
  // async navigation — params are empty until then.
  const ssrUrl = inject<string>("ssr:url", "");

  const pathname = computed(() => vueRoute.path || ssrUrl);

  const spaceSlug = computed(
    () => (vueRoute.params.spaceSlug as string) || ssrUrl.split("/")[1] || "",
  );

  const documentSlug = computed(() => {
    if (vueRoute.params.documentSlug) return vueRoute.params.documentSlug as string;
    const match = ssrUrl.match(/\/doc\/(.+)$/);
    return match ? match[1] : "";
  });

  return { pathname, spaceSlug, documentSlug };
}
