import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsLayout } from "#components/SettingsLayout.tsx";

/**
 * `a-tabs` selects its first tab in `connectedCallback` and deselects the
 * previous one by querying `a-tabs-tab[selected]` — an attribute, which Lit
 * only reflects on its next update. Selecting a different tab imperatively
 * right after mount therefore hit an element whose attribute was not written
 * yet, left the first tab selected, and rendered two panels at once. Deep-links
 * like `/settings#integrations` showed the first tab's content on reload.
 */

const tabs = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "archive", label: "Archive" },
] as const;

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;

function mount(initialTab?: string) {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <SettingsLayout
        tabs={tabs}
        initialTab={initialTab}
        panels={{
          general: () => <p>general panel</p>,
          integrations: () => <p>integrations panel</p>,
          archive: () => <p>archive panel</p>,
        }}
      />
    ),
    host,
  );
  return host;
}

function selectedTabs(root: HTMLElement) {
  return [...root.querySelectorAll("a-tabs-tab[selected]")].map((tab) =>
    tab.textContent?.trim(),
  );
}

function selectedPanels(root: HTMLElement) {
  return [...root.querySelectorAll("a-tabs-panel[selected]")].map((panel) =>
    panel.textContent?.trim(),
  );
}

/** Past the `whenDefined` await, the render it triggers and Lit's reflection. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe("SettingsLayout initial tab", () => {
  it("selects only the tab the deep link asks for", async () => {
    const root = mount("integrations");
    await settle();

    expect(selectedTabs(root)).toEqual(["Integrations"]);
    expect(selectedPanels(root)).toEqual(["integrations panel"]);
  });

  it("falls back to the first tab without an initial tab", async () => {
    const root = mount();
    await settle();

    expect(selectedTabs(root)).toEqual(["General"]);
    expect(selectedPanels(root)).toEqual(["general panel"]);
  });

  it("falls back to the first tab for an unknown id", async () => {
    const root = mount("nope");
    await settle();

    expect(selectedTabs(root)).toEqual(["General"]);
    expect(selectedPanels(root)).toEqual(["general panel"]);
  });
});
