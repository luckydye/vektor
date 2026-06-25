import { computed, onMounted, onUnmounted, ref } from "vue";

export function useRoute() {
  const pathname = ref("");
  const spaceSlug = computed(() => {
    return pathname.value?.split("/")[1];
  });
  const documentSlug = computed(() => {
    return pathname.value?.split("/doc/")[2];
  });

  const updatePath = () => {
    pathname.value = window.location.pathname;
  };

  onMounted(() => {
    updatePath();
    document.addEventListener("astro:page-load", updatePath);
    window.addEventListener("popstate", updatePath);
    window.addEventListener("hashchange", updatePath);
  });
  onUnmounted(() => {
    document.removeEventListener("astro:page-load", updatePath);
    window.removeEventListener("popstate", updatePath);
    window.removeEventListener("hashchange", updatePath);
  });

  return {
    pathname,
    spaceSlug,
    documentSlug,
  };
}
