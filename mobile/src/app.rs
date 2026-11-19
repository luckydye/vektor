//! The window: the page fills the safe area, and the system bars around it take on the colour of
//! the page's top edge, as the desktop app's tab bar does.

use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender};
use gpui::{
    App, Bounds, Context, Task, Window, WindowBounds, WindowOptions, canvas, div, prelude::*, px,
    rgb, size,
};
use url::Url;
use vektor_shell::{PageMessage, SignIn, may_open_externally, sign_in_code};

use crate::{Page, PageEvent};

/// Window size when the touch UI runs on a desktop during development.
pub const DEVELOPMENT_WINDOW: (f32, f32) = (393., 852.);

pub struct MobileApp {
    pub page: Page,
    pub url: Url,
    /// Colour of the page's top edge, which the system bars take on.
    pub chrome: u32,
    /// The browser sign-in in progress.
    pub sign_in: Option<SignIn>,
    pub _events: Task<()>,
}

impl MobileApp {
    pub fn open_window(
        url: Url,
        events: UnboundedSender<PageEvent>,
        receiver: UnboundedReceiver<PageEvent>,
        cx: &mut App,
    ) {
        let options = match cfg!(any(target_os = "ios", target_os = "android")) {
            true => WindowOptions::default(),
            false => {
                let (width, height) = DEVELOPMENT_WINDOW;
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(width), px(height)),
                        cx,
                    ))),
                    ..Default::default()
                }
            }
        };
        cx.open_window(options, |window, cx| {
            cx.new(|cx| MobileApp::new(url, events, receiver, window, cx))
        })
        .expect("failed to open main window");
    }

    pub fn new(
        url: Url,
        events: UnboundedSender<PageEvent>,
        mut receiver: UnboundedReceiver<PageEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let page = Page::new(&url, events, window);
        let pump = cx.spawn(async move |this, cx| {
            while let Some(event) = receiver.next().await {
                if this.update(cx, |this, cx| this.handle(event, cx)).is_err() {
                    break;
                }
            }
        });
        let chrome = 0xffffff;
        Page::style_system_bars(is_light(chrome));
        Self {
            page,
            url,
            chrome,
            sign_in: None,
            _events: pump,
        }
    }

    pub fn handle(&mut self, event: PageEvent, cx: &mut Context<Self>) {
        match event {
            PageEvent::Message(PageMessage::ChromeColor { color: [r, g, b] }) => {
                self.chrome = u32::from_be_bytes([0, r, g, b]);
                Page::style_system_bars(is_light(self.chrome));
                cx.notify();
            }
            PageEvent::Message(PageMessage::BrowserSignIn) => {
                let (sign_in, url) = SignIn::start(&self.url);
                self.sign_in = Some(sign_in);
                open_external(url.as_str(), cx);
            }
            // Mounts and the location bridge belong to the desktop app; the phone's webview has
            // geolocation of its own.
            PageEvent::Message(_) => {}
            PageEvent::Navigate(url) => self.page.load(&url),
            PageEvent::OpenExternal(url) => open_external(&url, cx),
            PageEvent::LeftOrigin(url) => {
                open_external(&url, cx);
                self.page.evaluate("history.back()");
            }
            PageEvent::Opened(link) => self.complete_sign_in(&link),
        }
    }

    /// `vektor-desktop://auth?code=…` from the browser. Links this app did not ask for find no
    /// sign-in in progress and are ignored.
    pub fn complete_sign_in(&mut self, link: &str) {
        let Some(code) = sign_in_code(link) else {
            return;
        };
        let Some(sign_in) = self.sign_in.take() else {
            return;
        };
        self.page.load(sign_in.complete(&self.url, &code).as_str());
    }
}

pub fn is_light(color: u32) -> bool {
    let [_, r, g, b] = color.to_be_bytes();
    0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b) > 127.5
}

pub fn open_external(url: &str, cx: &App) {
    if may_open_externally(url) {
        cx.open_url(url);
    }
}

impl Render for MobileApp {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let safe = window.insets().safe_area;
        let page = self.page.clone();
        div()
            .size_full()
            .bg(rgb(self.chrome))
            .pt(safe.top)
            .pr(safe.right)
            .pb(safe.bottom)
            .pl(safe.left)
            .child(
                // The native webview sits on top of this area and follows its layout bounds.
                canvas(
                    move |bounds, window, _| page.place(bounds, window.scale_factor()),
                    |_, _, _, _| {},
                )
                .size_full(),
            )
    }
}
