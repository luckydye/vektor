import { createCosmeticElement } from "./CosmeticElement.ts";
import type { PublicUserAppearance } from "./types.ts";

export function appendCaretDecoration(
  caret: HTMLElement,
  appearance: PublicUserAppearance | null | undefined,
): void {
  const decoration = createCosmeticElement(appearance?.caretDecoration);
  if (!decoration) return;

  decoration.className = "cosmetic-caret-decoration";
  Object.assign(decoration.style, {
    position: "absolute",
    left: "4px",
    bottom: "-6px",
    width: "28px",
    height: "28px",
    filter: "drop-shadow(0 1px 1px rgb(15 23 42 / 0.2))",
  });
  caret.append(decoration);
}

