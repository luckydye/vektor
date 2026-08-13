import { describe, expect, it } from "vitest";
import { validateSpacePreferences } from "#utils/spacePreferences.ts";

/** The validated preferences, or a failure if the input was refused. */
function validated(preferences: Record<string, unknown>): Record<string, string> {
  const result = validateSpacePreferences(preferences);
  if ("error" in result) throw new Error(`unexpectedly refused: ${result.error}`);
  return result.preferences;
}

/** The reason the input was refused, or a failure if it was accepted. */
function refused(preferences: Record<string, unknown>): string {
  const result = validateSpacePreferences(preferences);
  if (!("error" in result)) {
    throw new Error(`unexpectedly accepted: ${JSON.stringify(result.preferences)}`);
  }
  return result.error;
}

describe("validateSpacePreferences", () => {
  it("accepts the preferences the space settings write", () => {
    expect(
      validated({
        brandColor: "#1e293b",
        description: "A space",
        logoSvg:
          '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>',
        pinnedDocumentId: "document_abc123",
        workflowCreationEnabled: "false",
      }),
    ).toMatchObject({
      brandColor: "#1e293b",
      description: "A space",
      pinnedDocumentId: "document_abc123",
      workflowCreationEnabled: "false",
    });
  });

  it("refuses a key that is not a space preference", () => {
    expect(refused({ "ai:baseUrl": "http://evil.example" })).toContain(
      "not a space preference set here",
    );
    // An own `__proto__` property, which only a parsed body can carry: a lookup
    // in an object literal would answer it with `Object.prototype`.
    expect(refused(JSON.parse('{"__proto__":"x"}'))).toContain(
      "not a space preference set here",
    );
  });

  it("refuses a brandColor that is not a hex color", () => {
    // The sink is a CSS `background`, which resolves `url()`.
    expect(refused({ brandColor: "url(/CSS_INJECT_MARKER.png)" })).toContain("hex color");
    expect(refused({ brandColor: "red" })).toContain("hex color");
    expect(validated({ brandColor: "#ff5733" }).brandColor).toBe("#ff5733");
  });

  it("stores logoSvg sanitized", () => {
    const stored = validated({
      logoSvg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><image href="x" onerror="window.__xss_fired=1" /></svg>',
    }).logoSvg;

    expect(stored).not.toContain("onerror");
    expect(stored).toContain("<svg");
  });

  it("refuses a logoSvg that is neither an SVG document nor an image URL", () => {
    expect(refused({ logoSvg: "<img src=x onerror=alert(1)>" })).toContain("logoSvg");
    expect(refused({ logoSvg: "javascript:alert(1)" })).toContain("logoSvg");
    expect(validated({ logoSvg: "https://example.com/logo.png" }).logoSvg).toBe(
      "https://example.com/logo.png",
    );
  });

  it("accepts an empty value, which is how a preference is cleared", () => {
    expect(validated({ pinnedDocumentId: "", brandColor: "" })).toEqual({
      pinnedDocumentId: "",
      brandColor: "",
    });
  });

  it("refuses a non-string value and an out-of-range flag", () => {
    expect(refused({ brandColor: 1 })).toContain("must be a string");
    expect(refused({ workflowCreationEnabled: "yes" })).toContain(
      "must be 'true' or 'false'",
    );
  });
});
