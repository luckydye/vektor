import { onMounted, type Ref, ref } from "vue";

/**
 * False until after hydration, then true. One copy, previously four.
 *
 * Guards content that depends on browser-only state — stored theme, the upload
 * registry, the canvas — from rendering during SSR *or* hydration.
 *
 * **Not `isServer`.** The Solid idiom for this is `isServer` from
 * `solid-js/web`, and the migration ticket asks for that swap, but the two are
 * not equivalent under Vue: `isServer` is already false during hydration, while
 * this is still false until after it. Substituting it here was measured and
 * produces a hydration mismatch —
 * "rendered on server: No email, expected on client: local@localhost" — which
 * is the same class of bug as the FileDropOverlay one fixed in phase 0.
 *
 * So the swap belongs with each component's port, not before it: when a
 * consumer becomes `.tsx`, this call goes and `isServer` takes its place.
 */
export function useIsMounted(): Ref<boolean> {
  const isMounted = ref(false);
  onMounted(() => {
    isMounted.value = true;
  });
  return isMounted;
}
