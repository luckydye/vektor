import { describe, expect, it } from "vitest";
import { SPACE_SELECTOR_MINIMUM, spaceSelectorSlots } from "#utils/pinnedSpaces.ts";

/**
 * A pin buys a permanent row in the switcher, and the minimum is what keeps a
 * barely-pinned one from shrinking to a single entry. These cover which spaces
 * make the list and in what order.
 */

const spaces = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}` }));

describe("spaceSelectorSlots", () => {
  it("shows the head of the list when nothing is pinned", () => {
    expect(spaceSelectorSlots(spaces, new Set())).toEqual(
      spaces.slice(0, SPACE_SELECTOR_MINIMUM),
    );
  });

  it("lifts pinned spaces to the front, keeping list order within each half", () => {
    const slots = spaceSelectorSlots(spaces, new Set(["s7", "s2"]));
    expect(slots.map((space) => space.id)).toEqual(["s2", "s7", "s0", "s1", "s3", "s4"]);
  });

  it("grows past the minimum rather than evicting a pin", () => {
    const pinned = new Set(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(spaceSelectorSlots(spaces, pinned).map((space) => space.id)).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
    ]);
  });

  it("stops borrowing filler once the pins alone reach the minimum", () => {
    const pinned = new Set(["s9", "s8", "s7", "s6", "s5", "s4"]);
    expect(spaceSelectorSlots(spaces, pinned).map((space) => space.id)).toEqual([
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
      "s9",
    ]);
  });

  it("ignores a pin for a space that is gone", () => {
    expect(spaceSelectorSlots(spaces.slice(0, 2), new Set(["s5"]))).toEqual([
      { id: "s0" },
      { id: "s1" },
    ]);
  });

  it("lists everything when there are fewer spaces than the minimum", () => {
    const few = spaces.slice(0, 3);
    expect(spaceSelectorSlots(few, new Set(["s2"])).map((space) => space.id)).toEqual([
      "s2",
      "s0",
      "s1",
    ]);
  });
});
