type ViewTransition = {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => ViewTransition;
};

/**
 * Run a state change inside a native View Transition.
 *
 * This is what replaces `<TransitionGroup>`'s FLIP move animation. CSS cannot
 * animate an item to a new position — measuring the old one is inherently JS —
 * but `::view-transition-group()` interpolates position and size on the
 * compositor from a snapshot the browser takes before `update` runs. It also
 * removes the `position: absolute` leave hack: snapshots are out of flow by
 * construction, so a removed item can leave the DOM immediately and still
 * animate out.
 *
 * **No fallback by design.** Where the API is missing, or the reader asked for
 * reduced motion, the state simply changes with no animation. Both paths run
 * `update` exactly once, so nothing depends on the transition happening.
 *
 * Callers must give each participating item a unique, valid custom-ident
 * `view-transition-name` — see `viewTransitionName()`. Only one transition runs
 * per document at a time; a second one interrupts the first and its change
 * lands unanimated, which under no-fallback is cosmetic rather than a bug.
 */
/**
 * Resolves when the transition is over, and **always resolves** — a skip is not
 * an error here. Callers use it to know a transition is no longer in flight, so
 * a rejection would leave them thinking one still is, forever.
 */
export async function withViewTransition(
  update: () => void | Promise<void>,
): Promise<void> {
  const doc = document as ViewTransitionDocument;
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!doc.startViewTransition || reducedMotion) {
    await update();
    return;
  }

  const transition = doc.startViewTransition(update);

  // A skipped transition rejects `ready` and `finished`, and only one runs per
  // document — so two lists updating in the same tick guarantees a rejection.
  // Without these the skip surfaces as an unhandled "Transition was skipped"
  // page error. The update itself has already been applied; a skip only costs
  // the animation.
  transition?.ready?.catch(() => {});
  await transition?.finished?.catch(() => {});
}

/**
 * A `view-transition-name` for one item in an animated list.
 *
 * The property takes a custom-ident, so a bare id — numeric, or containing
 * anything CSS would not accept in an identifier — is invalid and silently
 * drops the item from the transition. Names must also be unique for the
 * duration: a duplicate aborts the whole transition, not just the one item.
 * The `prefix` is what keeps two lists on the same page from colliding.
 */
export function viewTransitionName(prefix: string, id: string | number): string {
  // Escaped rather than stripped: replacing every unsafe character with the same
  // one makes `a.b` and `a:b` the same name, and a duplicate aborts the whole
  // transition. `_` is escaped too, so the encoding cannot be forged by an id
  // that already contains an escape sequence.
  const safe = String(id).replace(
    /[^a-zA-Z0-9-]/g,
    (char) => `_${char.codePointAt(0)?.toString(16) ?? "x"}_`,
  );
  return `${prefix}-${safe}`;
}
