import type * as NativeImage from "#native/image/generated/index.d.ts";

export type NativeAddon = typeof NativeImage;

let _addon: NativeAddon | null | undefined;

export function getNativeImage(): NativeAddon | null {
  if (_addon !== undefined) return _addon;
  try {
    // In a compiled binary: build.ts generates native/addon.ts containing a
    // static require() so Bun embeds the .node file into the executable.
    // In dev/tests: the same shim file loads the .node directly from disk.
    // biome-ignore lint/suspicious/noExplicitAny: dynamic module load
    _addon = (require("./native/addon") as any).default as NativeAddon;
  } catch (e) {
    console.warn("[native] image addon unavailable — image transforms disabled", e);
    _addon = null;
  }
  return _addon;
}
