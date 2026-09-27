import { fireEvent, getAllByRole, getByRole, queryByRole } from "@testing-library/dom";
import { createComponent, createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosmeticsPanel } from "#components/CosmeticsPanel.tsx";
import { appearanceFromLoadout, listCosmeticAssets } from "#cosmetics/assetRegistry.ts";
import type { CosmeticLoadout, CosmeticSlot } from "#cosmetics/types.ts";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

const inventory = listCosmeticAssets();
const frames = inventory.filter((asset) => asset.slot === "avatarFrame");
const carets = inventory.filter((asset) => asset.slot === "caret");

/**
 * Mount the panel with a live loadout, the way `UserPreferencesPanel` does:
 * `onEquip` writes back and the appearance is derived from it, so the specs
 * exercise the equipped state the user actually sees rather than a static prop.
 */
function mountPanel(initial: CosmeticLoadout = {}) {
  const [loadout, setLoadout] = createSignal<CosmeticLoadout>(initial);
  const onEquip = vi.fn((slot: CosmeticSlot, id: string | null) => {
    setLoadout((current) => ({ ...current, [slot]: id ?? undefined }));
  });

  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(
    () =>
      createComponent(CosmeticsPanel as (props: Record<string, unknown>) => JSX.Element, {
        inventory,
        get loadout() {
          return loadout();
        },
        get appearance() {
          return appearanceFromLoadout(loadout());
        },
        user: { id: "u1", name: "Ada", email: "ada@example.com" },
        onEquip,
      }),
    container,
  );
  disposers.push(() => {
    unmount();
    container.remove();
  });

  return { container, loadout, onEquip };
}

/** The inventory tiles: a radio per item, labelled by the tile around it. */
const tiles = (container: HTMLElement) =>
  getAllByRole(container, "radio") as HTMLInputElement[];
const tileNames = (container: HTMLElement) =>
  tiles(container).map((tile) => tile.closest("label")?.textContent?.trim());
const checkedTile = (container: HTMLElement) =>
  tiles(container).find((tile) => tile.checked);
const checkedName = (container: HTMLElement) =>
  checkedTile(container)?.closest("label")?.textContent?.trim();

describe("CosmeticsPanel", () => {
  it("opens on the first slot and lists its items plus None", () => {
    const { container } = mountPanel();

    expect(getByRole(container, "radiogroup").getAttribute("aria-label")).toBe(
      "Avatar frame",
    );
    expect(tileNames(container)).toEqual(["None", ...frames.map((a) => a.name)]);
  });

  it("equips the clicked item and leaves exactly one tile checked", () => {
    const { container, onEquip, loadout } = mountPanel();

    fireEvent.click(tiles(container)[1]);

    expect(onEquip).toHaveBeenCalledWith("avatarFrame", frames[0].id);
    expect(loadout().avatarFrame).toBe(frames[0].id);
    expect(tiles(container).filter((tile) => tile.checked)).toHaveLength(1);
    expect(checkedName(container)).toContain(frames[0].name);
  });

  it("unequips through the None tile", () => {
    const { container, loadout } = mountPanel({ avatarFrame: frames[0].id });

    fireEvent.click(tiles(container)[0]);

    expect(loadout().avatarFrame).toBeUndefined();
    expect(checkedName(container)).toBe("None");
  });

  it("switches the inventory shelf when another slot is selected", () => {
    const { container } = mountPanel();
    const rail = getByRole(container, "button", { name: /Caret/ });

    fireEvent.click(rail);

    expect(getByRole(container, "radiogroup").getAttribute("aria-label")).toBe("Caret");
    expect(tileNames(container)).toEqual(["None", ...carets.map((a) => a.name)]);
    expect(rail.getAttribute("aria-pressed")).toBe("true");
  });

  it("names the equipped item in the slot rail", () => {
    const { container } = mountPanel({ caret: carets[0].id });

    expect(
      getByRole(container, "button", { name: new RegExp(carets[0].name) }),
    ).toBeTruthy();
  });

  it("groups the shelf under one radio name, so the arrow keys walk it", () => {
    const { container } = mountPanel();

    const names = new Set(tiles(container).map((tile) => tile.name));
    expect(names.size).toBe(1);
    expect([...names][0]).toContain("avatarFrame");
  });

  it("previews a hovered item on the stage without equipping it", () => {
    const { container, onEquip } = mountPanel();
    const avatar = container.querySelector("vektor-avatar") as HTMLElement & {
      user?: { appearance?: { avatarFrame?: string } };
    };

    fireEvent.mouseEnter(tiles(container)[1].closest("label") as HTMLElement);
    expect(avatar.user?.appearance?.avatarFrame).toBe(frames[0].id);
    expect(onEquip).not.toHaveBeenCalled();
    expect(checkedName(container)).toBe("None");

    fireEvent.mouseLeave(getByRole(container, "radiogroup"));
    expect(avatar.user?.appearance?.avatarFrame).toBeUndefined();
  });

  it("describes the hovered item, falling back to the equipped one", () => {
    const { container } = mountPanel({ avatarFrame: frames[0].id });
    const shown = () => container.textContent ?? "";

    expect(shown()).toContain(frames[0].description);

    fireEvent.mouseEnter(tiles(container)[2].closest("label") as HTMLElement);
    expect(shown()).toContain(frames[1].description);
  });

  it("badges the equipped tile and nothing else", () => {
    const { container } = mountPanel({ avatarFrame: frames[0].id });

    const badges = container.querySelectorAll('[title="Equipped"]');
    expect(badges).toHaveLength(1);
    expect(checkedTile(container)?.closest("label")?.contains(badges[0])).toBe(true);
  });

  it("counts the items on the shelf, not the None tile", () => {
    const { container } = mountPanel();
    const heading = getByRole(container, "heading", { name: "Avatar frame" });

    expect(heading.nextElementSibling?.textContent).toBe(String(frames.length));
  });

  it("pads a short shelf out to two rows of slots", () => {
    const { container } = mountPanel();
    const shelf = getByRole(container, "radiogroup");

    // Items plus vacancies, so the card never ends on a half-empty row.
    expect(shelf.children).toHaveLength(6);
  });

  it("shows one shelf at a time instead of a section per slot", () => {
    const { container } = mountPanel();

    expect(queryByRole(container, "radiogroup", { name: "Caret" })).toBeNull();
    expect(getAllByRole(container, "radiogroup")).toHaveLength(1);
  });
});
