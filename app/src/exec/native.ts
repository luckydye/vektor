import type * as NativeExec from "#native/exec/index.d.ts";
import { getNativeAddonExport } from "#utils/nativeAddon.ts";

export type NativeExecAddon = typeof NativeExec;

let addon: NativeExecAddon | undefined;

export async function getNativeExec(): Promise<NativeExecAddon> {
  if (addon) return addon;
  try {
    const nativeModule: unknown = await import("./native/addon.ts");
    addon = getNativeAddonExport<NativeExecAddon>(nativeModule, {
      addonName: "JavaScript runtime",
      exportName: "nativeExec",
      requiredFunction: "evalJsSync",
      moduleUrl: import.meta.url,
    });
    return addon;
  } catch (error) {
    throw new Error(
      "Native JavaScript runtime unavailable — run: cd native/exec && bun run build",
      { cause: error },
    );
  }
}
