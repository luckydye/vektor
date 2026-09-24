/**
 * Parses JSON whose object keys are user-controlled.
 *
 * Every object in the result has no prototype chain, so a key like `__proto__`
 * or `constructor` can only ever be the parsed data's own property — walking or
 * writing such a key cannot reach `Object.prototype` and pollute every object in
 * the process.
 *
 * Not a drop-in `JSON.parse`: the parsed objects inherit nothing, so `String(x)`
 * or `` `${x}` `` throws instead of yielding "[object Object]", and `x.toString()`
 * / `x.hasOwnProperty(k)` are not callable. Use `JSON.stringify` and
 * `Object.hasOwn`, both unaffected. Arrays stay ordinary arrays, and malformed
 * input throws as usual.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.assign(Object.create(null), value)
      : value,
  );
}
