/**
 * Reading and writing state that belongs to this browser.
 *
 * Every access is guarded, because there are more ways for `localStorage` to
 * fail than being absent on the server: Safari throws on the property itself when
 * the user blocks storage, `setItem` throws when the quota is full or the store
 * is read-only, and an entry can be stale or hand-edited into nonsense. A feature
 * that remembers a preference must not become a feature that crashes, so every
 * failure here is silent by design — the cost is forgetting a preference.
 *
 * Reactive callers want `usePersistedState`, which adds the two things a
 * component needs on top of this: reads that wait for mount so hydration still
 * matches, and a restore that waits for the data the stored value refers to.
 */

/**
 * Which store an entry lives in.
 *
 * `local` outlives the tab and is shared by every tab of the same profile.
 * `session` belongs to one tab and dies with it — the right choice when two
 * windows of the same app must *not* agree: a per-tab identity, a scroll position,
 * a layout tweak that should not follow the user into their next visit.
 */
export type StorageArea = "local" | "session";

export interface StoredValueOptions<T> {
  /** Defaults to `local`. */
  area?: StorageArea;
  /**
   * Defaults to JSON. Return `null` to reject an entry — this doubles as the
   * validation hook, so a value that no longer passes reads as nothing stored.
   */
  parse?: (raw: string) => T | null;
  /**
   * Defaults to JSON. Override it for a key whose format is fixed by something
   * outside this call: entries already in the wild, or another consumer that
   * reads the same key.
   */
  serialize?: (value: T) => string;
}

/**
 * For keys whose entries are plain text: a format that predates JSON, or one that
 * another consumer — a cookie, an inline pre-paint script — reads raw.
 */
export const storedText: StoredValueOptions<string> = {
  parse: (raw) => raw,
  serialize: (value) => value,
};

/**
 * Resolved per call, never cached: touching either store is what throws when the
 * browser has them blocked, so it has to happen inside a caller's `try`.
 */
function areaStore(area: StorageArea | undefined): Storage {
  return area === "session" ? sessionStorage : localStorage;
}

/** The stored value, or `null` for absent, unreadable and rejected alike. */
export function readStored<T>(key: string, options?: StoredValueOptions<T>): T | null {
  let raw: string | null;
  try {
    raw = areaStore(options?.area).getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parse = options?.parse ?? ((value: string) => JSON.parse(value) as T);
    return parse(raw);
  } catch {
    return null;
  }
}

export function writeStored<T>(
  key: string,
  value: T,
  options?: StoredValueOptions<T>,
): void {
  try {
    const serialize = options?.serialize ?? ((next: T) => JSON.stringify(next));
    areaStore(options?.area).setItem(key, serialize(value));
  } catch {
    // Nothing to fall back to: the value stays in memory for this session.
  }
}

export function removeStored(key: string, area?: StorageArea): void {
  try {
    areaStore(area).removeItem(key);
  } catch {
    // Already unreachable, which is the state the caller wanted.
  }
}

/**
 * Watch one key for changes made in *other* tabs — the `storage` event never
 * fires in the tab that did the writing.
 *
 * Only for state that should be shared browser-wide, like a theme. State that is
 * per-view (which tab is open, where a panel sits) is better left alone: two
 * windows opened side by side are usually opened precisely so they can differ.
 *
 * `local` only — a `session` entry is private to its tab, so no other tab can
 * change it and the event would never fire.
 */
export function subscribeStored(key: string, onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: StorageEvent) => {
    if (event.key === key) onChange();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
