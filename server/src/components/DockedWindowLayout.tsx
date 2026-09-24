import { createEffect, createMemo } from "solid-js";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useIsDesktop } from "#composeables/useIsDesktop.ts";
import { setDockInsets } from "#utils/insets.ts";

const RIGHT_DOCK_MARGIN = 6;

export function DockedWindowLayout() {
  const { leftWindows, rightWindows } = useDockedWindows();
  const isDesktop = useIsDesktop();

  const leftDock = createMemo(() =>
    isDesktop() ? leftWindows().reduce((sum, w) => sum + w.width, 0) : 0,
  );
  const rightDock = createMemo(() =>
    isDesktop() && rightWindows().length > 0
      ? rightWindows().reduce((sum, w) => sum + w.width, 0) + RIGHT_DOCK_MARGIN
      : 0,
  );

  createEffect(() => setDockInsets(leftDock(), rightDock()));

  return <div class="hidden" aria-hidden="true" />;
}
