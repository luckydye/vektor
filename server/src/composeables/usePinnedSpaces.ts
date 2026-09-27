import type { Accessor } from "solid-js";
import { PINNED_SPACES_CODEC, PINNED_SPACES_KEY } from "#utils/pinnedSpaces.ts";
import { usePersistedState } from "./usePersistedState.ts";

export interface PinnedSpaces {
  pinnedSpaceIds: Accessor<ReadonlySet<string>>;
  isPinned: (spaceId: string) => boolean;
  /** Pins an unpinned space and unpins a pinned one. */
  togglePin: (spaceId: string) => void;
}

/**
 * The set is restored after mount, so the first render lists spaces in their
 * plain order and pins rearrange them once the stored value lands — the same
 * hydration-safe bargain every `usePersistedState` caller makes.
 */
export function usePinnedSpaces(): PinnedSpaces {
  const { value, commit } = usePersistedState<Set<string>>({
    key: PINNED_SPACES_KEY,
    fallback: new Set(),
    ...PINNED_SPACES_CODEC,
  });

  return {
    pinnedSpaceIds: value,
    isPinned: (spaceId) => value().has(spaceId),
    togglePin(spaceId) {
      // A fresh Set, because the memos reading this compare by reference.
      const next = new Set(value());
      if (!next.delete(spaceId)) next.add(spaceId);
      commit(next);
    },
  };
}
