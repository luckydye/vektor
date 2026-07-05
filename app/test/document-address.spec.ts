import { describe, expect, it } from "bun:test";
import { remoteDocumentPathParts } from "#api/routes/v1/url-metadata.ts";
import {
  createVektorDocumentAddress,
  parseVektorDocumentAddress,
} from "#utils/documentAddress.ts";

describe("Vektor document addresses", () => {
  it("returns null for malformed percent-encoding", () => {
    expect(
      parseVektorDocumentAddress("vektor+https://example.com/%E0%A4%A/doc"),
    ).toBeNull();
  });

  it("round-trips valid encoded path segments", () => {
    const address = createVektorDocumentAddress({
      origin: "https://example.com",
      spaceId: "space/a",
      documentId: "doc/b",
      href: "https://example.com/space/doc/page",
    });

    expect(parseVektorDocumentAddress(address)).toMatchObject({
      origin: "https://example.com",
      spaceId: "space/a",
      documentId: "doc/b",
      href: "https://example.com/space/doc/page",
    });
  });
});

describe("remoteDocumentPathParts", () => {
  it("returns null for malformed percent-encoding", () => {
    expect(
      remoteDocumentPathParts(new URL("https://example.com/%E0%A4%A/doc/page")),
    ).toBeNull();
    expect(
      remoteDocumentPathParts(new URL("https://example.com/space/doc/%E0%A4%A")),
    ).toBeNull();
  });

  it("decodes valid Vektor document URL paths", () => {
    expect(
      remoteDocumentPathParts(
        new URL("https://example.com/my%20space/doc/folder%2Fpage"),
      ),
    ).toEqual({
      spaceSlug: "my space",
      documentSlug: "folder/page",
    });
  });
});
