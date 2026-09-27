import { beforeEach, describe, expect, it } from "vitest";
import {
  readStored,
  removeStored,
  subscribeStored,
  writeStored,
} from "#utils/clientStorage.ts";

/**
 * The point of this module is that nothing it does can throw. `localStorage` is
 * not merely absent on the server: Safari throws on the property itself when the
 * user blocks storage, and `setItem` throws on a full or read-only store. A
 * remembered preference is never worth a crash, so every failure reads as "not
 * stored".
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * Break one storage method for the duration of `run`.
 *
 * Restored in a `finally` rather than through `vi.spyOn` + `restoreMocks`, which
 * did not survive across `describe` blocks here and leaked a throwing `getItem`
 * into later tests.
 */
function withBrokenStorage<T>(
  method: "getItem" | "setItem" | "removeItem",
  run: () => T,
): T {
  const original = localStorage[method];
  localStorage[method] = () => {
    throw new Error("SecurityError");
  };
  try {
    return run();
  } finally {
    localStorage[method] = original;
  }
}

describe("readStored", () => {
  it("round-trips JSON by default", () => {
    writeStored("k", { a: [1, 2] });

    expect(localStorage.getItem("k")).toBe('{"a":[1,2]}');
    expect(readStored<{ a: number[] }>("k")).toEqual({ a: [1, 2] });
  });

  it("reads an absent key as null", () => {
    expect(readStored("missing")).toBeNull();
  });

  it("reads an unparseable entry as null", () => {
    localStorage.setItem("k", "{not json");

    expect(readStored("k")).toBeNull();
  });

  it("treats a codec that returns null as a rejection", () => {
    localStorage.setItem("k", "maybe");

    const evens = { parse: (raw: string) => (raw === "even" ? raw : null) };
    expect(readStored("k", evens)).toBeNull();

    localStorage.setItem("k", "even");
    expect(readStored("k", evens)).toBe("even");
  });

  it("reads a value a codec throws on as null", () => {
    localStorage.setItem("k", "boom");

    expect(
      readStored("k", {
        parse: () => {
          throw new Error("nope");
        },
      }),
    ).toBeNull();
  });

  it("survives storage access that throws outright", () => {
    withBrokenStorage("getItem", () => {
      expect(readStored("k")).toBeNull();
    });
  });
});

describe("writeStored", () => {
  it("honours a plain-text codec, so existing entries stay readable", () => {
    const text = {
      parse: (raw: string) => raw,
      serialize: (value: string) => value,
    };
    writeStored("k", "#3b82f6", text);

    // Unquoted: a key whose format predates JSON must not start being quoted.
    expect(localStorage.getItem("k")).toBe("#3b82f6");
    expect(readStored("k", text)).toBe("#3b82f6");
  });

  it("swallows a store that refuses the write", () => {
    withBrokenStorage("setItem", () => {
      expect(() => writeStored("k", "value")).not.toThrow();
    });
  });

  it("swallows a value that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writeStored("k", circular)).not.toThrow();
    expect(readStored("k")).toBeNull();
  });
});

describe("removeStored", () => {
  it("removes an entry and survives a store that throws", () => {
    writeStored("k", "value");
    removeStored("k");
    expect(readStored("k")).toBeNull();

    withBrokenStorage("removeItem", () => {
      expect(() => removeStored("k")).not.toThrow();
    });
  });
});

describe("storage area", () => {
  it("keeps session entries out of local storage and vice versa", () => {
    writeStored("k", "tab-only", { area: "session" });

    expect(sessionStorage.getItem("k")).toBe('"tab-only"');
    expect(localStorage.getItem("k")).toBeNull();
    expect(readStored("k", { area: "session" })).toBe("tab-only");
    // Same key, different store: the local read must not see it.
    expect(readStored("k")).toBeNull();
  });

  it("removes from the area it is told to", () => {
    writeStored("k", "local");
    writeStored("k", "session", { area: "session" });

    removeStored("k", "session");
    expect(readStored("k", { area: "session" })).toBeNull();
    expect(readStored("k")).toBe("local");
  });
});

describe("subscribeStored", () => {
  it("fires only for its own key, and stops when unsubscribed", () => {
    let calls = 0;
    const unsubscribe = subscribeStored("watched", () => calls++);

    window.dispatchEvent(new StorageEvent("storage", { key: "watched" }));
    expect(calls).toBe(1);

    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(calls).toBe(1);

    unsubscribe();
    window.dispatchEvent(new StorageEvent("storage", { key: "watched" }));
    expect(calls).toBe(1);
  });
});
