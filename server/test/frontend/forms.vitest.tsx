import { fireEvent, getByRole, getByText, queryByText } from "@testing-library/dom";
import { createComponent, createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Input } from "#components/Input.tsx";
import { SelectMenu } from "#components/SelectMenu.tsx";
import { SwitchToggle } from "#components/SwitchToggle.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  // happy-dom keeps one document per file, so a leaked mount leaks into the
  // next spec.
  for (const dispose of disposers.splice(0)) dispose();
});

type Props = Record<string, unknown>;

/**
 * Mount a component and return its container.
 *
 * Props are a plain object; a test that needs one to change declares it as a
 * getter over a signal, which is what a real parent's JSX compiles to.
 */
function mount(Component: unknown, props: Props = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  // `render`'s own disposer, not an outer `createRoot`: a `Portal` in the tree
  // attaches to `document.body`, and disposing an outer root leaves that
  // content behind for the next spec to find.
  const unmount = render(
    () => createComponent(Component as (props: Props) => JSX.Element, props),
    container,
  );
  const cleanup = () => {
    unmount();
    container.remove();
  };
  disposers.push(cleanup);
  return { container, cleanup };
}

/** The two-way binding a form primitive takes: `value` in, `onInput` out. */
function modelProps(value: unknown, onChange?: (next: never) => void): Props {
  return { value, ...(onChange ? { onInput: onChange } : {}) };
}

/** Contract specs for the form primitives. */

describe("Input", () => {
  it("renders as a textbox with its placeholder", () => {
    const { container } = mount(Input, { placeholder: "Your name" });
    expect(getByRole(container, "textbox").getAttribute("placeholder")).toBe("Your name");
  });

  it("shows the bound value", () => {
    const { container } = mount(Input, modelProps("hello"));
    expect((getByRole(container, "textbox") as HTMLInputElement).value).toBe("hello");
  });

  it("follows the bound value when the parent changes it", async () => {
    const [value, setValue] = createSignal("first");
    const { container } = mount(Input, {
      get value() {
        return value();
      },
    });
    setValue("second");
    expect((getByRole(container, "textbox") as HTMLInputElement).value).toBe("second");
  });

  it("reports what the reader typed", () => {
    const onChange = vi.fn();
    const { container } = mount(Input, modelProps("", onChange));
    fireEvent.input(getByRole(container, "textbox"), { target: { value: "typed" } });
    expect(onChange).toHaveBeenCalledWith("typed");
  });

  it("honours the input type", () => {
    const { container } = mount(Input, { type: "password" });
    // password inputs have no ARIA role, so query the element directly
    expect(container.querySelector("input")?.getAttribute("type")).toBe("password");
  });

  it("disables the control", () => {
    const { container } = mount(Input, { disabled: true });
    expect((getByRole(container, "textbox") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("SwitchToggle", () => {
  it("exposes itself as a switch reflecting its state", () => {
    const { container } = mount(SwitchToggle, modelProps(true));
    const control = getByRole(container, "switch") as HTMLInputElement;
    expect(control.checked).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("follows the bound value", async () => {
    const [value, setValue] = createSignal(false);
    const { container } = mount(SwitchToggle, {
      get value() {
        return value();
      },
    });
    expect((getByRole(container, "switch") as HTMLInputElement).checked).toBe(false);
    setValue(true);
    const control = getByRole(container, "switch") as HTMLInputElement;
    expect(control.checked).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the state the reader asked for", () => {
    const onChange = vi.fn();
    const { container } = mount(SwitchToggle, modelProps(false, onChange));
    const control = getByRole(container, "switch") as HTMLInputElement;
    control.checked = true;
    fireEvent.change(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders an optional label", () => {
    const { container } = mount(SwitchToggle, {
      ...modelProps(false),
      label: "Enable workflows",
    });
    expect(getByText(container, "Enable workflows")).toBeTruthy();
  });

  it("does not report changes while disabled", () => {
    const onChange = vi.fn();
    const { container } = mount(SwitchToggle, {
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
    const { container } = mount(SelectMenu, { items, ...modelProps(null) });
    for (const item of items) expect(getByText(container, item.label)).toBeTruthy();
  });

  it("marks the selected item differently from the rest", () => {
    const { container } = mount(SelectMenu, {
      items,
      ...modelProps("date"),
    });
    const buttons = [...container.querySelectorAll("button")];
    const selected = buttons.find((b) => b.textContent?.includes("Date"));
    const other = buttons.find((b) => b.textContent?.includes("Text"));
    expect(selected?.className).not.toBe(other?.className);
  });

  it("supports a multi-select value", () => {
    const { container } = mount(SelectMenu, {
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
    const { container } = mount(SelectMenu, {
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
    const { container } = mount(SelectMenu, {
      items: [],
      ...modelProps(null),
    });
    expect(container.querySelector("button")).toBeNull();
    expect(queryByText(container, "Text")).toBeNull();
  });
});
