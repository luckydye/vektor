import { describe, expect, it } from "bun:test";
import {
  createDocumentLinkShape,
  DOCUMENT_LINK_MIME,
  documentReferenceKey,
  droppedDocumentReference,
} from "#canvas/extensions/documentLink.ts";
import {
  canvasFilesFromDataTransfer,
  createFileShape,
  isPdfFile,
} from "#canvas/extensions/files.ts";
import { mediaFilesFromDataTransfer } from "#canvas/extensions/media.ts";
import { createVektorDocumentAddress } from "#utils/documentAddress.ts";

function transferWithFileAndItem(file: File): DataTransfer {
  return {
    files: [file],
    items: [
      {
        kind: "file",
        getAsFile() {
          throw new Error("items should not be read when files are available");
        },
      },
    ],
  } as unknown as DataTransfer;
}

function transferWithDocumentLink(data: Record<string, unknown>): DataTransfer {
  return {
    getData(type: string) {
      if (type === DOCUMENT_LINK_MIME) return JSON.stringify(data);
      return "";
    },
  } as unknown as DataTransfer;
}

describe("canvas data transfer helpers", () => {
  it("does not collect pasted media from both files and items", () => {
    const file = new File(["image"], "image.png", { type: "image/png" });

    expect(mediaFilesFromDataTransfer(transferWithFileAndItem(file))).toEqual([file]);
  });

  it("does not collect pasted attachments from both files and items", () => {
    const file = new File(["doc"], "notes.pdf", { type: "application/pdf" });

    expect(canvasFilesFromDataTransfer(transferWithFileAndItem(file))).toEqual([file]);
  });

  it("uses a larger native-viewer frame for PDFs", () => {
    const shape = createFileShape({
      at: { x: 500, y: 500 },
      src: "/api/v1/spaces/space-1/uploads/report.PDF?download=0",
      filename: "report.PDF",
    });

    expect(isPdfFile(shape.data.src as string)).toBe(true);
    expect(shape.frame.width).toBe(420);
    expect(shape.frame.height).toBe(560);
    expect(shape.frame.x).toBe(290);
    expect(shape.frame.y).toBe(220);
  });

  it("preserves target space metadata for dragged document links", () => {
    const address = createVektorDocumentAddress({
      origin: "https://example.com",
      spaceId: "space-other",
      documentId: "doc-target",
      href: "https://example.com/other/doc/page",
    });

    expect(
      droppedDocumentReference(
        transferWithDocumentLink({
          address,
        }),
      ),
    ).toEqual({
      address,
    });
  });

  it("stores target space and source URL on document canvas shapes", () => {
    const address = createVektorDocumentAddress({
      origin: "https://example.com",
      spaceId: "space-other",
      documentId: "doc-target",
      href: "https://example.com/other/doc/page",
    });
    const shape = createDocumentLinkShape(
      {
        address,
      },
      { x: 200, y: 200 },
    );

    expect(shape?.data.docAddress).toBe(address);
    expect(shape?.data.src).toBe("https://example.com/other/doc/page");
  });

  it("keys document references by remote origin", () => {
    expect(
      documentReferenceKey({
        address: createVektorDocumentAddress({
          origin: "https://one.example.com",
          spaceId: "space-target",
          documentId: "doc-target",
          href: "https://one.example.com/space/doc/page",
        }),
      }),
    ).not.toBe(
      documentReferenceKey({
        address: createVektorDocumentAddress({
          origin: "https://two.example.com",
          spaceId: "space-target",
          documentId: "doc-target",
          href: "https://two.example.com/space/doc/page",
        }),
      }),
    );
  });
});
