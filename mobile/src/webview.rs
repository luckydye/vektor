//! The page in WebKit through wry, on iOS and in the development window on macOS. The webview is
//! a child of GPUI's view, laid over the area GPUI lays out for it.

use std::rc::Rc;

use futures::channel::mpsc::UnboundedSender;
use gpui::{Bounds, Pixels, Window};
use url::Url;
use vektor_shell::{CHROME_COLOR_SCRIPT, is_internal, native_app_script};
use wry::http::Request;
use wry::{NewWindowResponse, PageLoadEvent, WebView, WebViewBuilder};

use crate::PageEvent;

#[derive(Clone)]
pub struct Page(Rc<WebView>);

impl Page {
    pub fn new(url: &Url, events: UnboundedSender<PageEvent>, window: &Window) -> Self {
        let ipc = events.clone();
        let opener = events.clone();
        let loads = events;
        let ipc_origin = url.origin();
        let opener_origin = url.origin();
        let load_origin = url.origin();
        let webview = WebViewBuilder::new()
            .with_url(url.as_str())
            .with_devtools(cfg!(debug_assertions))
            .with_initialization_script(native_app_script(env!("CARGO_PKG_VERSION")))
            .with_initialization_script(CHROME_COLOR_SCRIPT)
            .with_ipc_handler(move |request: Request<String>| {
                if !is_internal(&ipc_origin, &request.uri().to_string()) {
                    return;
                }
                // The page is untrusted: anything that does not parse is dropped.
                if let Ok(message) = serde_json::from_str(request.body()) {
                    let _ = ipc.unbounded_send(PageEvent::Message(message));
                }
            })
            .with_new_window_req_handler(move |url, _| {
                let event = if is_internal(&opener_origin, &url) {
                    PageEvent::Navigate(url)
                } else {
                    PageEvent::OpenExternal(url)
                };
                let _ = opener.unbounded_send(event);
                NewWindowResponse::Deny
            })
            // The navigation handler also sees iframes (e.g. Figma embeds), so the origin is
            // enforced on committed main-frame loads instead.
            .with_on_page_load_handler(move |event, url| {
                if matches!(event, PageLoadEvent::Started) && !is_internal(&load_origin, &url) {
                    let _ = loads.unbounded_send(PageEvent::LeftOrigin(url));
                }
            })
            .build_as_child(window)
            .expect("failed to create webview");
        Self(Rc::new(webview))
    }

    /// Places the page at `bounds`, in the window's logical pixels.
    pub fn place(&self, bounds: Bounds<Pixels>, _scale: f32) {
        let [x, y, width, height] = [
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        ]
        .map(|value| f64::from(f32::from(value)));
        // wry only positions child webviews on macOS; on iOS the frame is set directly, in the
        // top-left coordinates GPUI uses too.
        #[cfg(target_os = "ios")]
        {
            use objc2_core_foundation::{CGPoint, CGRect, CGSize};
            use wry::WebViewExtIOS as _;
            self.0
                .webview()
                .setFrame(CGRect::new(CGPoint::new(x, y), CGSize::new(width, height)));
        }
        #[cfg(not(target_os = "ios"))]
        self.0
            .set_bounds(wry::Rect {
                position: wry::dpi::LogicalPosition::new(x, y).into(),
                size: wry::dpi::LogicalSize::new(width, height).into(),
            })
            .expect("failed to position webview");
    }

    pub fn load(&self, url: &str) {
        self.0.load_url(url).expect("failed to load page");
    }

    pub fn evaluate(&self, script: &str) {
        self.0
            .evaluate_script(script)
            .expect("failed to run script in page");
    }

    /// Status bar content that reads on a light or a dark page.
    #[cfg(target_os = "ios")]
    pub fn style_system_bars(light: bool) {
        gpui_ios::ios::set_status_bar_style(match light {
            true => gpui_ios::StatusBarContentStyle::Dark,
            false => gpui_ios::StatusBarContentStyle::Light,
        });
    }

    /// The development window has no system bars.
    #[cfg(not(target_os = "ios"))]
    pub fn style_system_bars(_light: bool) {}
}
