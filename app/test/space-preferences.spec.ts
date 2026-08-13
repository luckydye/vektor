import { describe, expect, it } from "vitest";
import { validateSpacePreferences } from "#utils/spacePreferences.ts";

/** The validated preferences, or a failure if the input was refused. */
function validated(preferences: unknown): Record<string, string> {
  const result = validateSpacePreferences(preferences);
  if ("error" in result) throw new Error(`unexpectedly refused: ${result.error}`);
  if (!result.preferences) throw new Error("unexpectedly stored nothing");
  return result.preferences;
}

/** The reason the input was refused, or a failure if it was accepted. */
function refused(preferences: unknown): string {
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

  it("leaves the stored preferences alone for a write that omits them", () => {
    const result = validateSpacePreferences(undefined);

    expect(result).toEqual({ preferences: undefined });
  });

  it("refuses a value that is not an object of preferences", () => {
    expect(refused(["brandColor"])).toContain("must be an object");
    expect(refused("brandColor=#fff")).toContain("must be an object");
    expect(refused(null)).toContain("must be an object");
  });

  it("refuses preferences too large to ship with every space response", () => {
    expect(refused({ description: "x".repeat(600 * 1024) })).toContain("512 KB");
  });

  it("stores a key it has no rule for as the text it is", () => {
    // The store is open: anything may keep its own settings here, and a key the
    // app does not render is not the app's business to validate.
    expect(
      validated({
        "acme-extension:layout": "grid",
        featureFlags: '{"beta":true}',
        "notes.pinned": "doc_1",
      }),
    ).toEqual({
      "acme-extension:layout": "grid",
      featureFlags: '{"beta":true}',
      "notes.pinned": "doc_1",
    });
  });

  it("refuses a key that names something other than a preference", () => {
    // An own `__proto__` property, which only a parsed body can carry: assigning
    // it while rebuilding the map writes a prototype, not an entry.
    expect(refused(JSON.parse('{"__proto__":"x"}'))).toContain("not a usable");
    expect(refused({ constructor: "x" })).toContain("not a usable");
    expect(refused({ "has space": "x" })).toContain("not a usable");
    expect(refused({ "<script>": "x" })).toContain("not a usable");
    expect(refused({ [`${"k".repeat(65)}`]: "x" })).toContain("not a usable");
  });

  it("refuses a key another write path validates more strictly", () => {
    // `ai:baseUrl` is fetched by the server and checked against the SSRF policy
    // where it is set, which this path cannot do.
    expect(refused({ "ai:baseUrl": "http://169.254.169.254" })).toContain(
      "its own settings endpoint",
    );
    expect(refused({ "ai:provider": "ollama" })).toContain("its own settings endpoint");
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
