import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { component } from "./registry.ts";
import { cleanupAll, render } from "./render.ts";

afterEach(cleanupAll);

/**
 * Tier 1 contract specs for the display primitives.
 *
 * Assertions are on rendered DOM only — role, text, attributes, and what a
 * click actually causes. Nothing here inspects component instances or Vue's
 * emit machinery, because those are precisely what the port replaces.
 */

describe("Button", () => {
  it("renders its text as an accessible button", () => {
    const { container } = render(component("Button"), { text: "Save" });
    expect(getByRole(container, "button", { name: "Save" })).toBeTruthy();
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    const { container } = render(component("Button"), { text: "Save" });
    expect(getByRole(container, "button").getAttribute("type")).toBe("button");
  });

  it("takes an explicit type", () => {
    const { container } = render(component("Button"), { text: "Go", type: "submit" });
    expect(getByRole(container, "button").getAttribute("type")).toBe("submit");
  });

  it("applies one variant class per variant", () => {
    for (const [variant, expected] of [
      ["primary", "button-primary"],
      ["secondary", "button-secondary"],
      ["ghost", "button-ghost"],
      ["outline", "button-outline"],
    ] as const) {
      const { container, cleanup } = render(component("Button"), { text: "x", variant });
      expect(getByRole(container, "button").className, variant).toContain(expected);
      cleanup();
    }
  });

  it("layers tone and size on top of the variant", () => {
    const { container } = render(component("Button"), {
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
    const { container } = render(component("Button"), { text: "Hit", onClick });
    getByRole(container, "button").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire when disabled", () => {
    const onClick = vi.fn();
    const { container } = render(component("Button"), {
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
    const { container } = render(component("Button"), { ariaLabel: "Close panel" });
    const button = getByRole(container, "button", { name: "Close panel" });
    expect(button.getAttribute("title")).toBe("Close panel");
  });

  it("renders no icon element when given no icon", () => {
    const { container } = render(component("Button"), { text: "Plain" });
    expect(container.querySelector(".icon")).toBeNull();
  });

  it("renders the icon markup when given one", () => {
    const { container } = render(component("Button"), {
      text: "With",
      icon: '<svg data-testid="i"></svg>',
    });
    expect(container.querySelector(".icon svg")).toBeTruthy();
  });

  it("reflects a prop change without remounting", async () => {
    const { container, update } = render(component("Button"), { text: "Before" });
    await update({ text: "After", disabled: true });
    const button = getByRole(container, "button");
    expect(button.textContent?.trim()).toBe("After");
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("Icon", () => {
  it("renders the named icon's svg", () => {
    const { container } = render(component("Icon"), { name: "plus" });
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("is hidden from assistive technology", () => {
    const { container } = render(component("Icon"), { name: "plus" });
    expect(container.querySelector("[aria-hidden='true']")).toBeTruthy();
  });
});

describe("MenuLink", () => {
  it("renders a link with its text and href", () => {
    const { container } = render(component("MenuLink"), {
      text: "Settings",
      href: "/space/settings",
    });
    const link = getByRole(container, "link", { name: /Settings/ });
    expect(link.getAttribute("href")).toBe("/space/settings");
  });

  it("marks the active item distinctly from the inactive one", () => {
    const active = render(component("MenuLink"), {
      text: "A",
      href: "#",
      isActive: true,
    });
    const idle = render(component("MenuLink"), { text: "A", href: "#", isActive: false });
    expect(getByRole(active.container, "link").className).not.toBe(
      getByRole(idle.container, "link").className,
    );
  });

  it("shows a badge only for a positive count", () => {
    const zero = render(component("MenuLink"), { text: "Inbox", href: "#", badge: 0 });
    expect(zero.container.textContent).not.toContain("0");

    const some = render(component("MenuLink"), { text: "Inbox", href: "#", badge: 3 });
    expect(getByText(some.container, "3")).toBeTruthy();
  });
});

describe("FormField", () => {
  it("renders its label and its slotted control", () => {
    const { container } = render(component("FormField"), { label: "Email" });
    expect(getByText(container, "Email")).toBeTruthy();
  });
});

describe("PagerCursor", () => {
  it("renders nothing when there is only one page", () => {
    const { container } = render(component("PagerCursor"), {
      hasPrevPage: false,
      hasNextPage: false,
    });
    expect(queryByRole(container, "button")).toBeNull();
  });

  it("stays visible but disabled when asked to", () => {
    const { container } = render(component("PagerCursor"), {
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
    const { container } = render(component("PagerCursor"), {
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
    const { container } = render(component("PagerCursor"), {
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
    const { container } = render(component("PagerCursor"), {
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
