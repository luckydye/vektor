import { For, Match, Show, Switch } from "solid-js";
import { PEN_COLORS } from "#canvas/extensions/drawTool.ts";
import type { CanvasToolProperty } from "#canvas/runtime/extensionApi.ts";
import { type CanvasChrome, swallowPointer } from "#canvas/ui/Canvas.tsx";
import { Icon } from "#components/Icon.tsx";
import { t } from "#utils/lang.ts";

/**
 * What the active tool will draw with.
 *
 * Rendered from the tool's declared `properties` rather than from a branch per
 * tool, so a new tool gets a properties bar by declaring one — the chrome never
 * learns its name. Only the control *kinds* live here.
 *
 * Solid rather than lit for the same reason as the toolbar: it is buttons bound
 * to commands, and it changes when the reader picks something, not when the
 * canvas paints.
 */
export function CanvasToolProperties(props: { chrome: CanvasChrome }) {
  // `chrome` is one object built in Canvas.tsx and never replaced, so reading it
  // once at setup is the same as reading it per use.
  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object

  const visible = frame(() => view()?.hasToolProperties() ?? false);
  const properties = frame(() => view()?.activeToolProperties() ?? []);
  const palettes = frame(() => view()?.activeToolColorPalettes() ?? []);
  const activeColors = frame(() => view()?.state.activeColors ?? {});
  // Pen colour is shared engine state, not a tool property: the shape tool
  // stamps in the same colour. Shown for any tool that paints ink.
  const inkTool = frame(() => view()?.state.activeTool === "draw");
  const penColor = frame(() => view()?.state.penColor);
  const currentValue = (property: CanvasToolProperty) =>
    view()?.toolPropertyValue(property.id);

  return (
    <Show when={visible()}>
      <div class="canvas-properties-bar">
        <div
          class="canvas-tool-properties"
          role="toolbar"
          aria-label={t("Tool properties")}
          onPointerDown={swallowPointer}
        >
          <For each={properties()}>
            {(property) => (
              <>
                <Switch>
                  <Match when={property.kind === "choice" && property}>
                    {(choice) => (
                      <span class="canvas-draw-modes">
                        <For each={choice().options}>
                          {(option) => (
                            <button
                              type="button"
                              classList={{
                                "canvas-draw-mode": true,
                                active: currentValue(property) === option.id,
                              }}
                              aria-label={t(option.label)}
                              aria-pressed={currentValue(property) === option.id}
                              title={t(option.label)}
                              onClick={() =>
                                run((canvas) =>
                                  canvas.setToolProperty(property.id, option.id),
                                )
                              }
                            >
                              <Icon class="canvas-draw-mode-icon" svg={option.icon} />
                            </button>
                          )}
                        </For>
                      </span>
                    )}
                  </Match>

                  <Match when={property.kind === "size" && property}>
                    {(size) => (
                      <span class="canvas-tool-sizes">
                        <For each={size().options}>
                          {(option) => (
                            <button
                              type="button"
                              classList={{
                                "canvas-tool-size": true,
                                active: currentValue(property) === option,
                              }}
                              aria-label={`${t(size().label)} ${option}`}
                              aria-pressed={currentValue(property) === option}
                              title={`${t(size().label)} ${option}`}
                              onClick={() =>
                                run((canvas) =>
                                  canvas.setToolProperty(property.id, option),
                                )
                              }
                            >
                              {/* The dot shows the true relative width, clamped
                                  so the largest stop still fits the button. */}
                              <span
                                class="canvas-tool-size-dot"
                                style={{
                                  width: `${Math.min(18, 4 + option / 2)}px`,
                                  height: `${Math.min(18, 4 + option / 2)}px`,
                                }}
                              />
                            </button>
                          )}
                        </For>
                      </span>
                    )}
                  </Match>

                  <Match when={property.kind === "swatches" && property}>
                    {(swatches) => (
                      <span class="canvas-note-colors">
                        <For each={swatches().options}>
                          {(color) => (
                            <button
                              type="button"
                              classList={{
                                "canvas-color-swatch": true,
                                active: currentValue(property) === color,
                              }}
                              style={{ background: color }}
                              aria-label={`${t(swatches().label)} ${color}`}
                              onClick={() =>
                                run((canvas) =>
                                  canvas.setToolProperty(property.id, color),
                                )
                              }
                            />
                          )}
                        </For>
                      </span>
                    )}
                  </Match>
                </Switch>
                <span class="canvas-divider" />
              </>
            )}
          </For>

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

          <Show when={inkTool()}>
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
