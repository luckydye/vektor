import { describe, expect, it } from "vitest";
import { safeJsonParse } from "#utils/json.ts";

describe("safeJsonParse", () => {
  it("keeps prototype-colliding keys as own data", () => {
    const parsed = safeJsonParse(
      '{"__proto__":{"x":1},"constructor":"c","a":1}',
    ) as Record<string, unknown>;

    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed, "constructor")).toBe(true);
    expect(parsed.constructor).toBe("c");
    // Reachable only as own data: there is no chain to walk onto.
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("does not pollute Object.prototype, even for a nested __proto__", () => {
    safeJsonParse('{"a":{"__proto__":{"polluted":"PWNED"}}}');
    safeJsonParse('{"constructor":{"prototype":{"polluted":"PWNED"}}}');

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("leaves arrays and scalars as ordinary values", () => {
    const parsed = safeJsonParse('{"items":[1,{"b":2}],"n":null,"s":"x"}') as Record<
      string,
      unknown
    >;

    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items).toHaveLength(2);
    expect((parsed.items as Record<string, unknown>[])[1]!.b).toBe(2);
    expect(parsed.n).toBeNull();
    expect(parsed.s).toBe("x");
  });

  it("cannot string-coerce a parsed object", () => {
    // Documented consequence of dropping the prototype: no inherited `toString`,
    // so `String(value)` / `${value}` throws instead of giving "[object Object]".
    // Serialize with JSON.stringify, which is unaffected.
    const parsed = safeJsonParse('{"a":{"b":2}}') as Record<string, unknown>;

    expect(() => String(parsed.a)).toThrow();
    expect(JSON.stringify(parsed.a)).toBe('{"b":2}');
  });

  it("round-trips through JSON.stringify unchanged", () => {
    const text = '{"__proto__":{"x":1},"a":[1,2],"b":{"c":"d"}}';
    expect(JSON.stringify(safeJsonParse(text))).toBe(text);
  });

  it("throws on malformed input, like JSON.parse", () => {
    expect(() => safeJsonParse("{oops")).toThrow();
  });
});
