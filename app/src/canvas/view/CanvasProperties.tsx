import { For, Show } from "solid-js";
import { PEN_COLORS } from "#canvas/extensions/drawing.ts";
import { t } from "#utils/lang.ts";
import { type CanvasChrome, swallowPointer } from "./chrome.ts";

/**
 * Appearance of what is currently selected.
 *
 * Only present while the selection has something to configure. Reads the
 * selection rather than the tool, which is the one difference from
 * `CanvasToolProperties`.
 */
export function CanvasProperties(props: { chrome: CanvasChrome }) {
  // `chrome` is one object built in Canvas.tsx and never replaced, so reading it
  // once at setup is the same as reading it per use.
  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object

  const visible = frame(() => view()?.hasSelectedElementProperties() ?? false);
  const shapePalette = frame(() => view()?.selectedShapeColorPalette());
  const selectedColor = frame(() => view()?.selectedShape()?.style.color);
  const strokeColor = frame(() => view()?.selectedStrokeColor());
  const hasStrokes = frame(() => (view()?.state.selectedStrokeIds.size ?? 0) > 0);

  return (
    <Show when={visible()}>
      <aside
        class="canvas-properties-sidebar"
        aria-label={t("Appearance")}
        onPointerDown={swallowPointer}
      >
        <h2 class="canvas-properties-sidebar-title">{t("Appearance")}</h2>

        <Show when={shapePalette()}>
          {(palette) => (
            <section
              class="canvas-property-section"
              aria-label={`${t(palette().label)} color`}
            >
              <span class="canvas-property-label">{t("Color")}</span>
              <div class="canvas-property-colors">
                <For each={palette().palette}>
                  {(color) => (
                    <button
                      type="button"
                      classList={{
                        "canvas-color-swatch": true,
                        active: selectedColor() === color,
                      }}
                      style={{ background: color }}
                      aria-label={`${t(palette().label)} color ${color}`}
                      onClick={() =>
                        run((canvas) =>
                          canvas.setSelectedElementColor(palette().type, color),
                        )
                      }
                    />
                  )}
                </For>
              </div>
            </section>
          )}
        </Show>

        <Show when={hasStrokes()}>
          <section class="canvas-property-section" aria-label={t("Pen color")}>
            <span class="canvas-property-label">{t("Color")}</span>
            <div class="canvas-property-colors">
              <For each={PEN_COLORS}>
                {(color) => (
                  <button
                    type="button"
                    classList={{
                      "canvas-color-swatch": true,
                      active: strokeColor() === color,
                    }}
                    style={{ background: color }}
                    aria-label={`${t("Set pen color")} ${color}`}
                    onClick={() => run((canvas) => canvas.setSelectedStrokeColor(color))}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>
      </aside>
    </Show>
  );
}
