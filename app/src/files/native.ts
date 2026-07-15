import type * as NativeImage from "#native/image/generated/index.d.ts";
import { getNativeAddonExport } from "#utils/nativeAddon.ts";

export type NativeAddon = typeof NativeImage;

let _addon: NativeAddon | null | undefined;

export async function getNativeImage(): Promise<NativeAddon | null> {
  if (_addon !== undefined) return _addon;
  try {
    const nativeModule: unknown = await import("./native/addon.ts");
    _addon = getNativeAddonExport<NativeAddon>(nativeModule, {
      addonName: "image",
      exportName: "nativeImage",
      requiredFunction: "transform",
      moduleUrl: import.meta.url,
    });
  } catch (e) {
    console.warn("[native] image addon unavailable — image transforms disabled", e);
    _addon = null;
  }
  return _addon;
}
