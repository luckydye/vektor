import { type Accessor, createMemo } from "solid-js";
import { useSpace } from "./useSpace.ts";
import { useUserProfile } from "./useUserProfile.ts";

/**
 * The URL a calendar app connects to: the current space's principal, since an
 * access token only authenticates where the URL names its space. Null until a
 * user and a space are both known.
 */
export function useCalDavServerUrl(): Accessor<string | null> {
  const user = useUserProfile();
  const { currentSpaceId } = useSpace();
  return createMemo(() => {
    const userId = user()?.id;
    const spaceId = currentSpaceId();
    if (typeof window === "undefined" || !userId || !spaceId) return null;
    return `${window.location.origin}/api/caldav/principals/${userId}/${spaceId}/`;
  });
}
