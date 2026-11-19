//! Vektor for touch devices (iOS, Android): the web UI in the platform's own webview, inside a
//! GPUI window that keeps it clear of the system bars and paints them in the page's colours.
//! `main.rs` starts it on iOS (and on a desktop while developing), `android_main` on Android.

pub mod app;
pub mod shell;

#[cfg(target_os = "android")]
pub mod android;
#[cfg(target_os = "android")]
pub use android::Page;

#[cfg(not(target_os = "android"))]
pub mod webview;
#[cfg(not(target_os = "android"))]
pub use webview::Page;

use crate::shell::PageMessage;
use futures::channel::mpsc;

/// Baked in at build time, so a plain build targets production.
pub const URL: &str = match option_env!("VEKTOR_URL") {
    Some(url) => url,
    None => "https://app.vektorapp.org",
};

/// What the page and the system ask of the app. Webview callbacks fire outside GPUI's update
/// cycle, so they are funnelled through a channel.
pub enum PageEvent {
    Message(PageMessage),
    /// The page opened an app page in a new window; there are no tabs, so it opens in place.
    Navigate(String),
    OpenExternal(String),
    /// The page's main frame started loading `url`, off the app's origin.
    LeftOrigin(String),
    /// A link to the app's URL scheme, e.g. a browser sign-in handing back its code.
    Opened(String),
}

/// Run the app on `application` until it quits.
pub fn run(application: gpui::Application) {
    let url = url::Url::parse(URL).expect("VEKTOR_URL is not a URL");
    let (events, receiver) = mpsc::unbounded();
    let links = events.clone();
    application.on_open_urls(move |urls| {
        for url in urls {
            let _ = links.unbounded_send(PageEvent::Opened(url));
        }
    });
    application.run(move |cx| {
        app::MobileApp::open_window(url, events, receiver, cx);
        cx.activate(true);
    });
}
