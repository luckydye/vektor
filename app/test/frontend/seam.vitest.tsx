/** @jsxImportSource solid-js */
import { createSignal } from "solid-js";
import { render as solidRender } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { component } from "./registry.ts";
import { cleanupAll, type RenderResult, render } from "./render.ts";

afterEach(cleanupAll);

/**
 * Proves the adapter's interface is actually framework-agnostic *before* the
 * port depends on it — a Solid component driven through the same
 * `{ container, update, cleanup }` shape the Vue branch returns.
 *
 * This is a throwaway stand-in for the real Solid branch, which lands in phase
 * 3. Its value is now: if the shape cannot express Solid, better to find out
 * while there are six specs than sixty.
 */
function solidAdapter(props: Record<string, unknown>): RenderResult {
  const container = document.createElement("div");
  document.body.append(container);
  const [state, setState] = createSignal(props);
  const dispose = solidRender(
    () => <button type="button">{String(state().text ?? "")}</button>,
    container,
  );
  return {
    container,
    async update(next) {
      setState((prev) => ({ ...prev, ...next }));
    },
    cleanup() {
      dispose();
      container.remove();
    },
  };
}

describe("adapter seam", () => {
  it("the Vue branch and a Solid branch satisfy the same interface", async () => {
    const cases: RenderResult[] = [
      render(component("Button"), { text: "Before" }),
      solidAdapter({ text: "Before" }),
    ];

    for (const result of cases) {
      expect(result.container.querySelector("button")?.textContent?.trim()).toBe(
        "Before",
      );
      await result.update({ text: "After" });
      expect(result.container.querySelector("button")?.textContent?.trim()).toBe("After");
      result.cleanup();
      expect(document.body.contains(result.container)).toBe(false);
    }
  });
});
