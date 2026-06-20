import type * as NativeExec from "../../native/exec/index.d.ts";

export type NativeExecAddon = typeof NativeExec;

let addon: NativeExecAddon | undefined;

export function getNativeExec(): NativeExecAddon {
  if (addon) return addon;
  try {
    // build.ts generates this static require so Bun embeds the .node addon.
    // biome-ignore lint/suspicious/noExplicitAny: generated native module
    addon = (require("./native/addon") as any).default as NativeExecAddon;
    return addon;
  } catch (error) {
    throw new Error(
      "Native JavaScript runtime unavailable — run: cd native/exec && bun run build",
      { cause: error },
    );
  }
}
