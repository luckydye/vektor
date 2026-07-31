import { fireEvent, getByRole, getByText } from "@testing-library/dom";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTree } from "#components/DocumentTree.tsx";
import { FileDrop } from "#components/FileDrop.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  // happy-dom keeps one document per file, so a leaked mount leaks into the
  // next spec.
  for (const dispose of disposers.splice(0)) dispose();
});

function mount(ui: () => JSX.Element): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(ui, container);
  disposers.push(() => {
    unmount();
    container.remove();
  });
  return container;
}

/** The imperative handle a component hands its parent through `ref`. */
type Handle = Record<string, unknown> | undefined;

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
    let handle: Handle;
    const container = mount(() => (
      <FileDrop
        ref={(h: Handle) => {
          handle = h;
        }}
      />
    ));
    const zone = container.firstElementChild as HTMLElement;

    expect(handle?.isDragging).toBe(false);
    await fireEvent.dragOver(zone, dropEvent([]));
    expect(handle?.isDragging).toBe(true);

    await fireEvent.dragLeave(zone);
    expect(handle?.isDragging).toBe(false);
  });

  it("reports a dropped file", async () => {
    const onSelect = vi.fn();
    const container = mount(() => <FileDrop onSelect={onSelect} />);
    const file = new File(["x"], "notes.md", { type: "text/markdown" });

    await fireEvent.drop(container.firstElementChild as HTMLElement, dropEvent([file]));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ name: "notes.md" });
  });

  it("ignores a file the accept list excludes", async () => {
    const onSelect = vi.fn();
    const container = mount(() => <FileDrop accept=".md" onSelect={onSelect} />);
    const wrong = new File(["x"], "photo.png", { type: "image/png" });

    await fireEvent.drop(container.firstElementChild as HTMLElement, dropEvent([wrong]));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("accepts a wildcard mime range", async () => {
    const onSelect = vi.fn();
    const container = mount(() => <FileDrop accept="image/*" onSelect={onSelect} />);
    const image = new File(["x"], "photo.png", { type: "image/png" });

    await fireEvent.drop(container.firstElementChild as HTMLElement, dropEvent([image]));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clears the drag state after a drop", async () => {
    let handle: Handle;
    const container = mount(() => (
      <FileDrop
        ref={(h: Handle) => {
          handle = h;
        }}
      />
    ));
    const zone = container.firstElementChild as HTMLElement;
    await fireEvent.dragOver(zone, dropEvent([]));
    expect(handle?.isDragging).toBe(true);

    await fireEvent.drop(zone, dropEvent([new File(["x"], "a.txt")]));
    // A stuck highlight after a drop is the classic drag-and-drop bug.
    expect(handle?.isDragging).toBe(false);
  });

  it("exposes an imperative picker to its parent", () => {
    let handle: Handle;
    mount(() => (
      <FileDrop
        ref={(h: Handle) => {
          handle = h;
        }}
      />
    ));
    expect(typeof handle?.openPicker).toBe("function");
  });

  it("renders a hint and the default call to action", () => {
    const container = mount(() => <FileDrop hint="PNG or JPEG" />);
    expect(getByText(container, "PNG or JPEG")).toBeTruthy();
    expect(getByRole(container, "button", { name: /choose file/i })).toBeTruthy();
  });
});

describe("DocumentTree", () => {
  it("exposes its edit-mode handle to the parent", () => {
    let handle: Handle;
    mount(() => (
      <DocumentTree
        ref={(h: Handle) => {
          handle = h;
        }}
      />
    ));
    // RevisionsSidebar and the sidebar chrome drive this from outside.
    expect(handle).toBeTruthy();
    expect(typeof handle?.toggleEditMode).toBe("function");
    expect(handle?.isEditMode).toBe(false);
  });

  it("toggles edit mode through that handle", async () => {
    let handle: Handle;
    mount(() => (
      <DocumentTree
        ref={(h: Handle) => {
          handle = h;
        }}
      />
    ));
    (handle?.toggleEditMode as () => void)();
    expect(handle?.isEditMode).toBe(true);
    (handle?.toggleEditMode as () => void)();
    expect(handle?.isEditMode).toBe(false);
  });
});
