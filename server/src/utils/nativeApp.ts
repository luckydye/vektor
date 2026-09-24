/** What the desktop app injects before any page script runs. */
export interface NativeApp {
  version: string;
  /** Rust's `std::env::consts::OS`, e.g. "macos". */
  platform: string;
}

declare global {
  interface Window {
    vektorApp?: NativeApp;
  }
}

/** The desktop app hosting this page; undefined in a regular browser and during SSR. */
export function nativeApp(): NativeApp | undefined {
  return typeof window === "undefined" ? undefined : window.vektorApp;
}
