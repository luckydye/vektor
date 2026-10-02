//! macOS moves the window from anywhere in the transparent titlebar strip, which swallows tab drags,
//! so the window is created unmovable and the tab bar's background moves it instead.

use gpui::Window;
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSApplication, NSView, NSWindow};
use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub fn ns_window(window: &Window) -> Retained<NSWindow> {
    let handle = HasWindowHandle::window_handle(window).expect("window has no handle");
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        panic!("window is not an AppKit window");
    };
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window().expect("view is not in a window")
}

/// Must run while the mouse-down is being dispatched, since it drags with AppKit's current event.
pub fn drag_window(window: &Window) {
    let main_thread = MainThreadMarker::new().expect("window drags start on the main thread");
    let event = NSApplication::sharedApplication(main_thread)
        .currentEvent()
        .expect("no event is being dispatched");
    ns_window(window).performWindowDragWithEvent(&event);
}
