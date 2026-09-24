import { type Accessor, createEffect, createSignal, onMount } from "solid-js";
import {
  readStored,
  type StoredValueOptions,
  writeStored,
} from "#utils/clientStorage.ts";

export interface PersistedStateOptions<T> extends StoredValueOptions<T> {
  /**
   * Where the value lives.
   *
   * An accessor lets the state follow whatever it belongs to: build the key from
   * a document ID and navigating to another document resets the value and
   * restores that document's own, without the caller wiring anything up.
   *
   * `null` means "nothing to persist under" — the state still works, it just is
   * not remembered. For a component whose subject is optional, that beats
   * inventing a shared key that unrelated instances would then collide on.
   */
  key: Accessor<string | null> | string;
  /** The value before anything is restored, and whenever the key moves on. */
  fallback: T;
  /**
   * Whether a stored value can be applied yet — read reactively, so it is
   * re-checked as its inputs change.
   *
   * Client state usually names something that loads asynchronously: a selected
   * tab points at a list that arrives from a query, a scroll target at rows that
   * are still coming. Applying the stored value before then hands downstream code
   * a reference it cannot resolve, and whatever guards against that discards it
   * for good — a moment before the data would have made it valid. Returning
   * `false` keeps the value pending and applies it on the first render where it
   * becomes usable.
   */
  canApply?: (value: T) => boolean;
  /**
   * Runs immediately before a change the user did not make: a restore, or the
   * reset that follows the key moving to another entity.
   *
   * Side effects that should only answer to real interaction — an animation, a
   * "dirty" flag, analytics — are suppressed here.
   */
  onAdopt?: (value: T) => void;
}

export interface PersistedState<T> {
  value: Accessor<T>;
  /** Change and remember. The path for anything the user did. */
  commit: (next: T) => void;
  /**
   * Change without remembering, for corrections the user did not ask for — such
   * as falling back when the current value stops being valid. What is stored
   * stays put, so the state returns as soon as it can be honoured again.
   */
  set: (next: T) => void;
  /**
   * Re-read what is stored and apply it again, subject to `canApply`.
   *
   * For a caller that moved the value somewhere temporary with `set` — a mode
   * that collapses everything, a preview — and now wants the remembered one back.
   */
  restore: () => void;
}

/**
 * State that belongs to this browser and never leaves it.
 *
 * For preferences that are the user's own rather than the document's: which tab
 * is open, which sections are expanded, where a panel sits. Storing those on the
 * server would make one person's working state everyone's, and putting them in
 * the URL would make them shareable — both are the wrong answer for something
 * only this browser should know.
 *
 * Two things this handles that a bare `localStorage.getItem` in a component does
 * not, and that are the reason it exists:
 *
 * - **Reads happen after mount.** Islands are server-rendered (`client:load`), so
 *   a read during the first render produces markup the server could not have
 *   produced and hydration disagrees.
 * - **Restoring waits for `canApply`.** See the option: a stored value that names
 *   async data is applied when that data lands, not thrown away before it.
 *
 * Deliberately not cross-tab: there is no `storage` listener, so two tabs keep
 * their own state. Where sharing *is* wanted (a theme, a cursor colour), a
 * module-level signal plus a `storage` listener is the shape to use instead — see
 * `useCanvasCursorColor`.
 */
export function usePersistedState<T>(
  options: PersistedStateOptions<T>,
): PersistedState<T> {
  // Via a const so the narrowing survives into the closure: read straight off
  // `options` inside one and the property widens back to the union.
  const keyOption = options.key;
  const key: Accessor<string | null> =
    typeof keyOption === "function" ? keyOption : () => keyOption;
  const [value, setValue] = createSignal<T>(options.fallback);
  // Boxed so a pending value is distinguishable from having nothing to restore,
  // whatever `T` is. A *stored* `null` still reads as nothing stored: JSON `null`
  // and an absent entry are the same on the way back in.
  const [pending, setPending] = createSignal<{ value: T } | null>(null);
  const [mounted, setMounted] = createSignal(false);

  onMount(() => setMounted(true));

  function arm(storageKey: string) {
    const stored = readStored<T>(storageKey, options);
    setPending(stored === null ? null : { value: stored });
  }

  // `undefined` until the first arming, which `null` is a legitimate outcome of.
  let armedKey: string | null | undefined;

  createEffect(() => {
    if (!mounted()) return;
    const storageKey = key();
    if (storageKey === armedKey) return;

    // A key that moved names a different entity, so the previous value must not
    // carry over into it while the new one is being read.
    if (armedKey !== undefined) {
      options.onAdopt?.(options.fallback);
      setValue(() => options.fallback);
    }
    armedKey = storageKey;
    if (storageKey === null) setPending(null);
    else arm(storageKey);
  });

  createEffect(() => {
    const candidate = pending();
    if (!candidate) return;
    if (options.canApply && !options.canApply(candidate.value)) return;

    setPending(null);
    options.onAdopt?.(candidate.value);
    setValue(() => candidate.value);
  });

  return {
    value,

    commit(next: T) {
      // A choice the user made outranks one they made previously, even if the
      // data that would have made the stored one valid is still loading.
      setPending(null);
      setValue(() => next);
      const storageKey = key();
      if (storageKey !== null) writeStored(storageKey, next, options);
    },

    set(next: T) {
      setValue(() => next);
    },

    restore() {
      const storageKey = key();
      if (storageKey !== null) arm(storageKey);
    },
  };
}
