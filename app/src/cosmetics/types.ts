export type CosmeticSlot = "avatarFrame" | "cursorCompanion" | "caretDecoration";

export interface PublicUserAppearance {
  avatarFrame?: string;
  cursorCompanion?: string;
  caretDecoration?: string;
}

export interface CosmeticLoadout {
  avatarFrame?: string;
  cursorCompanion?: string;
  caretDecoration?: string;
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
