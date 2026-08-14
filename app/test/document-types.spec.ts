import { describe, expect, it } from "vitest";
import { allowsChildDocumentType } from "#documents/types.ts";

describe("document child-type policies", () => {
  it.each(["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"])(
    "treats prototype-key type %s as an unrestricted custom type",
    (parentType) => {
      expect(allowsChildDocumentType(parentType, "document")).toBe(true);
    },
  );

  it("keeps configured child-type policies", () => {
    expect(allowsChildDocumentType("database", "record")).toBe(true);
    expect(allowsChildDocumentType("database", "document")).toBe(false);
    expect(allowsChildDocumentType("workflow-run", "document")).toBe(false);
  });
});
