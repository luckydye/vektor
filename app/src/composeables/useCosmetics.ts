import { computed, readonly, ref } from "vue";
import {
  appearanceFromLoadout,
  isCosmeticForSlot,
  listCosmeticAssets,
  sanitizeCosmeticLoadout,
} from "#cosmetics/assetRegistry.ts";
import type { CosmeticLoadout, CosmeticSlot } from "#cosmetics/types.ts";

const STORAGE_KEY = "vektor:cosmetics:loadout";

function readStoredLoadout(): CosmeticLoadout {
  if (typeof localStorage === "undefined") return {};
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return sanitizeCosmeticLoadout(stored as CosmeticLoadout);
  } catch {
    return {};
  }
}

const loadout = ref<CosmeticLoadout>(readStoredLoadout());
const inventory = listCosmeticAssets();
const appearance = computed(() => appearanceFromLoadout(loadout.value));

let listening = false;

function startListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) loadout.value = readStoredLoadout();
  });
}

export function useCosmetics() {
  startListening();

  function equip(slot: CosmeticSlot, cosmeticId: string | null): void {
    if (cosmeticId && !isCosmeticForSlot(cosmeticId, slot)) return;

    const next = {
      ...loadout.value,
      [slot]: cosmeticId ?? undefined,
    };
    loadout.value = sanitizeCosmeticLoadout(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(loadout.value));
    }
  }

  return {
    inventory,
    loadout: readonly(loadout),
    appearance,
    equip,
  };
}

