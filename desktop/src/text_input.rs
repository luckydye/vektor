//! gpui's view feeds arrow keys to its own text input context even while a webview has focus,
//! which steals the active context from WebKit so it inserts raw key characters instead of text.

use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ClassType, msg_send, sel};
use objc2_app_kit::NSView;

/// Gives gpui's view a text input context only while it holds keyboard focus.
pub fn install() {
    let class = AnyClass::get(c"GPUIView").expect("gpui view class is not registered");
    let imp: unsafe extern "C-unwind" fn(&NSView, Sel) -> *mut AnyObject = input_context;
    let added = unsafe {
        class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(inputContext),
            std::mem::transmute::<_, Imp>(imp),
            c"@@:".as_ptr(),
        )
    };
    assert!(added.as_bool(), "gpui view already overrides inputContext");
}

unsafe extern "C-unwind" fn input_context(view: &NSView, _: Sel) -> *mut AnyObject {
    let focused = view
        .window()
        .and_then(|window| window.firstResponder())
        .is_some_and(|responder| std::ptr::addr_eq(&*responder, view));
    if !focused {
        return std::ptr::null_mut();
    }
    unsafe { msg_send![super(view, NSView::class()), inputContext] }
}
