import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { PEN_COLORS } from "#canvas/extensions/drawTool.ts";
import {
  type CanvasEditMode,
  type CanvasInspector,
  createInspectorHandle,
  slotDisabled,
} from "#canvas/runtime/plugins.ts";
import { type CanvasChrome, swallowPointer } from "#canvas/ui/Canvas.tsx";
import { Icon } from "#components/Icon.tsx";
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
  const hasAppearance = () =>
    shapePalette() !== undefined || hasStrokes() || elementProperties().length > 0;

  // One tab per panel, like Blender's sidebar. The chosen tab is kept while the
  // selection changes, and falls back to the first one a shape does not offer.
  // Stable objects, so the strip is not rebuilt on every painted frame.
  const appearanceTab = { id: APPEARANCE, title: t("Appearance") };
  const tabs = createMemo((): readonly { id: string; title: string }[] => [
    ...(hasAppearance() ? [appearanceTab] : []),
    ...inspectors(),
  ]);
  const [chosenTab, setChosenTab] = createSignal(APPEARANCE);
  // Clicking the open tab folds the panel down to its tab strip.
  const [collapsed, setCollapsed] = createSignal(false);
  const activeTab = () =>
    tabs().some((tab) => tab.id === chosenTab()) ? chosenTab() : tabs()[0]?.id;
  const activeInspector = () =>
    inspectors().find((inspector) => inspector.id === activeTab());

  return (
    <Show when={visible()}>
      <div class="canvas-properties" onPointerDown={swallowPointer}>
        <Show when={!collapsed()}>
          <aside
            class="canvas-properties-sidebar"
            aria-label={tabs().find((tab) => tab.id === activeTab())?.title}
          >
            <Show when={activeTab() === APPEARANCE}>
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
                          onClick={() =>
                            run((canvas) => canvas.setSelectedStrokeColor(color))
                          }
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
            </Show>

            <Show when={selectedId()} keyed>
              {(shapeId) => (
                <Show when={activeInspector()} keyed>
                  {(inspector) => (
                    <InspectorMount
                      chrome={props.chrome}
                      inspector={inspector}
                      shapeId={shapeId}
                    />
                  )}
                </Show>
              )}
            </Show>
          </aside>
        </Show>

        <Show when={tabs().length > 0}>
          <div class="canvas-properties-tabs" role="tablist" aria-orientation="vertical">
            <For each={tabs()}>
              {(tab) => (
                <button
                  type="button"
                  role="tab"
                  class="canvas-properties-tab"
                  aria-selected={tab.id === activeTab()}
                  aria-expanded={tab.id === activeTab() && !collapsed()}
                  onClick={() => {
                    setCollapsed(tab.id === activeTab() && !collapsed());
                    setChosenTab(tab.id);
                  }}
                >
                  {tab.title}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

const APPEARANCE = "appearance";

/** An extension's panel, in a shadow root so its styles and ours stay apart. */
function InspectorMount(props: {
  chrome: CanvasChrome;
  inspector: CanvasInspector;
  shapeId: string;
}) {
  const t = useTranslation();
  const { view, frame, run } = props.chrome; // solid-reactivity-ok: stable object
  const { inspector, shapeId } = props; // solid-reactivity-ok: keyed by the parent
  const updatedAt = frame(() => view()?.shapeById(shapeId)?.updatedAt);
  const disabled = frame(() => {
    const shape = view()?.shapeById(shapeId);
    return shape ? slotDisabled(shape, inspector.owner) : false;
  });
  let host!: HTMLDivElement;
  let handle: ReturnType<typeof createInspectorHandle> | null = null;
  let editMode: CanvasEditMode | null = null;

  onMount(() => {
    const container = document.createElement("div");
    host.attachShadow({ mode: "open" }).append(container);
    handle = createInspectorHandle({
      owner: inspector.owner,
      shape: () => {
        const shape = view()?.shapeById(shapeId);
        if (!shape) throw new Error(`Inspected shape ${shapeId} is gone`);
        return shape;
      },
      write: (patch) => run((canvas) => canvas.updateShapeData(shapeId, patch)),
      beginEdit: (mode) => {
        editMode = mode;
        return run((canvas) => canvas.beginEditMode(shapeId, mode)) ?? null;
      },
      setSize: (size) => run((canvas) => canvas.resizeShape(shapeId, size)),
    });
    const mounted = handle;
    createEffect(on(updatedAt, () => mounted.notify(), { defer: true }));
    onCleanup(inspector.render(container, mounted));
    // A mode started from this panel ends with it.
    onCleanup(() => {
      const mode = editMode;
      if (mode) run((canvas) => canvas.endEditMode(mode));
    });
  });

  return (
    <section class="canvas-property-section" aria-label={inspector.title}>
      <div class="canvas-property-head">
        <h2 class="canvas-properties-sidebar-title">{inspector.title}</h2>
        <button
          type="button"
          class="canvas-property-eye"
          aria-pressed={!disabled()}
          aria-label={disabled() ? t("Show edits") : t("Hide edits")}
          title={disabled() ? t("Show edits") : t("Hide edits")}
          onClick={() => handle?.update({ disabled: !disabled() })}
        >
          <Icon name={disabled() ? "eye-off" : "eye"} />
        </button>
      </div>
      <div ref={host} />
    </section>
  );
}
