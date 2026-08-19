import { describe, expect, it } from "vitest";
import avatarRobot from "#assets/avatars/robot.svg?raw";
import avatarZero from "#assets/avatars/zero.svg?raw";
import "#components/AvatarElement.ts";

const robotFace = `data:image/svg+xml,${encodeURIComponent(avatarRobot)}`;
const neutralFace = `data:image/svg+xml,${encodeURIComponent(avatarZero)}`;

/**
 * Who gets a robot face, and who gets no face at all.
 *
 * The element used to read this off the id — a `token_` prefix meant machine —
 * which meant an account that had merely been deleted was drawn with invented
 * human features, and nothing but a naming convention stood between the two.
 * The caller says now, and an id that resolves to nobody stays neutral.
 */

function mountAvatar(attributes: Record<string, string>): HTMLElement {
  const element = document.createElement("vektor-avatar");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  return element;
}

function renderedSource(element: HTMLElement): string {
  const image = element.shadowRoot?.querySelector("img");
  return image?.getAttribute("src") ?? "";
}

describe("<vektor-avatar> faces", () => {
  it("draws a robot when the caller says the id is a credential", () => {
    const element = mountAvatar({
      "user-id": "token_d69fb9f4-06a0-46ff-9117-9473fb0e0c8d",
      credential: "",
      size: "28",
    });

    expect(renderedSource(element)).toBe(robotFace);
  });

  it("draws human features for a person, credential-shaped id or not", () => {
    const person = mountAvatar({ "user-id": "SPWkchDrqfDdMPxDU2QRuoJGyPmVhCRt" });
    const shaped = mountAvatar({ "user-id": "token_not_actually_a_credential" });

    for (const element of [person, shaped]) {
      expect(renderedSource(element)).not.toBe(robotFace);
      expect(renderedSource(element)).not.toBe(neutralFace);
    }
  });

  it("asks the server about an id it was given no verdict on", () => {
    // No `credential` attribute means the element resolves the id rather than
    // guessing: the robot is never chosen without being told.
    const element = mountAvatar({ "user-id": "token_d69fb9f4" });
    expect(renderedSource(element)).not.toBe(robotFace);
  });
});
