import { createEffect, createMemo } from "solid-js";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useIsDesktop } from "#composeables/useIsDesktop.ts";
import { setDockInsets } from "#utils/insets.ts";

const RIGHT_DOCK_MARGIN = 6;

export function DockedWindowLayout() {
  const { leftWindows, rightWindows } = useDockedWindows();
  const isDesktop = useIsDesktop();

  // Docked panels reserve edge space through the inset system (not flex
  // placeholders): the totals here flow into `--inset-left`/`--inset-right`, and
  // content + panels both offset from the same numbers. On mobile the panels
  // render as overlay drawers instead of reserving space, so the insets are 0.
  const leftDock = createMemo(() =>
    isDesktop() ? leftWindows().reduce((sum, w) => sum + w.width, 0) : 0,
  );
  const rightDock = createMemo(() =>
    isDesktop() && rightWindows().length > 0
      ? rightWindows().reduce((sum, w) => sum + w.width, 0) + RIGHT_DOCK_MARGIN
      : 0,
  );

  // `createEffect` rather than `on(...)`: the Vue watch was `{ immediate: true }`,
  // so the insets have to be written on the first run too.
  createEffect(() => setDockInsets(leftDock(), rightDock()));

  return <div class="hidden" aria-hidden="true" />;
}
