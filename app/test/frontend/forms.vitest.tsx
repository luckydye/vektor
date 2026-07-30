import { fireEvent, getByRole, getByText, queryByText } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { component } from "./registry.ts";
import { cleanupAll, modelProps, render } from "./render.ts";

afterEach(cleanupAll);

/**
 * Tier 1 contract specs for the form primitives.
 *
 * Two-way binding goes through `modelProps()` rather than naming `modelValue`
 * directly, because Solid spells that binding differently and a spec rewritten
 * mid-migration stops being a before/after check.
 */

describe("Input", () => {
  it("renders as a textbox with its placeholder", () => {
    const { container } = render(component("Input"), { placeholder: "Your name" });
    expect(getByRole(container, "textbox").getAttribute("placeholder")).toBe("Your name");
  });

  it("shows the bound value", () => {
    const { container } = render(component("Input"), modelProps("hello"));
    expect((getByRole(container, "textbox") as HTMLInputElement).value).toBe("hello");
  });

  it("follows the bound value when the parent changes it", async () => {
    const { container, update } = render(component("Input"), modelProps("first"));
    await update(modelProps("second"));
    expect((getByRole(container, "textbox") as HTMLInputElement).value).toBe("second");
  });

  it("reports what the reader typed", () => {
    const onChange = vi.fn();
    const { container } = render(component("Input"), modelProps("", onChange));
    fireEvent.input(getByRole(container, "textbox"), { target: { value: "typed" } });
    expect(onChange).toHaveBeenCalledWith("typed");
  });

  it("honours the input type", () => {
    const { container } = render(component("Input"), { type: "password" });
    // password inputs have no ARIA role, so query the element directly
    expect(container.querySelector("input")?.getAttribute("type")).toBe("password");
  });

  it("disables the control", () => {
    const { container } = render(component("Input"), { disabled: true });
    expect((getByRole(container, "textbox") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("SwitchToggle", () => {
  it("exposes itself as a switch reflecting its state", () => {
    const { container } = render(component("SwitchToggle"), modelProps(true));
    const control = getByRole(container, "switch") as HTMLInputElement;
    expect(control.checked).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("follows the bound value", async () => {
    const { container, update } = render(component("SwitchToggle"), modelProps(false));
    expect((getByRole(container, "switch") as HTMLInputElement).checked).toBe(false);
    await update(modelProps(true));
    const control = getByRole(container, "switch") as HTMLInputElement;
    expect(control.checked).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the state the reader asked for", () => {
    const onChange = vi.fn();
    const { container } = render(component("SwitchToggle"), modelProps(false, onChange));
    const control = getByRole(container, "switch") as HTMLInputElement;
    control.checked = true;
    fireEvent.change(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders an optional label", () => {
    const { container } = render(component("SwitchToggle"), {
      ...modelProps(false),
      label: "Enable workflows",
    });
    expect(getByText(container, "Enable workflows")).toBeTruthy();
  });

  it("does not report changes while disabled", () => {
    const onChange = vi.fn();
    const { container } = render(component("SwitchToggle"), {
      ...modelProps(false, onChange),
      disabled: true,
    });
    const control = getByRole(container, "switch") as HTMLInputElement;
    expect(control.disabled).toBe(true);
    control.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SelectMenu", () => {
  const items = [
    { id: "text", label: "Text" },
    { id: "date", label: "Date" },
    { id: "user", label: "User" },
  ];

  it("renders one option per item", () => {
    const { container } = render(component("SelectMenu"), { items, ...modelProps(null) });
    for (const item of items) expect(getByText(container, item.label)).toBeTruthy();
  });

  it("marks the selected item differently from the rest", () => {
    const { container } = render(component("SelectMenu"), {
      items,
      ...modelProps("date"),
    });
    const buttons = [...container.querySelectorAll("button")];
    const selected = buttons.find((b) => b.textContent?.includes("Date"));
    const other = buttons.find((b) => b.textContent?.includes("Text"));
    expect(selected?.className).not.toBe(other?.className);
  });

  it("supports a multi-select value", () => {
    const { container } = render(component("SelectMenu"), {
      items,
      ...modelProps(["text", "user"]),
    });
    const buttons = [...container.querySelectorAll("button")];
    const text = buttons.find((b) => b.textContent?.includes("Text"))?.className;
    const date = buttons.find((b) => b.textContent?.includes("Date"))?.className;
    const user = buttons.find((b) => b.textContent?.includes("User"))?.className;
    expect(text).toBe(user);
    expect(text).not.toBe(date);
  });

  it("reports the item the reader picked", () => {
    const onSelect = vi.fn();
    const { container } = render(component("SelectMenu"), {
      items,
      ...modelProps(null),
      onSelect,
    });
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("User"),
    );
    button?.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ id: "user" });
  });

  it("renders nothing for an empty item list", () => {
    const { container } = render(component("SelectMenu"), {
      items: [],
      ...modelProps(null),
    });
    expect(container.querySelector("button")).toBeNull();
    expect(queryByText(container, "Text")).toBeNull();
  });
});
