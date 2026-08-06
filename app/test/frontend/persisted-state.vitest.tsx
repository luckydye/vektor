import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PersistedState,
  type PersistedStateOptions,
  usePersistedState,
} from "#composeables/usePersistedState.ts";

/**
 * The two behaviours callers depend on and would otherwise reimplement per
 * component: the read happens after mount (islands are server-rendered, so a read
 * during the first render desyncs hydration), and a stored value that names
 * async data waits for `canApply` instead of being discarded before the data
 * lands.
 */

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;
/**
 * What the value was during the initial render pass — the one thing a stored
 * value must not reach, since that pass is what has to match the server's markup.
 * Effects have already flushed by the time `render()` returns, so it cannot be
 * observed afterwards.
 */
let firstRenderValue: unknown;

function mount<T>(options: PersistedStateOptions<T>): () => PersistedState<T> {
  let state: PersistedState<T> | undefined;
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => {
    state = usePersistedState(options);
    firstRenderValue = state.value();
    return <span>{String(state.value())}</span>;
  }, host);

  return () => {
    if (!state) throw new Error("state was not created");
    return state;
  };
}

/** Past `onMount`, the signal writes it makes, and the renders those trigger. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe("usePersistedState", () => {
  it("starts on the fallback when nothing is stored", async () => {
    const state = mount({ key: "k", fallback: "fallback" });
    await settle();

    expect(state().value()).toBe("fallback");
  });

  it("restores a stored value after mount", async () => {
    localStorage.setItem("k", JSON.stringify("stored"));

    const state = mount({ key: "k", fallback: "fallback" });
    await settle();

    expect(state().value()).toBe("stored");
    // Never during the first render: that pass has to reproduce the server's
    // markup, which cannot have known what this browser stored.
    expect(firstRenderValue).toBe("fallback");
  });

  it("persists what commit sets, and not what set sets", async () => {
    const state = mount({ key: "k", fallback: "fallback" });
    await settle();

    state().commit("chosen");
    expect(state().value()).toBe("chosen");
    expect(localStorage.getItem("k")).toBe(JSON.stringify("chosen"));

    state().set("corrected");
    expect(state().value()).toBe("corrected");
    // The stored choice survives a correction, so it returns on the next load.
    expect(localStorage.getItem("k")).toBe(JSON.stringify("chosen"));
  });

  it("holds a stored value back until canApply accepts it", async () => {
    localStorage.setItem("k", JSON.stringify("late"));
    const [loaded, setLoaded] = createSignal(false);

    const state = mount({
      key: "k",
      fallback: "fallback",
      canApply: () => loaded(),
    });
    await settle();
    expect(state().value()).toBe("fallback");

    setLoaded(true);
    await settle();
    expect(state().value()).toBe("late");
  });

  it("lets a user choice win over a still-pending restore", async () => {
    localStorage.setItem("k", JSON.stringify("late"));
    const [loaded, setLoaded] = createSignal(false);

    const state = mount({
      key: "k",
      fallback: "fallback",
      canApply: () => loaded(),
    });
    await settle();

    state().commit("chosen");
    setLoaded(true);
    await settle();

    expect(state().value()).toBe("chosen");
  });

  it("resets and restores when the key moves to another entity", async () => {
    localStorage.setItem("first", JSON.stringify("a"));
    localStorage.setItem("second", JSON.stringify("b"));
    const [key, setKey] = createSignal("first");

    const state = mount({ key, fallback: "fallback" });
    await settle();
    expect(state().value()).toBe("a");

    setKey("second");
    await settle();
    expect(state().value()).toBe("b");
  });

  it("falls back when the new key has nothing stored", async () => {
    localStorage.setItem("first", JSON.stringify("a"));
    const [key, setKey] = createSignal("first");

    const state = mount({ key, fallback: "fallback" });
    await settle();
    expect(state().value()).toBe("a");

    setKey("second");
    await settle();
    expect(state().value()).toBe("fallback");
  });

  it("brings the remembered value back on restore", async () => {
    const state = mount({ key: "k", fallback: "fallback" });
    await settle();

    state().commit("remembered");
    // A temporary override the user did not ask to keep.
    state().set("temporary");
    expect(state().value()).toBe("temporary");

    state().restore();
    await settle();
    expect(state().value()).toBe("remembered");
  });

  it("keeps a session-scoped value out of local storage", async () => {
    const state = mount({ key: "k", fallback: "fallback", area: "session" as const });
    await settle();

    state().commit("tab-only");
    expect(sessionStorage.getItem("k")).toBe('"tab-only"');
    expect(localStorage.getItem("k")).toBeNull();
  });

  it("still works under a null key, without persisting", async () => {
    const [key, setKey] = createSignal<string | null>(null);
    const state = mount({ key, fallback: "fallback" });
    await settle();

    state().commit("chosen");
    expect(state().value()).toBe("chosen");
    expect(localStorage.length).toBe(0);

    // Once it has a key, it starts remembering — and resets off the unkeyed value.
    setKey("k");
    await settle();
    expect(state().value()).toBe("fallback");

    state().commit("kept");
    expect(localStorage.getItem("k")).toBe(JSON.stringify("kept"));
  });

  it("reads an unparseable entry as nothing stored", async () => {
    localStorage.setItem("k", "not json");

    const state = mount({ key: "k", fallback: "fallback" });
    await settle();

    expect(state().value()).toBe("fallback");
  });

  it("reports adopted changes but not committed ones", async () => {
    localStorage.setItem("first", JSON.stringify("a"));
    const [key, setKey] = createSignal("first");
    const adopted: string[] = [];

    const state = mount({
      key,
      fallback: "fallback",
      onAdopt: (value) => adopted.push(value),
    });
    await settle();
    expect(adopted).toEqual(["a"]);

    state().commit("chosen");
    state().set("corrected");
    await settle();
    // Neither is an adoption: the user drove one and the caller drove the other.
    expect(adopted).toEqual(["a"]);

    setKey("second");
    await settle();
    // The reset that clears the previous entity's value is.
    expect(adopted).toEqual(["a", "fallback"]);
  });

  it("round-trips a non-string value through the default codec", async () => {
    const state = mount<{ open: string[] }>({
      key: "k",
      fallback: { open: [] },
    });
    await settle();

    state().commit({ open: ["one", "two"] });
    expect(localStorage.getItem("k")).toBe('{"open":["one","two"]}');

    dispose?.();
    const next = mount<{ open: string[] }>({ key: "k", fallback: { open: [] } });
    await settle();
    expect(next().value()).toEqual({ open: ["one", "two"] });
  });
});
