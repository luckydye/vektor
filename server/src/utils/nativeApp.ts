/** What the desktop app injects before any page script runs. */
export interface NativeApp {
  version: string;
  /** Rust's `std::env::consts::OS`, e.g. "macos". */
  platform: string;
}

/** A space mounted as a folder by the desktop app. */
export interface NativeMount {
  spaceId: string;
  spaceSlug: string;
  writable: boolean;
  status: "mounting" | "mounted" | "unmounting" | "needs-credentials" | "failed";
  /** Set while mounted. */
  path?: string;
  /** Why mounting failed, or why the last unmount of a still mounted space did not go through. */
  error?: string;
}

/** The `vektor-app:mounts` event's detail. */
export interface NativeMountsPayload {
  mounts: NativeMount[];
  /** Tokens of removed mounts, to delete and then confirm with `tokenRevoked`. */
  revoke: string[];
  /** A failure that belongs to no mount anymore, e.g. cleaning up a removed one. */
  error?: string;
}

/** Messages the desktop app accepts; it answers state requests with a `vektor-app:mounts` event. */
export type NativeAppMessage =
  | { type: "mountsRequest" }
  | {
      type: "mount";
      spaceId: string;
      spaceSlug: string;
      writable: boolean;
      /** Only when the app reported `needs-credentials`; it keeps the token in the keychain. */
      token?: string;
      /** Sent with `token`, so the app can have it revoked when the mount is removed. */
      tokenId?: string;
    }
  | { type: "tokenRevoked"; tokenId: string }
  | { type: "unmount"; spaceId: string }
  | { type: "revealMount"; spaceId: string };

declare global {
  interface Window {
    vektorApp?: NativeApp;
    /** The desktop app's message channel. */
    ipc?: { postMessage(message: string): void };
  }
}

/** The desktop app hosting this page; undefined in a regular browser and during SSR. */
export function nativeApp(): NativeApp | undefined {
  return typeof window === "undefined" ? undefined : window.vektorApp;
}

export function postToNativeApp(message: NativeAppMessage) {
  if (!window.ipc) throw new Error("not running in the desktop app");
  window.ipc.postMessage(JSON.stringify(message));
}
