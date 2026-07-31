import { render } from "solid-js/web";
import { describe, expect, it } from "vitest";
import addIcon from "#assets/icons/add.svg?raw";
import { Button } from "#components/Button.tsx";
import { formatFileSize } from "#utils/utils.ts";

/**
 * Proves the toolchain, not the components: a `.tsx` component compiles
 * through vite-plugin-solid and mounts under happy-dom, `#` subpath aliases
 * resolve, and Vite's `?raw` asset query works.
 */
describe("frontend toolchain", () => {
  it("mounts a Solid component and renders its DOM", () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(() => <Button text="Save" variant="secondary" />, host);

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
