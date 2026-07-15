import type * as NativeExec from "#native/exec/index.d.ts";
import { getNativeAddon } from "#utils/nativeAddon.ts";

export type NativeExecAddon = typeof NativeExec;

let addon: NativeExecAddon | undefined;
let addonPromise: Promise<NativeExecAddon> | undefined;

async function loadNativeExec(): Promise<NativeExecAddon> {
  const nativeModule: unknown = await import("./native/addon.ts");
  return getNativeAddon<NativeExecAddon>(nativeModule, {
    addonName: "JavaScript runtime",
    requiredFunction: "evalJsSync",
    moduleUrl: import.meta.url,
  });
}

export async function getNativeExec(): Promise<NativeExecAddon> {
  if (addon) return addon;
  try {
    addonPromise ??= loadNativeExec();
    addon = await addonPromise;
    return addon;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Native JavaScript runtime unavailable${detail}`,
      { cause: error },
    );
  }
}
