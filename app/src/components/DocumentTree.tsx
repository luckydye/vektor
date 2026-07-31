/**
 * Placeholder — the real tree is 896 lines and lands in phase 5.
 *
 * The plan schedules `DocumentTree` with the home subtree, but `Navigation`
 * imports it, so the shell's dependency closure reaches it a phase early.
 * Stubbing keeps phase 4 to its stated exit — "the app boots on Solid, most
 * routes still blank" — instead of absorbing the view work.
 *
 * Visible text, not an empty node: a blank stub is indistinguishable from a
 * component that failed to render.
 */
export function DocumentTree() {
  return (
    <div class="px-4xs py-3 text-neutral-400 text-size-small" data-placeholder="tree">
      Document tree coming in phase 5.
    </div>
  );
}
