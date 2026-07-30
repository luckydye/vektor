import { getByRole, queryByRole, queryByText } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { component } from "./registry.ts";
import { cleanupAll, render } from "./render.ts";

afterEach(cleanupAll);

/**
 * Tier 1 contract specs for the dialog stack.
 *
 * `Dialog` teleports its panel to `document.body`, so these query the document
 * rather than the render container — the teleport target is part of the
 * contract, and asserting it here means the port cannot quietly drop it.
 */

/** Dialog mounts through ClientOnly, which renders on mount rather than immediately. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The panel stays mounted and toggles `hidden` (the section 5.1 CSS transition
 * work), so "closed" is an attribute, not an absent node. Note `role="dialog"`
 * is set by `a-blur` on itself when it upgrades, which is why these query the
 * panel by class instead.
 */
function layer(): HTMLElement | null {
  return document.body.querySelector(".dialog-layer");
}

function isOpen(): boolean {
  const el = layer();
  return el !== null && !el.hasAttribute("hidden");
}

describe("Dialog", () => {
  it("stays mounted but hidden while closed", async () => {
    render(component("Dialog"), { show: false, title: "Settings" });
    await settle();
    expect(layer()).toBeTruthy();
    expect(isOpen()).toBe(false);
  });

  it("teleports its panel to the body and shows the title when open", async () => {
    render(component("Dialog"), { show: true, title: "Delete space" });
    await settle();
    expect(isOpen()).toBe(true);
    expect(document.body.querySelector(".dialog-panel")).toBeTruthy();
    expect(queryByText(document.body, "Delete space")).toBeTruthy();
  });

  it("only enables the blur trap while open", async () => {
    const { update } = render(component("Dialog"), { show: false, title: "Trap" });
    await settle();
    // A focus trap live behind a hidden overlay would swallow keyboard input.
    expect(layer()?.hasAttribute("enabled")).toBe(false);

    await update({ show: true });
    await settle();
    expect(layer()?.hasAttribute("enabled")).toBe(true);
  });

  it("opens and closes as the show prop changes", async () => {
    const { update } = render(component("Dialog"), { show: false, title: "Later" });
    await settle();
    expect(isOpen()).toBe(false);

    await update({ show: true });
    await settle();
    expect(isOpen()).toBe(true);

    await update({ show: false });
    await settle();
    expect(isOpen()).toBe(false);
  });

  it("reports a close from the header button", async () => {
    const onClose = vi.fn();
    render(component("Dialog"), { show: true, title: "Closable", onClose });
    await settle();
    getByRole(document.body, "button", { name: "Close" }).click();
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on a backdrop click, and not when that is disabled", async () => {
    const dismissible = vi.fn();
    render(component("Dialog"), { show: true, title: "A", onClose: dismissible });
    await settle();
    getByRole(document.body, "button", { name: "Close dialog" }).click();
    expect(dismissible).toHaveBeenCalled();
    cleanupAll();

    const sticky = vi.fn();
    render(component("Dialog"), {
      show: true,
      title: "B",
      closeOnBackdrop: false,
      onClose: sticky,
    });
    await settle();
    getByRole(document.body, "button", { name: "Close dialog" }).click();
    expect(sticky).not.toHaveBeenCalled();
  });

  it("cleans the body up when unmounted", async () => {
    const { cleanup } = render(component("Dialog"), { show: true, title: "Transient" });
    await settle();
    expect(layer()).toBeTruthy();
    cleanup();
    await settle();
    expect(layer()).toBeNull();
  });
});

describe("DialogFooter", () => {
  it("renders a cancel and a confirm action", () => {
    const { container } = render(component("DialogFooter"), { confirmLabel: "Create" });
    expect(getByRole(container, "button", { name: "Cancel" })).toBeTruthy();
    expect(getByRole(container, "button", { name: "Create" })).toBeTruthy();
  });

  it("reports cancel and confirm separately", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { container } = render(component("DialogFooter"), {
      confirmLabel: "Create",
      onCancel,
      onConfirm,
    });
    getByRole(container, "button", { name: "Create" }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    getByRole(container, "button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("swaps in the pending label and disables both actions", () => {
    const { container } = render(component("DialogFooter"), {
      confirmLabel: "Delete",
      pendingLabel: "Deleting…",
      pending: true,
    });
    expect(
      getByRole(container, "button", { name: "Deleting…" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      getByRole(container, "button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables only confirm for an incomplete form", () => {
    const { container } = render(component("DialogFooter"), {
      confirmLabel: "Save",
      disabled: true,
    });
    expect(
      getByRole(container, "button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      getByRole(container, "button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("submits a named form instead of emitting confirm", () => {
    const onConfirm = vi.fn();
    const { container } = render(component("DialogFooter"), {
      confirmLabel: "Create",
      form: "create-thing",
      onConfirm,
    });
    const confirm = getByRole(container, "button", { name: "Create" });
    expect(confirm.getAttribute("type")).toBe("submit");
    expect(confirm.getAttribute("form")).toBe("create-thing");
    confirm.click();
    // The form owns the submit; a second confirm signal would double-handle it.
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("applies the danger tone to confirm only", () => {
    const { container } = render(component("DialogFooter"), {
      confirmLabel: "Delete",
      tone: "danger",
    });
    expect(getByRole(container, "button", { name: "Delete" }).className).toContain(
      "button-danger",
    );
    expect(getByRole(container, "button", { name: "Cancel" }).className).not.toContain(
      "button-danger",
    );
  });

  it("right-aligns instead of splitting when asked", () => {
    const split = render(component("DialogFooter"), { confirmLabel: "A" });
    const end = render(component("DialogFooter"), { confirmLabel: "A", layout: "end" });
    expect(getByRole(split.container, "button", { name: "A" }).className).toContain(
      "flex-1",
    );
    expect(getByRole(end.container, "button", { name: "A" }).className).not.toContain(
      "flex-1",
    );
  });
});

describe("SelectItem", () => {
  it("renders its label as a button", () => {
    const { container } = render(component("SelectItem"), { label: "Text" });
    expect(getByRole(container, "button", { name: "Text" })).toBeTruthy();
  });

  it("reports a click natively, with no relay", () => {
    const onClick = vi.fn();
    const { container } = render(component("SelectItem"), { label: "Text", onClick });
    getByRole(container, "button").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("marks selection visually", () => {
    const on = render(component("SelectItem"), { label: "T", selected: true });
    const off = render(component("SelectItem"), { label: "T", selected: false });
    expect(queryByRole(on.container, "button")?.className).not.toBe(
      queryByRole(off.container, "button")?.className,
    );
  });
});

describe("ContextMenu", () => {
  it("exposes a labelled trigger button", () => {
    const { container } = render(component("ContextMenu"), {});
    const trigger = getByRole(container, "button", { name: "Document actions" });
    // The trigger is slotted into the popover custom element; losing the slot
    // would leave the menu unopenable without failing anything else.
    expect(trigger.getAttribute("slot")).toBe("trigger");
  });

  it("renders its slotted items inside the popover", () => {
    const { container } = render(component("ContextMenu"), {});
    expect(container.querySelector("a-popover")).toBeTruthy();
    expect(container.querySelector("a-list")).toBeTruthy();
  });
});
