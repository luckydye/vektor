import { describe, expect, it } from "vitest";
import { normalizeRedirectPath } from "#utils/url.ts";

describe("normalizeRedirectPath", () => {
  it.each([
    "//evil.example/path",
    "/\\evil.example/path",
    "/\\/evil.example/path",
    "/\\",
    "///",
    "/\t/evil.example/path",
    "/\n/evil.example/path",
    "/\r/evil.example/path",
    "https://evil.example/path",
  ])("rejects cross-origin redirect %j", (path) => {
    expect(normalizeRedirectPath(path)).toBeNull();
  });

  it.each([
    ["/", "/"],
    [" /settings?tab=integrations#gitlab ", "/settings?tab=integrations#gitlab"],
    ["/documents/../settings", "/settings"],
  ])("normalizes same-origin redirect %j", (path, expected) => {
    expect(normalizeRedirectPath(path)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "settings",
    "https://vektor.invalid/settings",
  ])("rejects non-path redirect %j", (path) => {
    expect(normalizeRedirectPath(path)).toBeNull();
  });
});
