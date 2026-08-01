import { For, Show } from "solid-js";
import { DRAW_STROKE_MODES, PEN_COLORS } from "#canvas/extensions/drawing.ts";
import { t } from "#utils/lang.ts";
import type { CanvasChrome } from "./chrome.ts";

/**
 * What the active tool will draw with — pen mode and colours.
 *
 * Sits above the toolbar and only exists while a tool has something to
 * configure. Solid rather than lit for the same reason as the toolbar: it is
 * buttons bound to commands, and it changes when the reader picks something,
 * not when the canvas paints.
 */
export function CanvasToolProperties(props: { chrome: CanvasChrome }) {
  // `chrome` is one object built in Canvas.tsx and never replaced, so reading it
  // once at setup is the same as reading it per use.
  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object

  const visible = frame(() => view()?.hasToolProperties() ?? false);
  const drawing = frame(() => view()?.state.activeTool === "draw");
  const palettes = frame(() => view()?.activeToolColorPalettes() ?? []);
  const drawMode = frame(() => view()?.activeDrawStrokeMode);
  const penColor = frame(() => view()?.state.penColor);
  const activeColors = frame(() => view()?.state.activeColors ?? {});

  // Chrome sits above the viewport, which starts a drag on pointerdown.
  const swallowPointer = (event: PointerEvent) => event.stopPropagation();

  return (
    <Show when={visible()}>
      <div class="canvas-properties-bar">
        <div
          class="canvas-tool-properties"
          role="toolbar"
          aria-label={t("Tool properties")}
          onPointerDown={swallowPointer}
        >
          <Show when={drawing()}>
            <span class="canvas-draw-modes">
              <For each={DRAW_STROKE_MODES}>
                {(mode) => (
                  <button
                    type="button"
                    classList={{
                      "canvas-draw-mode": true,
                      active: drawMode() === mode.id,
                    }}
                    aria-label={t(mode.label)}
                    aria-pressed={drawMode() === mode.id}
                    title={t(mode.label)}
                    onClick={() =>
                      run((canvas) => canvas.setActiveDrawStrokeMode(mode.id))
                    }
                  >
                    <div
                      class="svg-icon canvas-draw-mode-icon"
                      aria-hidden="true"
                      innerHTML={mode.icon}
                    />
                  </button>
                )}
              </For>
            </span>
            <span class="canvas-divider" />
          </Show>

          <For each={palettes()}>
            {(palette) => (
              <span class="canvas-note-colors">
                <For each={palette.palette}>
                  {(color) => (
                    <button
                      type="button"
                      classList={{
                        "canvas-color-swatch": true,
                        active: activeColors()[palette.type] === color,
                      }}
                      style={{ background: color }}
                      aria-label={`${t(palette.label)} color ${color}`}
                      onClick={() =>
                        run((canvas) => canvas.setActiveElementColor(palette.type, color))
                      }
                    />
                  )}
                </For>
              </span>
            )}
          </For>

          <Show when={drawing() && palettes().length > 0}>
            <span class="canvas-divider" />
          </Show>

          <Show when={drawing()}>
            <span class="canvas-note-colors">
              <For each={PEN_COLORS}>
                {(color) => (
                  <button
                    type="button"
                    classList={{
                      "canvas-color-swatch": true,
                      active: penColor() === color,
                    }}
                    style={{ background: color }}
                    aria-label={`${t("Set pen color")} ${color}`}
                    onClick={() => run((canvas) => canvas.setActivePenColor(color))}
                  />
                )}
              </For>
            </span>
          </Show>
        </div>
      </div>
    </Show>
  );
}
