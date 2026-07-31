/**
 * Placeholder — the real panel is 554 lines and lands in phase 5.
 *
 * Phase 4's exit is "the app boots on Solid, most routes still blank" (plan
 * §Phase 4), and this is one of the two heavy components the shell's dependency
 * closure drags in that the plan schedules for phase 5. Stubbing keeps the
 * phase boundary meaningful: the shell can render and the app can boot without
 * pulling four thousand lines of view code forward.
 *
 * Deliberately not empty — an invisible stub is indistinguishable from a
 * component that silently failed to render.
 */
interface Props {
  onClose?: () => void;
}

export function UserPreferencesPanel(props: Props) {
  return (
    <div class="p-6 text-neutral-500 text-size-small" data-placeholder="preferences">
      <p>Preferences are not available yet on this build.</p>
      <button
        type="button"
        class="mt-3 text-neutral-700 underline"
        onClick={() => props.onClose?.()}
      >
        Close
      </button>
    </div>
  );
}
