use std::{path::PathBuf, rc::Rc};

use futures::{StreamExt, channel::mpsc};
use gpui::{
    Context, FocusHandle, IntoElement, KeyDownEvent, MouseButton, Render, SharedString, Window,
    actions, canvas, div, prelude::*, rgb,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Origin, Url};
use wry::http::Request;
use wry::{
    NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder,
    dpi::{LogicalPosition, LogicalSize},
};

use crate::{
    Paste,
    find_bar::FindBar,
    mounts::{MountConfig, Mounts, is_plain_name, load, mountpoint, support_dir, write},
    palette::Palette,
    tab_bar::{TabBar, TabLabel},
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

/// Webview callbacks fire outside gpui's update cycle, so they are funnelled through a channel.
pub enum TabEvent {
    TitleChanged(u64, String),
    OpenTab(String),
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

/// The open tabs, restored on the next launch.
#[derive(Serialize, Deserialize, Default)]
pub struct Session {
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
    /// Colour of the page's top edge, which the chrome takes on while this tab is active.
    pub chrome: u32,
}

pub struct Browser {
    pub url: String,
    /// The only origin a tab's main frame may show; everything else opens in the system browser.
    pub origin: Origin,
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub next_id: u64,
    pub events: mpsc::UnboundedSender<TabEvent>,
    /// Open while the find bar is shown.
    pub find: Option<FindState>,
    pub find_focus: FocusHandle,
    /// Secret of the browser sign-in in progress; only its hash ever leaves the app.
    pub sign_in_verifier: Option<String>,
}

impl Browser {
    pub fn new(url: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (events, mut receiver) = mpsc::unbounded();
        cx.spawn_in(window, async move |this, cx| {
            while let Some(event) = receiver.next().await {
                let updated = this.update_in(cx, |this, window, cx| match event {
                    TabEvent::TitleChanged(id, title) => this.set_title(id, title, cx),
                    TabEvent::OpenTab(url) => this.open_tab(&url, window, cx),
                    TabEvent::OpenExternal(url) => open_external(&url, cx),
                    TabEvent::LeftOrigin(id, url) => this.return_to_origin(id, &url, cx),
                    TabEvent::FindResult(id, result) => this.set_find_result(id, &result, cx),
                    TabEvent::Page(id, message) => this.handle_page_message(id, message, cx),
                });
                if updated.is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.observe_global::<Mounts>(|this, cx| this.broadcast_mounts(cx))
            .detach();
        // Quitting keeps the window alive until here; closing it drops the browser first.
        cx.on_app_quit(|this, _| {
            this.save_session();
            async {}
        })
        .detach();
        let this = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            this.update(cx, |this, _| this.save_session())
                .expect("browser outlives its window");
            true
        });

        let mut browser = Self {
            origin: Url::parse(&url).expect("VEKTOR_URL is not a URL").origin(),
            tabs: Vec::new(),
            active: 0,
            next_id: 0,
            events,
            url: url.clone(),
            find: None,
            find_focus: cx.focus_handle(),
            sign_in_verifier: None,
        };
        // Tabs saved against another `VEKTOR_URL` are not restored.
        let session: Session = load(session_path());
        let mut active = 0;
        for (index, tab) in session.tabs.iter().enumerate() {
            if is_internal(&browser.origin, tab) {
                if index == session.active {
                    active = browser.tabs.len();
                }
                browser.open_tab(tab, window, cx);
            }
        }
        if browser.tabs.is_empty() {
            browser.open_tab(&url, window, cx);
        } else {
            browser.activate(active, cx);
        }
        browser
    }

    pub fn save_session(&self) {
        let session = Session {
            tabs: self
                .tabs
                .iter()
                .map(|tab| tab.webview.url().expect("failed to read webview url"))
                .collect(),
            active: self.active,
        };
        write(session_path(), &session);
    }

    pub fn open_tab(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.next_id;
        self.next_id += 1;

        let titles = self.events.clone();
        let opener = self.events.clone();
        let loads = self.events.clone();
        let opener_origin = self.origin.clone();
        let load_origin = self.origin.clone();
        let ipc = self.events.clone();
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
                    TabEvent::OpenTab(url)
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

        self.tabs.push(Tab {
            id,
            title: "Vektor".into(),
            webview: Rc::new(webview),
            chrome: 0xffffff,
        });
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
            self.search(0);
        }
        cx.notify();
    }

    pub fn close(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.tabs.remove(index);
        if self.tabs.is_empty() {
            self.save_session();
            window.remove_window();
            return;
        }
        self.activate(self.active.min(self.tabs.len() - 1), cx);
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
        self.search(0);
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
        self.search(0);
        cx.notify();
    }

    /// `step` moves between matches; 0 re-runs the query in place.
    pub fn search(&self, step: i32) {
        let find = self.find.as_ref().expect("find bar is closed");
        let tab = &self.tabs[self.active];
        let id = tab.id;
        let events = self.events.clone();
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

/// Only web and mail links leave the app; other schemes could launch arbitrary local apps.
pub fn open_external(url: &str, cx: &mut Context<Browser>) {
    if Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto")) {
        cx.open_url(url);
    }
}

impl Render for Browser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.tabs[self.active].webview.clone();
        let palette = Palette::new(self.tabs[self.active].chrome);
        let entity = cx.entity();

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
                    Some(_) => this.search(1),
                    None => this.open_find(window, cx),
                }),
            )
            .on_action(
                cx.listener(|this, _: &FindPrevious, window, cx| match this.find {
                    Some(_) => this.search(-1),
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
                                move |_, cx| entity.read(cx).search(-1)
                            }),
                            on_next: Rc::new({
                                let entity = entity.clone();
                                move |_, cx| entity.read(cx).search(1)
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
                    |_, _, _, _| {},
                )
                .flex_1()
                .size_full(),
            )
    }
}
