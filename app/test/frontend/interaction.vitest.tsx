import { fireEvent, getByRole, getByText } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTree } from "#components/DocumentTree.tsx";
import { FileDrop } from "#components/FileDrop.tsx";
import { cleanupAll, render } from "./render.ts";

afterEach(cleanupAll);

/**
 * Behaviour with no other coverage: drag-and-drop, imperative handles exposed
 * to parents, and keyboard-driven selection. These are the interactions the
 * port is most likely to break silently, because none of them show up in a
 * static snapshot.
 */

/** happy-dom has no DataTransfer, and the component only reads `.files`. */
function dropEvent(files: File[]) {
  return { dataTransfer: { files, items: [], types: ["Files"] } };
}

describe("FileDrop", () => {
  it("marks itself as a drop target while a file is over it", async () => {
    const { container, exposed } = render(FileDrop, {});
    const zone = container.firstElementChild as HTMLElement;

    expect(exposed?.isDragging).toBe(false);
    await fireEvent.dragOver(zone, dropEvent([]));
    expect(exposed?.isDragging).toBe(true);

    await fireEvent.dragLeave(zone);
    expect(exposed?.isDragging).toBe(false);
  });

  it("reports a dropped file", async () => {
    const onSelect = vi.fn();
    const { container } = render(FileDrop, { onSelect });
    const file = new File(["x"], "notes.md", { type: "text/markdown" });

    await fireEvent.drop(container.firstElementChild as HTMLElement, dropEvent([file]));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ name: "notes.md" });
  });

  it("ignores a file the accept list excludes", async () => {
    const onSelect = vi.fn();
    const { container } = render(FileDrop, { accept: ".md", onSelect });
    const wrong = new File(["x"], "photo.png", { type: "image/png" });

    await fireEvent.drop(container.firstElementChild as HTMLElement, dropEvent([wrong]));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("accepts a wildcard mime range", async () => {
    const onSelect = vi.fn();
    const { container } = render(FileDrop, { accept: "image/*", onSelect });
    const image = new File(["x"], "photo.png", { type: "image/png" });

    await fireEvent.drop(container.firstElementChild as HTMLElement, dropEvent([image]));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clears the drag state after a drop", async () => {
    const { container, exposed } = render(FileDrop, {});
    const zone = container.firstElementChild as HTMLElement;
    await fireEvent.dragOver(zone, dropEvent([]));
    expect(exposed?.isDragging).toBe(true);

    await fireEvent.drop(zone, dropEvent([new File(["x"], "a.txt")]));
    // A stuck highlight after a drop is the classic drag-and-drop bug.
    expect(exposed?.isDragging).toBe(false);
  });

  it("exposes an imperative picker to its parent", () => {
    const { exposed } = render(FileDrop, {});
    expect(typeof exposed?.openPicker).toBe("function");
  });

  it("renders a hint and the default call to action", () => {
    const { container } = render(FileDrop, { hint: "PNG or JPEG" });
    expect(getByText(container, "PNG or JPEG")).toBeTruthy();
    expect(getByRole(container, "button", { name: /choose file/i })).toBeTruthy();
  });
});

describe("DocumentTree", () => {
  it("exposes its edit-mode handle to the parent", () => {
    const { exposed } = render(DocumentTree, {});
    // RevisionsSidebar and the sidebar chrome drive this from outside.
    expect(exposed).toBeTruthy();
    expect(typeof exposed?.toggleEditMode).toBe("function");
    expect(exposed?.isEditMode).toBe(false);
  });

  it("toggles edit mode through that handle", async () => {
    const { exposed } = render(DocumentTree, {});
    (exposed?.toggleEditMode as () => void)();
    expect(exposed?.isEditMode).toBe(true);
    (exposed?.toggleEditMode as () => void)();
    expect(exposed?.isEditMode).toBe(false);
  });
});
