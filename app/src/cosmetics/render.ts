import { createCosmeticElement } from "./CosmeticElement.ts";
import type { PublicUserAppearance } from "./types.ts";

export function appendCaretDecoration(
  caret: HTMLElement,
  appearance: PublicUserAppearance | null | undefined,
): void {
  const decoration = createCosmeticElement(appearance?.caret);
  if (!decoration) return;

  // A caret cosmetic replaces the regular caret stroke; it is not a companion
  // positioned beside it. Both editor implementations use either borders or a
  // background to draw that stroke, so clear both before mounting the asset.
  caret.style.borderColor = "transparent";
  caret.style.backgroundColor = "transparent";
  decoration.className = "cosmetic-caret-decoration";
  Object.assign(decoration.style, {
    position: "absolute",
    left: "-7px",
    top: "0",
    width: "14px",
    height: "100%",
    minHeight: "14px",
    filter: "drop-shadow(0 1px 1px rgb(15 23 42 / 0.16))",
  });
  caret.append(decoration);
}
