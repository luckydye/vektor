import { describe, expect, it } from "vitest";
import { createApp, h } from "vue";
import addIcon from "#assets/icons/add.svg?raw";
import Button from "#components/Button.vue";
import { formatFileSize } from "#utils/utils.ts";

/**
 * Proves the toolchain, not the components: a real `.vue` SFC compiles and
 * mounts under happy-dom, `#` subpath aliases resolve, and Vite's `?raw` asset
 * query works. The component specs themselves are separate tickets.
 */
describe("frontend toolchain", () => {
  it("mounts a Vue SFC and renders its DOM", () => {
    const host = document.createElement("div");
    document.body.append(host);
    createApp(h(Button, { text: "Save", variant: "secondary" })).mount(host);

    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent?.trim()).toBe("Save");
    expect(button?.className).toContain("button-secondary");
    expect(button?.getAttribute("type")).toBe("button");
  });

  it("resolves a # subpath alias into src", () => {
    expect(formatFileSize(2048)).toBe("2.0 KB");
  });

  it("resolves Vite's ?raw asset query", () => {
    expect(addIcon).toContain("<svg");
  });
});
