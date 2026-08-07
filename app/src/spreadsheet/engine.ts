import init from "@ironcalc/wasm";
// Vite owns the wasm asset URL, which is correct in both dev and production.
// wasm-bindgen's own `new URL("wasm_bg.wasm", import.meta.url)` guess resolves to
// the wrong path once the package has been pre-bundled.
import wasmUrl from "@ironcalc/wasm/wasm_bg.wasm?url";

let booting: Promise<void> | undefined;

/**
 * Boots the IronCalc WASM engine. Every `Model` call goes through the same
 * instance, so this is memoized — concurrent callers share one fetch, and a
 * failed boot is retried by the next caller rather than cached forever.
 */
export function initEngine(): Promise<void> {
  if (!booting) {
    booting = init(wasmUrl)
      .then(() => undefined)
      .catch((error) => {
        booting = undefined;
        throw error;
      });
  }
  return booting;
}
