use std::{
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

use futures::{StreamExt, channel::mpsc};
use gpui::{
    App, Bounds, Context, DispatchPhase, FocusHandle, Global, IntoElement, KeyDownEvent,
    MouseButton, MouseMoveEvent, MouseUpEvent, Pixels, Point, Render, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, actions, canvas, div,
    point, prelude::*, px, rgb, size,
};
use objc2::rc::Retained;
use objc2_app_kit::NSEvent;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Origin, Url};
use wry::http::Request;
use wry::{
    NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder, WebViewExtMacOS,
    dpi::{LogicalPosition, LogicalSize},
};

use crate::{
    Paste,
    find_bar::FindBar,
    geolocation,
    mounts::{MountConfig, Mounts, is_plain_name, mountpoint, support_dir, write},
    palette::Palette,
    tab_bar::{self, TabBar, TabLabel},
    titlebar::ns_window,
};

actions!(
    browser,
    [
        NewTab,
        CloseTab,
        NextTab,
        PreviousTab,
        Reload,
        ToggleDevTools,
        Find,
        FindNext,
        FindPrevious,
        DismissFind
    ]
);

/// WebKit only turns `target=_blank` into a new-window request, so modifier/middle clicks and
/// links off the Vektor origin are rerouted through `window.open`.
const LINK_SCRIPT: &str = r#"
for (const type of ["click", "auxclick"]) {
  window.addEventListener(type, (event) => {
    if (event.defaultPrevented || event.button > 1) return;
    const anchor = event.target instanceof Element && event.target.closest("a[href]");
    // Editable documents open their own links on modifier clicks.
    if (!anchor || anchor.isContentEditable) return;
    const url = new URL(anchor.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin === location.origin && !event.metaKey && event.button === 0) return;
    event.preventDefault();
    window.open(url.href, "_blank");
  });
}
"#;

/// macOS WebKit has no native switch for rubber-banding; every scroller opts out instead, which
/// also stops scroll chaining, as in native apps.
const OVERSCROLL_SCRIPT: &str = r#"
{
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("* { overscroll-behavior: none; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
"#;

/// In-page search behind the find bar. Matches are painted with the CSS Custom Highlight API so
/// the page's DOM and selection stay untouched; returns "current/total".
const FIND_SCRIPT: &str = r#"
{
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    ::highlight(vektor-find) { background-color: rgb(255 214 0 / 0.4); }
    ::highlight(vektor-find-current) { background-color: rgb(255 150 0 / 0.8); }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  let last = "";
  let index = 0;
  window.__vektorFind = (query, step) => {
    const needle = query.toLowerCase();
    const ranges = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); needle && node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, noscript") || !parent.checkVisibility()) continue;
      const text = node.data.toLowerCase();
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
      }
    }
    index = query === last && ranges.length ? (index + step + ranges.length) % ranges.length : 0;
    last = query;
    CSS.highlights.set("vektor-find", new Highlight(...ranges));
    CSS.highlights.set("vektor-find-current", new Highlight(...ranges.slice(index, index + 1)));
    ranges[index]?.startContainer.parentElement.scrollIntoView({ block: "center" });
    return `${ranges.length ? index + 1 : 0}/${ranges.length}`;
  };
}
"#;

/// Reports the colour of the page's top pixel row so the chrome can blend into it. The layers
/// under that row are composited on a canvas, which also resolves any CSS colour syntax.
const CHROME_COLOR_SCRIPT: &str = r##"
{
  const context = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  let last = "";
  const sample = () => {
    context.globalAlpha = 1;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 1, 1);
    for (const element of document.elementsFromPoint(innerWidth / 2, 0).reverse()) {
      const style = getComputedStyle(element);
      context.globalAlpha = Number(style.opacity);
      context.fillStyle = style.backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    const color = `${r},${g},${b}`;
    if (color !== last) {
      last = color;
      window.ipc.postMessage(JSON.stringify({ type: "chromeColor", color: [r, g, b] }));
    }
  };
  // Keeps sampling briefly after each change so fades (e.g. dialog backdrops) are followed.
  let until = 0;
  let frame = 0;
  const tick = (now) => {
    sample();
    frame = now < until ? requestAnimationFrame(tick) : 0;
  };
  const schedule = () => {
    until = performance.now() + 400;
    frame ||= requestAnimationFrame(tick);
  };
  new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
  addEventListener("resize", schedule);
  schedule();
}
"##;

/// Webview callbacks fire outside gpui's update cycle, so they are funnelled through a channel
/// and delivered to whichever window holds the tab by then.
pub enum TabEvent {
    TitleChanged(u64, String),
    /// A link in the tab asked for a new tab, which opens in the same window.
    OpenTab(u64, String),
    OpenExternal(String),
    LeftOrigin(u64, String),
    FindResult(u64, String),
    Page(u64, PageMessage),
}

/// Messages a page sends with `window.ipc.postMessage(JSON.stringify(message))`.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PageMessage {
    ChromeColor {
        color: [u8; 3],
    },
    /// Asks for a `vektor-app:mounts` event with the current mounts.
    MountsRequest,
    Mount {
        space_id: String,
        space_slug: String,
        writable: bool,
        /// A freshly minted access token, when the app reported it has none for the space.
        token: Option<String>,
        /// The id of `token`, so the token can be revoked when the mount is removed.
        token_id: Option<String>,
    },
    /// The login page wants OAuth, which only works in the system browser.
    BrowserSignIn,
    /// The web UI deleted a token listed in the payload's `revoke`.
    TokenRevoked {
        token_id: String,
    },
    Unmount {
        space_id: String,
    },
    RevealMount {
        space_id: String,
    },
}

pub struct TabEvents(pub mpsc::UnboundedSender<TabEvent>);

impl Global for TabEvents {}

/// Tab ids are unique across windows, so events still find a tab that moved to another window.
static NEXT_TAB_ID: AtomicU64 = AtomicU64::new(0);

/// The open windows and their tabs, restored on the next launch.
#[derive(Serialize, Deserialize, Default)]
pub struct Session {
    #[serde(default)]
    pub windows: Vec<WindowSession>,
}

#[derive(Serialize, Deserialize)]
pub struct WindowSession {
    pub tabs: Vec<String>,
    pub active: usize,
}

pub fn session_path() -> PathBuf {
    support_dir().join("session.json")
}

pub struct FindState {
    pub query: String,
    pub result: Option<SharedString>,
}

/// Announces the desktop app to the web UI as `window.vektorApp`, before any page script runs.
pub fn native_app_script() -> String {
    format!(
        "Object.defineProperty(window, 'vektorApp', {{ value: Object.freeze({{ version: {:?}, platform: {:?} }}) }});",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
    )
}

pub fn is_internal(origin: &Origin, url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| url.origin() == *origin)
}

pub struct Tab {
    pub id: u64,
    pub title: SharedString,
    pub webview: Rc<WebView>,
    /// The URL the tab was opened with, which it reports until its first load commits.
    pub url: String,
    /// Colour of the page's top edge, which the chrome takes on while this tab is active.
    pub chrome: u32,
}

pub struct Browser {
    pub url: String,
    /// The only origin a tab's main frame may show; everything else opens in the system browser.
    pub origin: Origin,
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// Open while the find bar is shown.
    pub find: Option<FindState>,
    pub find_focus: FocusHandle,
    /// Secret of the browser sign-in in progress; only its hash ever leaves the app.
    pub sign_in_verifier: Option<String>,
    /// Set while a tab of this window is being dragged.
    pub drag: Option<TabDrag>,
}

pub struct TabDrag {
    pub id: u64,
    /// Where the pointer holds the tab, relative to the tab's top-left corner.
    pub grab: Point<Pixels>,
    /// The window the tab was torn off into; it follows the pointer until the drag ends.
    pub torn: Option<WindowHandle<Browser>>,
}

/// Where a new window's tabs come from.
pub enum TabSource {
    Url(String),
    /// A live tab moved over from another window, page state and all.
    Moved(Tab),
}

pub fn browsers(cx: &App) -> Vec<WindowHandle<Browser>> {
    cx.windows()
        .into_iter()
        .filter_map(|window| window.downcast::<Browser>())
        .collect()
}

pub fn window_options(bounds: Bounds<Pixels>, focus: bool) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("Vektor".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(18.), px(18.))),
        }),
        focus,
        window_min_size: Some(size(px(480.), px(320.))),
        is_movable: false,
        ..Default::default()
    }
}

pub fn open_browser(
    url: String,
    tabs: Vec<TabSource>,
    active: usize,
    options: WindowOptions,
    cx: &mut App,
) -> WindowHandle<Browser> {
    cx.open_window(options, |window, cx| {
        cx.new(|cx| {
            let mut browser = Browser::new(url, window, cx);
            for tab in tabs {
                match tab {
                    TabSource::Url(url) => browser.open_tab(&url, window, cx),
                    TabSource::Moved(tab) => browser.adopt_tab(tab, window, cx),
                }
            }
            browser.activate(active, cx);
            browser
        })
    })
    .expect("failed to open window")
}

/// Starts delivering webview callbacks to the windows holding their tabs.
pub fn route_tab_events(cx: &mut App) {
    let (events, mut receiver) = mpsc::unbounded();
    cx.set_global(TabEvents(events));
    cx.spawn(async move |cx| {
        while let Some(event) = receiver.next().await {
            cx.update(|cx| deliver(event, cx))
                .expect("app quit while delivering a tab event");
        }
    })
    .detach();
}

fn deliver(event: TabEvent, cx: &mut App) {
    let id = match &event {
        TabEvent::OpenExternal(url) => return open_external(url, cx),
        TabEvent::TitleChanged(id, _)
        | TabEvent::OpenTab(id, _)
        | TabEvent::LeftOrigin(id, _)
        | TabEvent::FindResult(id, _)
        | TabEvent::Page(id, _) => *id,
    };
    // Events can land after their tab was closed.
    let Some(browser) = browsers(cx).into_iter().find(|browser| {
        browser
            .read(cx)
            .is_ok_and(|browser| browser.tabs.iter().any(|tab| tab.id == id))
    }) else {
        return;
    };
    browser
        .update(cx, |this, window, cx| match event {
            TabEvent::OpenExternal(_) => unreachable!("handled above"),
            TabEvent::TitleChanged(id, title) => this.set_title(id, title, cx),
            TabEvent::OpenTab(_, url) => this.open_tab(&url, window, cx),
            TabEvent::LeftOrigin(id, url) => this.return_to_origin(id, &url, cx),
            TabEvent::FindResult(id, result) => this.set_find_result(id, &result, cx),
            TabEvent::Page(id, message) => this.handle_page_message(id, message, cx),
        })
        .expect("browser window vanished while delivering a tab event");
}

/// Writes the session of every open window; quitting keeps the windows alive until this runs.
pub fn save_session(cx: &App) {
    let windows = browsers(cx)
        .iter()
        .map(|browser| browser.read(cx).expect("browser is readable").session())
        .collect();
    write(session_path(), &Session { windows });
}

impl Browser {
    pub fn new(url: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe_global::<Mounts>(|this, cx| this.broadcast_mounts(cx))
            .detach();
        let this = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            this.update(cx, |this, cx| this.save_if_last(cx))
                .expect("browser outlives its window");
            true
        });

        Self {
            origin: Url::parse(&url).expect("VEKTOR_URL is not a URL").origin(),
            tabs: Vec::new(),
            active: 0,
            url,
            find: None,
            find_focus: cx.focus_handle(),
            sign_in_verifier: None,
            drag: None,
        }
    }

    pub fn session(&self) -> WindowSession {
        WindowSession {
            tabs: self
                .tabs
                .iter()
                // wry's `url()` panics on the nil URL of a tab whose first load failed.
                .map(|tab| match unsafe { tab.webview.webview().URL() } {
                    Some(url) => url
                        .absoluteString()
                        .expect("webview URL has no string")
                        .to_string(),
                    None => tab.url.clone(),
                })
                .collect(),
            active: self.active,
        }
    }

    /// Closing a window forgets its tabs, unless it is the last one.
    pub fn save_if_last(&self, cx: &App) {
        if browsers(cx).len() == 1 {
            let windows = vec![self.session()];
            write(session_path(), &Session { windows });
        }
    }

    pub fn open_tab(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        let id = NEXT_TAB_ID.fetch_add(1, Ordering::Relaxed);
        let events = &cx.global::<TabEvents>().0;
        let titles = events.clone();
        let opener = events.clone();
        let loads = events.clone();
        let ipc = events.clone();
        let opener_origin = self.origin.clone();
        let load_origin = self.origin.clone();
        let ipc_origin = self.origin.clone();
        let webview = WebViewBuilder::new()
            .with_url(url)
            .with_devtools(true)
            .with_accept_first_mouse(true)
            .with_bounds(Rect::default())
            .with_initialization_script(native_app_script())
            .with_initialization_script(LINK_SCRIPT)
            .with_initialization_script(OVERSCROLL_SCRIPT)
            .with_initialization_script(FIND_SCRIPT)
            .with_initialization_script(CHROME_COLOR_SCRIPT)
            .with_ipc_handler(move |request: Request<String>| {
                if !is_internal(&ipc_origin, &request.uri().to_string()) {
                    return;
                }
                // The page is untrusted: anything that does not parse is dropped.
                if let Ok(message) = serde_json::from_str(request.body()) {
                    let _ = ipc.unbounded_send(TabEvent::Page(id, message));
                }
            })
            .with_document_title_changed_handler(move |title| {
                let _ = titles.unbounded_send(TabEvent::TitleChanged(id, title));
            })
            .with_new_window_req_handler(move |url, _| {
                let event = if is_internal(&opener_origin, &url) {
                    TabEvent::OpenTab(id, url)
                } else {
                    TabEvent::OpenExternal(url)
                };
                let _ = opener.unbounded_send(event);
                NewWindowResponse::Deny
            })
            // The navigation handler also sees iframes (e.g. Figma embeds), so the origin is
            // enforced on committed main-frame loads instead.
            .with_on_page_load_handler(move |event, url| {
                if matches!(event, PageLoadEvent::Started) && !is_internal(&load_origin, &url) {
                    let _ = loads.unbounded_send(TabEvent::LeftOrigin(id, url));
                }
            })
            .build_as_child(window)
            .expect("failed to create webview");
        geolocation::install(&self.origin);

        self.tabs.push(Tab {
            id,
            url: url.into(),
            title: "Vektor".into(),
            webview: Rc::new(webview),
            chrome: 0xffffff,
        });
        self.activate(self.tabs.len() - 1, cx);
    }

    pub fn adopt_tab(&mut self, tab: Tab, window: &mut Window, cx: &mut Context<Self>) {
        tab.webview
            .reparent(Retained::as_ptr(&ns_window(window)).cast_mut())
            .expect("failed to move webview");
        self.tabs.push(tab);
        self.activate(self.tabs.len() - 1, cx);
    }

    pub fn activate(&mut self, index: usize, cx: &mut Context<Self>) {
        assert!(index < self.tabs.len(), "tab index {index} out of range");
        self.active = index;
        for (i, tab) in self.tabs.iter().enumerate() {
            tab.webview
                .set_visible(i == index)
                .expect("failed to toggle webview");
        }
        self.tabs[index]
            .webview
            .focus()
            .expect("failed to focus webview");
        if self.find.is_some() {
            self.search(0, cx);
        }
        cx.notify();
    }

    pub fn close(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.remove_tab(index, cx);
        if self.tabs.is_empty() {
            self.save_if_last(cx);
            window.remove_window();
        }
    }

    /// Takes the tab out of this window, keeping the active one selected unless it is the one leaving.
    pub fn remove_tab(&mut self, index: usize, cx: &mut Context<Self>) -> Tab {
        let tab = self.tabs.remove(index);
        if !self.tabs.is_empty() {
            let active = if index < self.active {
                self.active - 1
            } else {
                self.active
            };
            self.activate(active.min(self.tabs.len() - 1), cx);
        }
        tab
    }

    pub fn start_drag(&mut self, index: usize, grab: Point<Pixels>) {
        self.drag = Some(TabDrag {
            id: self.tabs[index].id,
            grab,
            torn: None,
        });
    }

    /// Pulling a tab out of the tab bar moves it into a window of its own under the pointer.
    pub fn drag_moved(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let drag = self.drag.as_ref().expect("no tab is being dragged");
        if let Some(torn) = drag.torn {
            let grab = drag.grab;
            torn.update(cx, |_, window, _| follow_pointer(grab, window))
                .expect("torn-off window closed mid-drag");
            return;
        }
        let viewport = window.viewport_size();
        let in_bar = (px(-24.)..px(72.)).contains(&position.y)
            && (px(0.)..viewport.width).contains(&position.x);
        if in_bar || self.tabs.len() == 1 {
            return;
        }
        let index = self
            .tabs
            .iter()
            .position(|tab| tab.id == drag.id)
            .expect("dragged tab vanished");
        let grab = drag.grab;
        let tab = self.remove_tab(index, cx);
        // The drag goes on in the new window, so this window's preview and drop targets end here.
        cx.stop_active_drag(window);
        let bounds = Bounds::new(point(px(0.), px(0.)), window.bounds().size);
        let torn = open_browser(
            self.url.clone(),
            vec![TabSource::Moved(tab)],
            0,
            window_options(bounds, false),
            cx,
        );
        torn.update(cx, |_, window, _| follow_pointer(grab, window))
            .expect("torn-off window closed while opening");
        self.drag
            .as_mut()
            .expect("drag ended while tearing off")
            .torn = Some(torn);
    }

    pub fn end_drag(&mut self, cx: &mut Context<Self>) {
        let drag = self.drag.take().expect("no tab is being dragged");
        if let Some(torn) = drag.torn {
            torn.update(cx, |_, window, _| window.activate_window())
                .expect("torn-off window closed mid-drag");
        }
        cx.notify();
    }

    pub fn move_tab(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        let active = self.tabs[self.active].id;
        let tab = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        self.active = self
            .tabs
            .iter()
            .position(|tab| tab.id == active)
            .expect("active tab vanished while moving");
        cx.notify();
    }

    pub fn set_title(&mut self, id: u64, title: String, cx: &mut Context<Self>) {
        // A title can arrive after its tab was closed.
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) {
            tab.title = title.into();
            cx.notify();
        }
    }

    pub fn handle_page_message(&mut self, id: u64, message: PageMessage, cx: &mut Context<Self>) {
        match message {
            PageMessage::ChromeColor { color: [r, g, b] } => {
                self.set_chrome(id, u32::from_be_bytes([0, r, g, b]), cx)
            }
            PageMessage::MountsRequest => self.broadcast_mounts_to(id, cx),
            PageMessage::Mount {
                space_id,
                space_slug,
                writable,
                token,
                token_id,
            } => {
                let token_id_ok = token_id.as_deref().is_none_or(is_plain_name);
                if !is_plain_name(&space_id)
                    || !is_plain_name(&space_slug)
                    || !token_id_ok
                    || token.is_some() != token_id.is_some()
                {
                    return;
                }
                cx.update_global::<Mounts, _>(|mounts, _| {
                    let config = MountConfig {
                        origin: mounts.origin.clone(),
                        space_id,
                        space_slug,
                        writable,
                        token_id,
                    };
                    mounts.mount(config, token);
                });
            }
            PageMessage::BrowserSignIn => self.start_browser_sign_in(cx),
            PageMessage::TokenRevoked { token_id } => {
                cx.update_global::<Mounts, _>(|mounts, _| mounts.revoked(&token_id))
            }
            PageMessage::Unmount { space_id } => {
                cx.update_global::<Mounts, _>(|mounts, _| mounts.unmount(&space_id))
            }
            PageMessage::RevealMount { space_id } => {
                if let Some(entry) = cx.global::<Mounts>().entries.get(&space_id) {
                    cx.reveal_path(&mountpoint(&entry.config));
                }
            }
        }
    }

    /// The server's `desktopAuth` plugin holds the other half of this exchange.
    pub fn start_browser_sign_in(&mut self, cx: &mut Context<Self>) {
        let verifier = hex::encode(rand::random::<[u8; 32]>());
        let challenge = hex::encode(Sha256::digest(verifier.as_bytes()));
        self.sign_in_verifier = Some(verifier);
        let mut url = Url::parse(&self.url).expect("VEKTOR_URL is not a URL");
        url.set_path("/desktop-login");
        url.set_query(Some(&format!("challenge={challenge}")));
        open_external(url.as_str(), cx);
    }

    /// `vektor-desktop://auth?code=…` from the browser. Links this app did not ask for find no
    /// verifier and are ignored.
    pub fn complete_sign_in(&mut self, link: &str, cx: &mut Context<Self>) {
        let Ok(link) = Url::parse(link) else {
            return;
        };
        let Some(code) = link
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, code)| code.into_owned())
        else {
            return;
        };
        if link.scheme() != "vektor-desktop" || link.host_str() != Some("auth") {
            return;
        }
        let Some(verifier) = self.sign_in_verifier.take() else {
            return;
        };
        let mut url = Url::parse(&self.url).expect("VEKTOR_URL is not a URL");
        url.set_path("/api/auth/desktop-handoff/complete");
        url.query_pairs_mut()
            .append_pair("code", &code)
            .append_pair("verifier", &verifier);
        self.tabs[self.active]
            .webview
            .load_url(url.as_str())
            .expect("failed to load sign-in");
        cx.activate(true);
    }

    pub fn mounts_script(&self, cx: &Context<Self>) -> String {
        let states = serde_json::to_string(&cx.global::<Mounts>().payload())
            .expect("mount states serialize");
        format!(
            "window.dispatchEvent(new CustomEvent('vektor-app:mounts', {{ detail: {states} }}))"
        )
    }

    pub fn broadcast_mounts(&self, cx: &Context<Self>) {
        let script = self.mounts_script(cx);
        for tab in &self.tabs {
            tab.webview
                .evaluate_script(&script)
                .expect("failed to send mounts to page");
        }
    }

    pub fn broadcast_mounts_to(&self, id: u64, cx: &Context<Self>) {
        if let Some(tab) = self.tabs.iter().find(|tab| tab.id == id) {
            tab.webview
                .evaluate_script(&self.mounts_script(cx))
                .expect("failed to send mounts to page");
        }
    }

    pub fn set_chrome(&mut self, id: u64, color: u32, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) {
            tab.chrome = color;
            cx.notify();
        }
    }

    pub fn return_to_origin(&mut self, id: u64, url: &str, cx: &mut Context<Self>) {
        open_external(url, cx);
        if let Some(tab) = self.tabs.iter().find(|tab| tab.id == id) {
            tab.webview
                .evaluate_script("history.back()")
                .expect("failed to navigate back");
        }
    }

    /// Moves keyboard input from the webview to the find field.
    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find.get_or_insert(FindState {
            query: String::new(),
            result: None,
        });
        self.tabs[self.active]
            .webview
            .focus_parent()
            .expect("failed to focus find bar");
        window.focus(&self.find_focus);
        self.search(0, cx);
        cx.notify();
    }

    pub fn dismiss_find(&mut self, cx: &mut Context<Self>) {
        self.find = None;
        for tab in &self.tabs {
            tab.webview
                .evaluate_script("__vektorFind('', 0)")
                .expect("failed to clear find highlights");
        }
        self.tabs[self.active]
            .webview
            .focus()
            .expect("failed to focus webview");
        cx.notify();
    }

    pub fn edit_find(&mut self, edit: impl FnOnce(&mut String), cx: &mut Context<Self>) {
        edit(&mut self.find.as_mut().expect("find bar is closed").query);
        self.search(0, cx);
        cx.notify();
    }

    /// `step` moves between matches; 0 re-runs the query in place.
    pub fn search(&self, step: i32, cx: &App) {
        let find = self.find.as_ref().expect("find bar is closed");
        let tab = &self.tabs[self.active];
        let id = tab.id;
        let events = cx.global::<TabEvents>().0.clone();
        // Rust's debug escaping of a string is a valid JavaScript string literal.
        let script = format!("__vektorFind({:?}, {step})", find.query);
        tab.webview
            .evaluate_script_with_callback(&script, move |result| {
                let _ = events.unbounded_send(TabEvent::FindResult(id, result));
            })
            .expect("failed to search page");
    }

    pub fn set_find_result(&mut self, id: u64, result: &str, cx: &mut Context<Self>) {
        // Results can land after the bar closed or the tab lost focus.
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if self.tabs[self.active].id != id {
            return;
        }
        let (current, total) = result
            .trim_matches('"')
            .split_once('/')
            .expect("malformed find result");
        find.result = match (find.query.is_empty(), total) {
            (true, _) => None,
            (false, "0") => Some("No results".into()),
            (false, _) => Some(format!("{current} of {total}").into()),
        };
        cx.notify();
    }

    pub fn find_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if keystroke.key == "backspace" {
            self.edit_find(
                |query| {
                    if modifiers.platform {
                        query.clear();
                    } else {
                        query.pop();
                    }
                },
                cx,
            );
        } else if let Some(text) = keystroke.key_char.as_ref().filter(|text| {
            !modifiers.platform && !modifiers.control && !text.chars().any(char::is_control)
        }) {
            self.edit_find(|query| query.push_str(text), cx);
        } else {
            return;
        }
        cx.stop_propagation();
    }

    pub fn cycle(&mut self, step: isize, cx: &mut Context<Self>) {
        let len = self.tabs.len() as isize;
        self.activate((self.active as isize + step).rem_euclid(len) as usize, cx);
    }
}

/// Places a torn-off window so its tab sits under the pointer where the tab was grabbed.
fn follow_pointer(grab: Point<Pixels>, window: &Window) {
    let tab = tab_bar::first_tab_origin();
    // AppKit's screen coordinates grow upwards.
    let mut origin = NSEvent::mouseLocation();
    origin.x -= f64::from(f32::from(tab.x + grab.x));
    origin.y += f64::from(f32::from(tab.y + grab.y));
    ns_window(window).setFrameTopLeftPoint(origin);
}

/// Only web and mail links leave the app; other schemes could launch arbitrary local apps.
pub fn open_external(url: &str, cx: &App) {
    if Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto")) {
        cx.open_url(url);
    }
}

impl Render for Browser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.tabs[self.active].webview.clone();
        let palette = Palette::new(self.tabs[self.active].chrome);
        let entity = cx.entity();
        let dragging = self.drag.is_some();

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0xffffff))
            .on_action(cx.listener(|this, _: &NewTab, window, cx| {
                let url = this.url.clone();
                this.open_tab(&url, window, cx);
            }))
            .on_action(
                cx.listener(|this, _: &CloseTab, window, cx| this.close(this.active, window, cx)),
            )
            .on_action(cx.listener(|this, _: &NextTab, _, cx| this.cycle(1, cx)))
            .on_action(cx.listener(|this, _: &PreviousTab, _, cx| this.cycle(-1, cx)))
            .on_action(cx.listener(|this, _: &Reload, _, _| {
                this.tabs[this.active]
                    .webview
                    .reload()
                    .expect("failed to reload webview");
            }))
            .on_action(cx.listener(|this, _: &Find, window, cx| this.open_find(window, cx)))
            .on_action(
                cx.listener(|this, _: &FindNext, window, cx| match this.find {
                    Some(_) => this.search(1, cx),
                    None => this.open_find(window, cx),
                }),
            )
            .on_action(
                cx.listener(|this, _: &FindPrevious, window, cx| match this.find {
                    Some(_) => this.search(-1, cx),
                    None => this.open_find(window, cx),
                }),
            )
            .on_action(cx.listener(|this, _: &ToggleDevTools, _, _| {
                let webview = &this.tabs[this.active].webview;
                if webview.is_devtools_open() {
                    webview.close_devtools();
                } else {
                    webview.open_devtools();
                }
            }))
            .child(TabBar {
                tabs: self
                    .tabs
                    .iter()
                    .map(|tab| TabLabel {
                        title: tab.title.clone(),
                    })
                    .collect(),
                active: self.active,
                palette,
                leading_inset: !window.is_fullscreen(),
                on_select: Rc::new({
                    let entity = entity.clone();
                    move |index, _, cx| entity.update(cx, |this, cx| this.activate(index, cx))
                }),
                on_close: Rc::new({
                    let entity = entity.clone();
                    move |index, window, cx| {
                        entity.update(cx, |this, cx| this.close(index, window, cx))
                    }
                }),
                on_move: Rc::new({
                    let entity = entity.clone();
                    move |from, to, _, cx| entity.update(cx, |this, cx| this.move_tab(from, to, cx))
                }),
                on_drag_start: Rc::new({
                    let entity = entity.clone();
                    move |index, grab, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.start_drag(index, grab);
                            cx.notify();
                        })
                    }
                }),
                on_new: Rc::new({
                    let entity = entity.clone();
                    move |window, cx| {
                        entity.update(cx, |this, cx| {
                            let url = this.url.clone();
                            this.open_tab(&url, window, cx);
                        })
                    }
                }),
            })
            .when_some(self.find.as_ref(), |browser, find| {
                browser.child(
                    div()
                        .track_focus(&self.find_focus)
                        .key_context("FindBar")
                        .on_key_down(cx.listener(Self::find_key_down))
                        .on_action(
                            cx.listener(|this, _: &DismissFind, _, cx| this.dismiss_find(cx)),
                        )
                        .on_action(cx.listener(|this, _: &Paste, _, cx| {
                            if let Some(text) =
                                cx.read_from_clipboard().and_then(|item| item.text())
                            {
                                this.edit_find(
                                    |query| query.push_str(&text.replace('\n', " ")),
                                    cx,
                                );
                            }
                        }))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, window, cx| this.open_find(window, cx)),
                        )
                        .child(FindBar {
                            query: find.query.clone().into(),
                            result: find.result.clone(),
                            focused: self.find_focus.is_focused(window),
                            palette,
                            on_previous: Rc::new({
                                let entity = entity.clone();
                                move |_, cx| entity.read(cx).search(-1, cx)
                            }),
                            on_next: Rc::new({
                                let entity = entity.clone();
                                move |_, cx| entity.read(cx).search(1, cx)
                            }),
                            on_dismiss: Rc::new({
                                let entity = entity.clone();
                                move |_, cx| entity.update(cx, |this, cx| this.dismiss_find(cx))
                            }),
                        }),
                )
            })
            .child(
                // The native webview sits on top of this area and follows its layout bounds.
                canvas(
                    move |bounds, _, _| {
                        active
                            .set_bounds(Rect {
                                position: LogicalPosition::new(
                                    f32::from(bounds.origin.x),
                                    f32::from(bounds.origin.y),
                                )
                                .into(),
                                size: LogicalSize::new(
                                    f32::from(bounds.size.width),
                                    f32::from(bounds.size.height),
                                )
                                .into(),
                            })
                            .expect("failed to position webview");
                    },
                    move |_, _, window, _| {
                        if !dragging {
                            return;
                        }
                        // Registered for the whole window, so the drag is followed past its edges.
                        let mover = entity.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                            if phase == DispatchPhase::Capture {
                                mover.update(cx, |this, cx| {
                                    this.drag_moved(event.position, window, cx)
                                });
                            }
                        });
                        let ender = entity.clone();
                        window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture {
                                ender.update(cx, |this, cx| this.end_drag(cx));
                            }
                        });
                    },
                )
                .flex_1()
                .size_full(),
            )
    }
}
