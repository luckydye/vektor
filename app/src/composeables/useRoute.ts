import { onMounted, onUnmounted, ref, watch, computed } from "vue";

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
    window.addEventListener("popstate", updatePath);
    window.addEventListener("hashchange", updatePath);
  });
  onUnmounted(() => {
    window.removeEventListener("popstate", updatePath);
    window.removeEventListener("hashchange", updatePath);
  });

  return {
    pathname,
    spaceSlug,
    documentSlug,
  };
}
