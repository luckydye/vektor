import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { createComponent, createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "#components/Button.tsx";
import { FormField } from "#components/FormField.tsx";
import { Icon } from "#components/Icon.tsx";
import { MenuLink } from "#components/MenuLink.tsx";
import { PagerCursor } from "#components/PagerCursor.tsx";

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

/**
 * Contract specs for the display primitives.
 *
 * Assertions are on rendered DOM only — role, text, attributes, and what a
 * click actually causes. Nothing here inspects component internals.
 */

describe("Button", () => {
  it("renders its text as an accessible button", () => {
    const { container } = mount(Button, { text: "Save" });
    expect(getByRole(container, "button", { name: "Save" })).toBeTruthy();
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    const { container } = mount(Button, { text: "Save" });
    expect(getByRole(container, "button").getAttribute("type")).toBe("button");
  });

  it("takes an explicit type", () => {
    const { container } = mount(Button, { text: "Go", type: "submit" });
    expect(getByRole(container, "button").getAttribute("type")).toBe("submit");
  });

  it("applies one variant class per variant", () => {
    for (const [variant, expected] of [
      ["primary", "button-primary"],
      ["secondary", "button-secondary"],
      ["ghost", "button-ghost"],
      ["outline", "button-outline"],
    ] as const) {
      const { container, cleanup } = mount(Button, { text: "x", variant });
      expect(getByRole(container, "button").className, variant).toContain(expected);
      cleanup();
    }
  });

  it("layers tone and size on top of the variant", () => {
    const { container } = mount(Button, {
      text: "Delete",
      tone: "danger",
      size: "small",
    });
    const cls = getByRole(container, "button").className;
    expect(cls).toContain("button-primary");
    expect(cls).toContain("button-danger");
    expect(cls).toContain("button-small");
  });

  it("calls its click handler", async () => {
    const onClick = vi.fn();
    const { container } = mount(Button, { text: "Hit", onClick });
    getByRole(container, "button").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    const { container } = mount(Button, {
      text: "No",
      disabled: true,
      onClick,
    });
    const button = getByRole(container, "button");
    expect(button.hasAttribute("disabled")).toBe(true);
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses ariaLabel as both accessible name and tooltip", () => {
    const { container } = mount(Button, { ariaLabel: "Close panel" });
    const button = getByRole(container, "button", { name: "Close panel" });
    expect(button.getAttribute("title")).toBe("Close panel");
  });

  it("renders no icon element when given no icon", () => {
    const { container } = mount(Button, { text: "Plain" });
    expect(container.querySelector(".icon")).toBeNull();
  });

  it("renders the icon markup when given one", () => {
    const { container } = mount(Button, {
      text: "With",
      icon: '<svg data-testid="i"></svg>',
    });
    expect(container.querySelector(".icon svg")).toBeTruthy();
  });

  it("reflects a prop change without remounting", () => {
    const [text, setText] = createSignal("Before");
    const [disabled, setDisabled] = createSignal(false);
    const { container } = mount(Button, {
      get text() {
        return text();
      },
      get disabled() {
        return disabled();
      },
    });
    const before = getByRole(container, "button");

    setText("After");
    setDisabled(true);

    const button = getByRole(container, "button");
    expect(button, "the same element, patched in place").toBe(before);
    expect(button.textContent?.trim()).toBe("After");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("Icon", () => {
  it("renders the named icon's svg", () => {
    const { container } = mount(Icon, { name: "add" });
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("is hidden from assistive technology", () => {
    const { container } = mount(Icon, { name: "add" });
    expect(container.querySelector("[aria-hidden='true']")).toBeTruthy();
  });

  it("draws a glyph, never text, for a name that is not in the set", () => {
    const { container } = mount(Icon, { name: "no-such-icon" });
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent?.trim()).toBe("");
  });

  // The `svg` prop takes markup, and an icon name is also a string, so a caller
  // that meant `name` used to get its name printed as text.
  it("draws a glyph, never text, when a name arrives where markup was expected", () => {
    const { container } = mount(Icon, { svg: "confirmation" });
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent?.trim()).toBe("");
  });

  it("draws nothing when no icon was asked for", () => {
    const { container } = mount(Icon, {});
    expect(container.querySelector("svg")).toBeFalsy();
  });
});

describe("MenuLink", () => {
  it("renders a link with its text and href", () => {
    const { container } = mount(MenuLink, {
      text: "Settings",
      href: "/space/settings",
    });
    const link = getByRole(container, "link", { name: /Settings/ });
    expect(link.getAttribute("href")).toBe("/space/settings");
  });

  it("marks the active item distinctly from the inactive one", () => {
    const active = mount(MenuLink, {
      text: "A",
      href: "#",
      isActive: true,
    });
    const idle = mount(MenuLink, { text: "A", href: "#", isActive: false });
    expect(getByRole(active.container, "link").className).not.toBe(
      getByRole(idle.container, "link").className,
    );
  });

  it("shows a badge only for a positive count", () => {
    const zero = mount(MenuLink, { text: "Inbox", href: "#", badge: 0 });
    expect(zero.container.textContent).not.toContain("0");

    const some = mount(MenuLink, { text: "Inbox", href: "#", badge: 3 });
    expect(getByText(some.container, "3")).toBeTruthy();
  });
});

describe("FormField", () => {
  it("renders its label and its slotted control", () => {
    const { container } = mount(FormField, { label: "Email" });
    expect(getByText(container, "Email")).toBeTruthy();
  });
});

describe("PagerCursor", () => {
  it("renders nothing when there is only one page", () => {
    const { container } = mount(PagerCursor, {
      hasPrevPage: false,
      hasNextPage: false,
    });
    expect(queryByRole(container, "button")).toBeNull();
  });

  it("stays visible but disabled when asked to", () => {
    const { container } = mount(PagerCursor, {
      hasPrevPage: false,
      hasNextPage: false,
      alwaysVisible: true,
    });
    expect(
      getByRole(container, "button", { name: "Previous" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      getByRole(container, "button", { name: "Next" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("enables only the directions that exist", () => {
    const { container } = mount(PagerCursor, {
      hasPrevPage: false,
      hasNextPage: true,
    });
    expect(
      getByRole(container, "button", { name: "Previous" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      getByRole(container, "button", { name: "Next" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("reports the direction the reader chose", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { container } = mount(PagerCursor, {
      hasPrevPage: true,
      hasNextPage: true,
      onPrev,
      onNext,
    });
    getByRole(container, "button", { name: "Next" }).click();
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();

    getByRole(container, "button", { name: "Previous" }).click();
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("disables both directions while a page is loading", () => {
    const { container } = mount(PagerCursor, {
      hasPrevPage: true,
      hasNextPage: true,
      disabled: true,
    });
    for (const name of ["Previous", "Next"]) {
      expect(
        getByRole(container, "button", { name }).hasAttribute("disabled"),
        name,
      ).toBe(true);
    }
  });
});
