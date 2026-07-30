/** @jsxImportSource solid-js */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it } from "vitest";

/**
 * The other half of the toolchain claim: Solid JSX compiles and runs in the
 * same Vitest config that just mounted a Vue SFC. Both renderers have to work
 * at once, or the before/after comparison the suite exists for is impossible.
 */
describe("solid toolchain", () => {
  it("renders and reacts", () => {
    const host = document.createElement("div");
    document.body.append(host);

    const [count, setCount] = createSignal(0);
    const dispose = render(() => <button type="button">count:{count()}</button>, host);

    expect(host.textContent).toBe("count:0");
    setCount(2);
    expect(host.textContent).toBe("count:2");
    dispose();
  });
});
