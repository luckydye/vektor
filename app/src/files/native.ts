import type * as NativeImage from "#native/image/generated/index.d.ts";
import { getNativeAddon } from "#utils/nativeAddon.ts";

export type NativeAddon = typeof NativeImage;

let _addon: NativeAddon | null | undefined;
let addonPromise: Promise<NativeAddon> | undefined;

async function loadNativeImage(): Promise<NativeAddon> {
  const nativeModule: unknown = await import("./native/addon.ts");
  return getNativeAddon<NativeAddon>(nativeModule, {
    addonName: "image",
    requiredFunction: "transform",
    moduleUrl: import.meta.url,
  });
}

export async function getNativeImage(): Promise<NativeAddon | null> {
  if (_addon !== undefined) return _addon;
  try {
    addonPromise ??= loadNativeImage();
    _addon = await addonPromise;
  } catch (e) {
    addonPromise = undefined;
    console.warn("[native] image addon unavailable — image transforms disabled", e);
    _addon = null;
  }
  return _addon;
}
