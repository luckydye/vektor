import { createMemo, createSignal } from "solid-js";
import {
  appearanceFromLoadout,
  isCosmeticForSlot,
  listCosmeticAssets,
  sanitizeCosmeticLoadout,
} from "#cosmetics/assetRegistry.ts";
import type { CosmeticLoadout, CosmeticSlot } from "#cosmetics/types.ts";
import { readStored, subscribeStored, writeStored } from "#utils/clientStorage.ts";

const STORAGE_KEY = "vektor:cosmetics:loadout";

function readStoredLoadout(): CosmeticLoadout {
  return (
    readStored<CosmeticLoadout>(STORAGE_KEY, {
      parse: (raw) => sanitizeCosmeticLoadout(JSON.parse(raw) as CosmeticLoadout),
    }) ?? {}
  );
}

const [loadout, setLoadout] = createSignal<CosmeticLoadout>(readStoredLoadout());
const inventory = listCosmeticAssets();
const appearance = createMemo(() => appearanceFromLoadout(loadout()));

// A loadout is the same person everywhere, so a change in one tab belongs in all
// of them. One listener for the whole app, since the signal above is module-level.
subscribeStored(STORAGE_KEY, () => setLoadout(readStoredLoadout()));

export function useCosmetics() {
  function equip(slot: CosmeticSlot, cosmeticId: string | null): void {
    if (cosmeticId && !isCosmeticForSlot(cosmeticId, slot)) return;

    const next = {
      ...loadout(),
      [slot]: cosmeticId ?? undefined,
    };
    setLoadout(sanitizeCosmeticLoadout(next));
    writeStored(STORAGE_KEY, loadout());
  }

  return {
    inventory,
    loadout: loadout,
    appearance,
    equip,
  };
}
