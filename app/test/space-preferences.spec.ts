import { describe, expect, it } from "vitest";
import { Permission } from "#acl/permissions.ts";
import {
  parsePreferenceKey,
  requiredPreferenceWriteRole,
  validateSpacePreferences,
} from "#utils/spacePreferences.ts";

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

  it("refuses a key that is not spelled like one", () => {
    expect(refused({ "has space": "x" })).toContain("not a usable");
    expect(refused({ "<script>": "x" })).toContain("not a usable");
    expect(refused({ "two:separators:here": "x" })).toContain("not a usable");
    expect(refused({ "trailing:": "x" })).toContain("not a usable");
    expect(refused({ [`${"k".repeat(33)}`]: "x" })).toContain("not a usable");
  });

  it("stores a key the storage layer round-trips, however odd", () => {
    // `getSpace` collects preferences into a `Map` and `Object.fromEntries` them,
    // so `__proto__` is an own property both ways — nothing to protect against.
    // Asserted by property rather than against a literal, since `{__proto__: …}`
    // in source sets a prototype instead of defining a key.
    const stored = validated(JSON.parse('{"__proto__":"x"}'));

    expect(Object.hasOwn(stored, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(stored, "__proto__")?.value).toBe("x");
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
  });

  it("stores a namespaced key for any namespace", () => {
    expect(
      validated({ "acme:layout": "grid", "notes:sort": "created", "ai:model": "llama3" }),
    ).toEqual({ "acme:layout": "grid", "notes:sort": "created", "ai:model": "llama3" });
  });

  it("stores the namespaced keys another settings page also writes", () => {
    expect(validated({ "ai:provider": "ollama", "ai:model": "llama3" })).toEqual({
      "ai:provider": "ollama",
      "ai:model": "llama3",
    });
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

describe("parsePreferenceKey", () => {
  it("splits a namespaced key and leaves a core key unnamespaced", () => {
    expect(parsePreferenceKey("brandColor")).toEqual({
      namespace: null,
      name: "brandColor",
    });
    expect(parsePreferenceKey("ai:baseUrl")).toEqual({
      namespace: "ai",
      name: "baseUrl",
    });
    expect(parsePreferenceKey("email.document_muted")).toEqual({
      namespace: null,
      name: "email.document_muted",
    });
  });

  it("rejects a key that is not one", () => {
    expect(parsePreferenceKey("a:b:c")).toBeNull();
    expect(parsePreferenceKey(":name")).toBeNull();
    expect(parsePreferenceKey("namespace:")).toBeNull();
    expect(parsePreferenceKey("")).toBeNull();
    expect(parsePreferenceKey("has space")).toBeNull();
  });
});

describe("requiredPreferenceWriteRole", () => {
  it("takes the namespace's role for a namespace that decides something space-wide", () => {
    // Whoever sets `ai:baseUrl` picks the host every member's prompts go to, and
    // the AI settings page gates that at OWNER — writing it as a preference must
    // not be the cheaper way in.
    expect(requiredPreferenceWriteRole({ "ai:baseUrl": "http://x" })).toBe(
      Permission.OWNER,
    );
    expect(requiredPreferenceWriteRole({ "ai:provider": "ollama" })).toBe(
      Permission.OWNER,
    );
    expect(requiredPreferenceWriteRole({ workflowCreationEnabled: "false" })).toBe(
      Permission.OWNER,
    );
    // The highest role any one key asks for.
    expect(requiredPreferenceWriteRole({ brandColor: "#fff", "ai:model": "x" })).toBe(
      Permission.OWNER,
    );
  });

  it("leaves an unclaimed namespace, and the rest, to write access", () => {
    expect(requiredPreferenceWriteRole({ brandColor: "#1e293b" })).toBe(
      Permission.EDITOR,
    );
    expect(requiredPreferenceWriteRole({ "acme:layout": "grid" })).toBe(
      Permission.EDITOR,
    );
    expect(requiredPreferenceWriteRole(undefined)).toBe(Permission.EDITOR);
    expect(requiredPreferenceWriteRole({})).toBe(Permission.EDITOR);
  });
});
