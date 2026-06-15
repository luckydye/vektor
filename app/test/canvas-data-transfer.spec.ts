import { describe, expect, it } from "bun:test";
import { canvasFilesFromDataTransfer } from "../src/canvas/elements/files.ts";
import { mediaFilesFromDataTransfer } from "../src/canvas/elements/media.ts";

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

describe("canvas data transfer helpers", () => {
  it("does not collect pasted media from both files and items", () => {
    const file = new File(["image"], "image.png", { type: "image/png" });

    expect(mediaFilesFromDataTransfer(transferWithFileAndItem(file))).toEqual([file]);
  });

  it("does not collect pasted attachments from both files and items", () => {
    const file = new File(["doc"], "notes.pdf", { type: "application/pdf" });

    expect(canvasFilesFromDataTransfer(transferWithFileAndItem(file))).toEqual([
      file,
    ]);
  });
});
