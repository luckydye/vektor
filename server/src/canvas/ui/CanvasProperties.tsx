import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import { PEN_COLORS } from "#canvas/extensions/drawTool.ts";
import { type CanvasInspector, createInspectorHandle } from "#canvas/runtime/plugins.ts";
import { type CanvasChrome, swallowPointer } from "#canvas/ui/Canvas.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

export function CanvasProperties(props: { chrome: CanvasChrome }) {
  const t = useTranslation();

  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object

  const visible = frame(() => view()?.hasSelectedElementProperties() ?? false);
  const shapePalette = frame(() => view()?.selectedShapeColorPalette());
  const selectedColor = frame(() => view()?.selectedShape()?.style.color);
  const strokeColor = frame(() => view()?.selectedStrokeColor());
  const hasStrokes = frame(() => view()?.selectedStrokeColor() != null);
  const selectedId = frame(() => view()?.selectedShape()?.id);
  const elementProperties = frame(() => view()?.selectedElementProperties() ?? []);
  const inspectors = frame(() => view()?.selectedInspectors() ?? []);

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
                        "canvas-color-swatch-none": color === "transparent",
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

        <For each={elementProperties()}>
          {(property) => (
            <section class="canvas-property-section">
              <label class="canvas-property-toggle">
                <input
                  type="checkbox"
                  checked={view()?.elementPropertyValue(property)}
                  onChange={(event) => {
                    const id = selectedId();
                    const checked = event.currentTarget.checked;
                    if (id)
                      run((canvas) =>
                        canvas.updateShapeData(id, { [property.id]: checked }),
                      );
                  }}
                />
                <span class="canvas-property-label">{t(property.label)}</span>
              </label>
            </section>
          )}
        </For>

        <Show when={selectedId()} keyed>
          {(shapeId) => (
            <For each={inspectors()}>
              {(inspector) => (
                <InspectorMount
                  chrome={props.chrome}
                  inspector={inspector}
                  shapeId={shapeId}
                />
              )}
            </For>
          )}
        </Show>
      </aside>
    </Show>
  );
}

/** An extension's panel, in a shadow root so its styles and ours stay apart. */
function InspectorMount(props: {
  chrome: CanvasChrome;
  inspector: CanvasInspector;
  shapeId: string;
}) {
  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object
  const { inspector, shapeId } = props; // solid-reactivity-ok: keyed by the parent
  const updatedAt = frame(() => view()?.shapeById(shapeId)?.updatedAt);
  let host!: HTMLDivElement;

  onMount(() => {
    const container = document.createElement("div");
    host.attachShadow({ mode: "open" }).append(container);
    const handle = createInspectorHandle({
      owner: inspector.owner,
      shape: () => {
        const shape = view()?.shapeById(shapeId);
        if (!shape) throw new Error(`Inspected shape ${shapeId} is gone`);
        return shape;
      },
      write: (patch) => run((canvas) => canvas.updateShapeData(shapeId, patch)),
    });
    createEffect(on(updatedAt, () => handle.notify(), { defer: true }));
    onCleanup(inspector.render(container, handle));
  });

  return (
    <section class="canvas-property-section" aria-label={inspector.title}>
      <span class="canvas-property-label">{inspector.title}</span>
      <div ref={host} />
    </section>
  );
}
