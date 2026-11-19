# gpui-android

GPUI's Android platform, vendored from shade (`luckydye/shade`, `vendor/gpui-android`),
which vendored it from
[gpui-mobile](https://github.com/longbridge/gpui-mobile) at the commit in
`UPSTREAM_COMMIT` (Apache-2.0). `src/android/`, `fling_guard.rs`,
`frame_pacer.rs` and `platform_view.rs` are upstream's;
`lib.rs` keeps only the crate-root items the Android code uses.

Local changes to upstream files:

- `android/window.rs`: `WgpuContext::new` takes the surface config (gpui-pre 0.3.11).
- `android/window.rs`: `PlatformWindow::insets` reports the safe area (upstream
  only exposes it as `AndroidWindow::safe_area_insets_logical`).
- `android/jni.rs`, `android/window.rs`: the safe area comes from the decor view's
  `WindowInsets` (system bars and cutout) instead of the content rect, which covers
  the whole screen in edge-to-edge windows (target SDK 35+).
- `android/platform.rs`: `Platform::hide` moves the task to the background.
- `android/pinch.rs` (new), `android/window.rs`: two-finger pinches become `PinchEvent`s;
  the touch GPUI was tracking is cancelled when the second finger lands.
- `android/jni.rs`: losing or gaining window focus leaves the window active; only
  pausing and resuming change it. Vektor's webview sits in a panel window above
  the surface and takes the focus whenever it is used.
