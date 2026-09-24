import { queryByText } from "@testing-library/dom";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OverviewSpace, SpacesOverview } from "#components/SpacesOverview.tsx";

/**
 * The overview lists spaces an instance admin does not belong to, so two things
 * have to hold on every card: destructive actions are not one click away, and a
 * space reachable only through admin rights says so instead of claiming a role.
 */

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

type Props = Record<string, unknown>;

function mount(props: Props) {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(
    () => createComponent(SpacesOverview as (props: Props) => JSX.Element, props),
    container,
  );
  disposers.push(() => {
    unmount();
    container.remove();
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function space(overrides: Partial<OverviewSpace> = {}): OverviewSpace {
  return {
    id: "s1",
    name: "Engineering",
    slug: "engineering",
    pinned: false,
    ...overrides,
  };
}

function deleteItem() {
  return queryByText(document.body, "Delete space");
}

describe("SpacesOverview", () => {
  it("keeps delete behind the actions menu rather than on the card", async () => {
    mount({ spaces: [space({ role: "owner" })], onDelete: vi.fn() });
    await settle();

    // The trigger is there, but nothing deletes until the menu is opened.
    expect(document.body.querySelector('[aria-label="Space actions"]')).toBeTruthy();
    expect(deleteItem()?.closest("a-popover")).toBeTruthy();
  });

  it("offers no actions menu to a non-owner", async () => {
    mount({ spaces: [space({ role: "editor" })], onDelete: vi.fn() });
    await settle();

    expect(document.body.querySelector('[aria-label="Space actions"]')).toBeNull();
    expect(deleteItem()).toBeNull();
  });

  it("reports the chosen space when the menu item is clicked", async () => {
    const onDelete = vi.fn();
    mount({ spaces: [space({ role: "owner" })], onDelete });
    await settle();

    deleteItem()?.closest("button")?.click();
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "engineering" }),
    );
  });

  it("offers gain-access only on a space reached through admin rights", async () => {
    const onGainAccess = vi.fn();
    mount({
      spaces: [
        space({ id: "s1", role: "owner", adminAccess: true }),
        space({ id: "s2", name: "Design", slug: "design", role: "owner" }),
      ],
      onGainAccess,
    });
    await settle();

    const items = [...document.body.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Gain access",
    );
    expect(items).toHaveLength(1);

    items[0]?.click();
    expect(onGainAccess).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  // Owner is what the guards decide an admin's requests at, so the role alone
  // would read as membership on a space they have no grant in.
  it("marks a space reached through admin rights instead of naming the role", async () => {
    mount({ spaces: [space({ role: "owner", adminAccess: true })] });
    await settle();

    expect(queryByText(document.body, "Not a member")).toBeTruthy();
    expect(queryByText(document.body, "owner")).toBeNull();
  });

  it("names the role on a space the viewer belongs to", async () => {
    mount({ spaces: [space({ role: "owner" })] });
    await settle();

    expect(queryByText(document.body, "owner")).toBeTruthy();
    expect(queryByText(document.body, "Not a member")).toBeNull();
  });
});
