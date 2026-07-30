import { afterEach, describe, expect, it } from "vitest";
import { component, registeredNames } from "./registry.ts";
import { cleanupAll, render } from "./render.ts";

afterEach(cleanupAll);

/**
 * Tests the harness, not the components. If `update()` remounts instead of
 * patching, or the registry stops resolving, every tier 1 spec becomes
 * meaningless in a way that is hard to notice — they would still pass.
 */
describe("render adapter", () => {
  it("mounts into its own container", () => {
    const { container } = render(component("Button"), { text: "One" });
    expect(container.parentElement).toBe(document.body);
    expect(container.querySelector("button")?.textContent?.trim()).toBe("One");
  });

  it("patches on update instead of remounting", async () => {
    const { container, update } = render(component("Button"), { text: "Before" });
    const before = container.querySelector("button");

    await update({ text: "After" });

    const after = container.querySelector("button");
    expect(after?.textContent?.trim()).toBe("After");
    // Same node: a remount would swap it, and any spec asserting on focus or
    // scroll position across an update would silently stop meaning anything.
    expect(after).toBe(before);
  });

  it("merges updates over the original props", async () => {
    const { container, update } = render(component("Button"), {
      text: "Keep",
      variant: "secondary",
    });
    await update({ disabled: true });

    const button = container.querySelector("button");
    expect(button?.textContent?.trim()).toBe("Keep");
    expect(button?.className).toContain("button-secondary");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("removes its container on cleanup", () => {
    const { container, cleanup } = render(component("Button"), { text: "Gone" });
    expect(document.body.contains(container)).toBe(true);
    cleanup();
    expect(document.body.contains(container)).toBe(false);
  });

  it("resolves every registered component", () => {
    for (const name of registeredNames()) {
      expect(component(name), name).toBeTruthy();
    }
  });

  it("throws on an unregistered name", () => {
    // @ts-expect-error deliberately outside the union
    expect(() => component("NotAComponent")).toThrow(/No component registered/);
  });
});
