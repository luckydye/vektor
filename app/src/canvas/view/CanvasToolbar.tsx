import { For } from "solid-js";
import { SHAPE_LIBRARY } from "#canvas/extensions/shape.ts";
import { t } from "#utils/lang.ts";
import "@atrium-ui/elements/popover";
import { Icon } from "#components/Icon.tsx";
import { type CanvasChrome, swallowPointer } from "./chrome.ts";

/**
 * The tool strip along the bottom of the canvas.
 *
 * Rendered by Solid rather than by the canvas's own lit template: it is
 * ordinary chrome — buttons bound to commands — with no world-space geometry
 * and nothing that has to keep up with a drag. What it reads changes on
 * discrete actions, so it re-renders when those change rather than every frame.
 */
export function CanvasToolbar(props: { chrome: CanvasChrome }) {
  // `chrome` is one object built in Canvas.tsx and never replaced, so reading it
  // once at setup is the same as reading it per use.
  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object

  const activeTool = frame(() => view()?.state.activeTool);
  const canUndo = frame(() => view()?.state.canUndo ?? false);
  const canRedo = frame(() => view()?.state.canRedo ?? false);
  const activeShapeId = frame(() => view()?.activeShapeId);
  const tools = frame(() => view()?.tools ?? []);

  return (
    <div class="canvas-toolbar" onPointerDown={swallowPointer}>
      <For each={tools()}>
        {(tool) => (
          <button
            type="button"
            classList={{ "canvas-tool": true, active: activeTool() === tool.id }}
            aria-label={t(tool.label)}
            aria-pressed={activeTool() === tool.id}
            data-tooltip={`${t(tool.label)} · ${tool.shortcut}`}
            onClick={() => run((canvas) => canvas.setActiveTool(tool.id))}
          >
            <Icon class="canvas-tool-icon" svg={tool.icon} />
          </button>
        )}
      </For>

      <a-popover-trigger class="canvas-shape-trigger">
        <button
          slot="trigger"
          type="button"
          classList={{ "canvas-tool": true, active: activeTool() === "shape" }}
          aria-label={t("Shape")}
          aria-pressed={activeTool() === "shape"}
          data-tooltip={`${t("Shape")} · R`}
        >
          <Icon class="canvas-tool-icon" name="shapes-tool" />
        </button>
        <a-popover placements="top">
          <div class="canvas-shape-popover" onPointerDown={swallowPointer}>
            <div class="canvas-shape-popover-panel">
              <For each={SHAPE_LIBRARY}>
                {(item) => (
                  <button
                    type="button"
                    classList={{
                      "canvas-shape-option": true,
                      active: activeTool() === "shape" && activeShapeId() === item.id,
                    }}
                    aria-label={t(item.label)}
                    onClick={() => run((canvas) => canvas.pickShapeLibraryItem(item))}
                  >
                    <Icon class="canvas-shape-option-icon" svg={item.icon} />
                    <span class="canvas-shape-option-label">{t(item.label)}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </a-popover>
      </a-popover-trigger>

      <span class="canvas-divider" />

      <button
        type="button"
        class="canvas-tool"
        aria-label={t("Undo")}
        data-tooltip={`${t("Undo")} · ⌘Z`}
        disabled={!canUndo()}
        onClick={() => run((canvas) => canvas.undo())}
      >
        <Icon class="canvas-tool-icon" name="undo" />
      </button>
      <button
        type="button"
        class="canvas-tool"
        aria-label={t("Redo")}
        data-tooltip={`${t("Redo")} · ⌘⇧Z`}
        disabled={!canRedo()}
        onClick={() => run((canvas) => canvas.redo())}
      >
        <Icon class="canvas-tool-icon" name="redo" />
      </button>

      <span class="canvas-divider" />

      <button
        type="button"
        class="canvas-tool"
        aria-label={t("Fit to view")}
        data-tooltip={`${t("Fit to view")} · F`}
        onClick={() => run((canvas) => canvas.fitView())}
      >
        <Icon class="canvas-tool-icon" name="fit-view-to-elements" />
      </button>
    </div>
  );
}
