/**
 * Which spaces this browser keeps within reach.
 *
 * A pin says nothing about the space itself — it is one person's shortcut, like
 * an expanded tree node — so it stays on the client and never reaches the API.
 */

/** Entries are space IDs. `usePinnedSpaces` is the reactive way in. */
export const PINNED_SPACES_KEY = "pinned-spaces";

export const PINNED_SPACES_CODEC = {
  parse: (raw: string) => new Set<string>(JSON.parse(raw)),
  serialize: (ids: Set<string>) => JSON.stringify([...ids]),
};

/** How short the switcher's list is allowed to get before it borrows filler. */
export const SPACE_SELECTOR_MINIMUM = 6;

/**
 * The spaces the switcher shows: every pinned one, then enough from the top of
 * the list to reach `minimum`. Pinning is not rationing — a seventh pin adds a
 * row rather than evicting one — the minimum only keeps a barely-pinned
 * switcher from looking empty. Both halves keep the order they arrived in.
 */
export function spaceSelectorSlots<T extends { id: string }>(
  spaces: readonly T[],
  pinnedIds: ReadonlySet<string>,
  minimum: number = SPACE_SELECTOR_MINIMUM,
): T[] {
  const pinned = spaces.filter((space) => pinnedIds.has(space.id));
  const rest = spaces.filter((space) => !pinnedIds.has(space.id));
  return [...pinned, ...rest.slice(0, Math.max(0, minimum - pinned.length))];
}
