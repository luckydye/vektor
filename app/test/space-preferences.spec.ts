import { describe, expect, it } from "vitest";
import { Permission } from "#acl/permissions.ts";
import {
  parsePreferenceKey,
  preferenceKey,
  preferenceScope,
  requiredPreferenceWriteRole,
  splitPreferencesByScope,
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
        logoSvg: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
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
    expect(refused({ "trailing:": "x" })).toContain("not a usable");
    expect(refused({ [`${"k".repeat(97)}`]: "x" })).toContain("not a usable");
    expect(refused({ [`${"n".repeat(33)}:name`]: "x" })).toContain("not a usable");
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

  it("stores a member's own preference, separators in the name and all", () => {
    // The name half keeps its own structure: one of these addresses a document.
    expect(
      validated({
        "user:sidebar": "collapsed",
        "user:space_muted": "true",
        "user:document_muted:document_abc123": "true",
      }),
    ).toEqual({
      "user:sidebar": "collapsed",
      "user:space_muted": "true",
      "user:document_muted:document_abc123": "true",
    });
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

  it("accepts SVG data URIs and refuses inline SVG markup", () => {
    const dataUri = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(validated({ logoSvg: dataUri }).logoSvg).toBe(dataUri);
    expect(refused({ logoSvg: "<svg></svg>" })).toContain("logoSvg");
  });

  it("refuses a logoSvg that is not an image URL or data URI", () => {
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
    expect(parsePreferenceKey("notes.sort_order")).toEqual({
      namespace: null,
      name: "notes.sort_order",
    });
  });

  it("splits on the first separator, leaving the name its own structure", () => {
    expect(parsePreferenceKey("user:document_muted:document_1")).toEqual({
      namespace: "user",
      name: "document_muted:document_1",
    });
  });

  it("rejects a key that is not one", () => {
    expect(parsePreferenceKey(":name")).toBeNull();
    expect(parsePreferenceKey("namespace:")).toBeNull();
    expect(parsePreferenceKey("")).toBeNull();
    expect(parsePreferenceKey("has space")).toBeNull();
  });
});

describe("preferenceScope", () => {
  it("puts the user namespace in the member's rows and the rest in the space's", () => {
    expect(preferenceScope("user:sidebar")).toBe("user");
    expect(preferenceScope("user:space_muted")).toBe("user");
    expect(preferenceScope("brandColor")).toBe("space");
    expect(preferenceScope("ai:model")).toBe("space");
    expect(preferenceScope("acme:layout")).toBe("space");
  });
});

describe("splitPreferencesByScope", () => {
  it("splits a write into the store each half belongs to", () => {
    expect(
      splitPreferencesByScope({
        brandColor: "#1e293b",
        "user:sidebar": "collapsed",
        "acme:layout": "grid",
      }),
    ).toEqual({
      space: { brandColor: "#1e293b", "acme:layout": "grid" },
      user: { "user:sidebar": "collapsed" },
    });
  });
});

describe("preferenceKey", () => {
  it("is the only place the separator is spelled", () => {
    expect(preferenceKey("user", "space_muted")).toBe("user:space_muted");
    expect(parsePreferenceKey(preferenceKey("ai", "user_profile"))).toEqual({
      namespace: "ai",
      name: "user_profile",
    });
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

  it("lets a member keep their own preferences at viewer", () => {
    expect(requiredPreferenceWriteRole({ "user:sidebar": "collapsed" })).toBe(
      Permission.VIEWER,
    );
    // Mixed with a space-level one, the space-level rule is the one that binds.
    expect(
      requiredPreferenceWriteRole({ "user:sidebar": "collapsed", brandColor: "#fff" }),
    ).toBe(Permission.EDITOR);
  });

  it("leaves an unclaimed namespace, and the rest, to write access", () => {
    expect(requiredPreferenceWriteRole({ brandColor: "#1e293b" })).toBe(
      Permission.EDITOR,
    );
    expect(requiredPreferenceWriteRole({ "acme:layout": "grid" })).toBe(
      Permission.EDITOR,
    );
  });

  it("asks for the weakest role when nothing is being written", () => {
    expect(requiredPreferenceWriteRole(undefined)).toBe(Permission.VIEWER);
    expect(requiredPreferenceWriteRole({})).toBe(Permission.VIEWER);
  });
});
