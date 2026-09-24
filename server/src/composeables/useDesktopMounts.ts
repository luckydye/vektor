import { createSignal, onCleanup, onMount } from "solid-js";
import { api, type Space } from "#api/client.ts";
import {
  type NativeMount,
  type NativeMountsPayload,
  postToNativeApp,
} from "#utils/nativeApp.ts";

/**
 * Spaces the desktop app mounts as folders. The app owns the mounts and pushes
 * their state; this relays requests, mints the access token the app keeps in
 * the keychain, and deletes the tokens of removed mounts.
 */
export function useDesktopMounts() {
  const [mounts, setMounts] = createSignal<NativeMount[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [appError, setAppError] = createSignal<string | null>(null);
  // State arrives again while a deletion is in flight; this keeps it from starting twice.
  const revoking = new Set<string>();

  /**
   * The app lists these until confirmed, so tokens of mounts removed while no
   * page was listening get cleaned up the next time one is.
   */
  async function revoke(tokenIds: string[]) {
    const pending = tokenIds.filter((id) => !revoking.has(id));
    if (pending.length === 0) return;
    for (const id of pending) revoking.add(id);
    try {
      // Checked against the list rather than trusting a failed delete to mean
      // "already gone": another tab may have deleted it first.
      const { tokens } = await api.personalAccessTokens.get();
      for (const id of pending) {
        if (tokens.some((token) => token.id === id)) {
          await api.personalAccessTokens.delete(id);
        }
        postToNativeApp({ type: "tokenRevoked", tokenId: id });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      for (const id of pending) revoking.delete(id);
    }
  }

  onMount(() => {
    const onMounts = (event: Event) => {
      const payload = (event as CustomEvent<NativeMountsPayload>).detail;
      setMounts(payload.mounts);
      setAppError(payload.error ?? null);
      void revoke(payload.revoke);
    };
    window.addEventListener("vektor-app:mounts", onMounts);
    onCleanup(() => window.removeEventListener("vektor-app:mounts", onMounts));
    postToNativeApp({ type: "mountsRequest" });
  });

  function mount(space: Space, writable: boolean) {
    setError(null);
    postToNativeApp({ type: "mount", spaceId: space.id, spaceSlug: space.slug, writable });
  }

  /** Mints a token for the space; it shows up under Access Tokens as "Vektor Desktop". */
  async function authorize(mount: NativeMount) {
    setError(null);
    try {
      const { id, token } = await api.personalAccessTokens.create({
        name: "Vektor Desktop",
        spaceId: mount.spaceId,
        expiresInDays: null,
      });
      postToNativeApp({
        type: "mount",
        spaceId: mount.spaceId,
        spaceSlug: mount.spaceSlug,
        writable: mount.writable,
        token,
        tokenId: id,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return {
    mounts,
    error: () => error() ?? appError(),
    mount,
    authorize,
    unmount: (spaceId: string) => postToNativeApp({ type: "unmount", spaceId }),
    reveal: (spaceId: string) => postToNativeApp({ type: "revealMount", spaceId }),
  };
}
