export type CosmeticSlot = "avatarFrame" | "cursorCompanion" | "caret";

export interface PublicUserAppearance {
  avatarFrame?: string;
  cursorCompanion?: string;
  caret?: string;
}

export interface CosmeticLoadout {
  avatarFrame?: string;
  cursorCompanion?: string;
  caret?: string;
}

export interface CosmeticAsset {
  id: string;
  slot: CosmeticSlot;
  kind: "image";
  name: string;
  description: string;
  src: string;
  width: number;
  height: number;
  animated?: boolean;
}
