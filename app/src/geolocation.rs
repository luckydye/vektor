//! WebKit asks its UI delegate before handing a page the location, through a private selector
//! wry does not answer, so every request was denied. Pages on the app origin are granted it.

use std::{ffi::CStr, os::raw::c_char, sync::OnceLock};

use block2::Block;
use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use url::{Origin, Url};
use wry::{WebView, WebViewExtMacOS};

/// WebKit's `WKPermissionDecision`.
const GRANT: isize = 1;
const DENY: isize = 2;

static APP_ORIGIN: OnceLock<Origin> = OnceLock::new();

/// Takes the class from a live webview's delegate, since wry registers it under a generated name.
pub fn install(webview: &WebView, origin: &Origin) {
    if APP_ORIGIN.set(origin.clone()).is_ok() {
        let delegate: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*webview.webview(), UIDelegate] };
        let class = delegate.expect("wry set no UI delegate").class();
        let imp: unsafe extern "C-unwind" fn(
            &AnyObject,
            Sel,
            &AnyObject,
            &AnyObject,
            &AnyObject,
            &Block<dyn Fn(isize)>,
        ) = request_permission;
        let added = unsafe {
            class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(_webView:requestGeolocationPermissionForOrigin:initiatedByFrame:decisionHandler:),
                std::mem::transmute::<_, Imp>(imp),
                c"v@:@@@@?".as_ptr(),
            )
        };
        assert!(added.as_bool(), "wry already answers geolocation requests");
    }
}

unsafe extern "C-unwind" fn request_permission(
    _: &AnyObject,
    _: Sel,
    _webview: &AnyObject,
    origin: &AnyObject,
    _frame: &AnyObject,
    decide: &Block<dyn Fn(isize)>,
) {
    let protocol = unsafe { string(msg_send![origin, protocol]) };
    let host = unsafe { string(msg_send![origin, host]) };
    let port: isize = unsafe { msg_send![origin, port] };
    let url = match port {
        0 => format!("{protocol}://{host}"),
        port => format!("{protocol}://{host}:{port}"),
    };
    let app_origin = APP_ORIGIN.get().expect("geolocation origin is unset");
    let granted = Url::parse(&url).is_ok_and(|url| url.origin() == *app_origin);
    decide.call((if granted { GRANT } else { DENY },));
}

unsafe fn string(value: *mut AnyObject) -> String {
    let utf8: *const c_char = unsafe { msg_send![value, UTF8String] };
    unsafe { CStr::from_ptr(utf8) }
        .to_string_lossy()
        .into_owned()
}
