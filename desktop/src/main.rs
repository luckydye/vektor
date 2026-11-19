mod browser;
mod find_bar;
mod keychain;
mod location;
mod mounts;
mod palette;
mod shell;
mod tab_bar;
mod text_input;
mod titlebar;

use crate::shell::is_internal;
use browser::{
    CloseTab, DismissFind, Find, FindNext, FindPrevious, NewTab, NextTab, PreviousTab, Reload,
    Session, TabSource, ToggleDevTools, browsers, open_browser, route_tab_events, save_session,
    session_path, window_options,
};
use std::borrow::Cow;

use futures::StreamExt;

use gpui::{
    App, AssetSource, Bounds, KeyBinding, Menu, MenuItem, OsAction, SharedString, SystemMenuType,
    actions, point, px, size,
};

actions!(vektor, [Quit, Copy, Cut, Paste, SelectAll]);

/// Icons are shared with the web UI so both surfaces stay in step.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        let bytes: &'static [u8] = match path {
            "icons/add.svg" => include_bytes!("../../server/src/assets/icons/add.svg"),
            "icons/cancel.svg" => include_bytes!("../../server/src/assets/icons/cancel.svg"),
            "icons/chevron-down.svg" => {
                include_bytes!("../../server/src/assets/icons/chevron-down.svg")
            }
            "icons/search.svg" => include_bytes!("../../server/src/assets/icons/search.svg"),
            _ => panic!("unknown asset {path}"),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }

    fn list(&self, _: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

fn main() {
    // Baked in at build time, so a plain `cargo build` targets production.
    let url = option_env!("VEKTOR_URL")
        .unwrap_or("https://app.vektorapp.org")
        .to_string();

    // The browser hands a sign-in back through `vektor-desktop://`, which macOS delivers here,
    // outside any window; the links are relayed to the browser once it exists.
    let (links, mut opened_links) = futures::channel::mpsc::unbounded::<String>();
    let app = gpui_platform::application().with_assets(Assets);
    app.on_open_urls(move |urls| {
        for url in urls {
            let _ = links.unbounded_send(url);
        }
    });
    app.run(move |cx: &mut App| {
        text_input::install();
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-t", NewTab, None),
            KeyBinding::new("cmd-w", CloseTab, None),
            KeyBinding::new("cmd-shift-]", NextTab, None),
            KeyBinding::new("cmd-shift-[", PreviousTab, None),
            KeyBinding::new("cmd-r", Reload, None),
            KeyBinding::new("cmd-alt-i", ToggleDevTools, None),
            KeyBinding::new("cmd-c", Copy, None),
            KeyBinding::new("cmd-x", Cut, None),
            KeyBinding::new("cmd-v", Paste, None),
            KeyBinding::new("cmd-a", SelectAll, None),
            KeyBinding::new("cmd-f", Find, None),
            KeyBinding::new("cmd-g", FindNext, None),
            KeyBinding::new("cmd-shift-g", FindPrevious, None),
            KeyBinding::new("enter", FindNext, Some("FindBar")),
            KeyBinding::new("shift-enter", FindPrevious, Some("FindBar")),
            KeyBinding::new("escape", DismissFind, Some("FindBar")),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        // The Edit menu is what routes copy/paste to the focused webview on macOS.
        cx.set_menus(vec![
            Menu::new("Vektor").items([
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("Quit Vektor", Quit),
            ]),
            Menu::new("File").items([
                MenuItem::action("New Tab", NewTab),
                MenuItem::action("Close Tab", CloseTab),
            ]),
            Menu::new("Edit").items([
                MenuItem::os_action("Cut", Cut, OsAction::Cut),
                MenuItem::os_action("Copy", Copy, OsAction::Copy),
                MenuItem::os_action("Paste", Paste, OsAction::Paste),
                MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
                MenuItem::separator(),
                MenuItem::action("Find…", Find),
                MenuItem::action("Find Next", FindNext),
                MenuItem::action("Find Previous", FindPrevious),
            ]),
            Menu::new("View").items([
                MenuItem::action("Reload", Reload),
                MenuItem::action("Developer Tools", ToggleDevTools),
            ]),
            Menu::new("Window").items([
                MenuItem::action("Next Tab", NextTab),
                MenuItem::action("Previous Tab", PreviousTab),
            ]),
        ]);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        cx.on_app_quit(|cx| {
            save_session(cx);
            async {}
        })
        .detach();
        let origin = url::Url::parse(&url).expect("VEKTOR_URL is not a URL");
        mounts::init(&origin, cx);
        route_tab_events(cx);
        location::init(cx);

        // Tabs saved against another `VEKTOR_URL` are not restored.
        let origin = origin.origin();
        let session: Session = mounts::load(session_path());
        let mut windows: Vec<_> = session
            .windows
            .into_iter()
            .filter_map(|saved| {
                let active = saved.tabs[..saved.active.min(saved.tabs.len())]
                    .iter()
                    .filter(|tab| is_internal(&origin, tab))
                    .count();
                let tabs: Vec<_> = saved
                    .tabs
                    .into_iter()
                    .filter(|tab| is_internal(&origin, tab))
                    .map(TabSource::Url)
                    .collect();
                (!tabs.is_empty()).then(|| (active.min(tabs.len() - 1), tabs))
            })
            .collect();
        if windows.is_empty() {
            windows.push((0, vec![TabSource::Url(url.clone())]));
        }
        for (index, (active, tabs)) in windows.into_iter().enumerate() {
            let cascade = px(32. * index as f32);
            let mut bounds = Bounds::centered(None, size(px(1280.), px(840.)), cx);
            bounds.origin += point(cascade, cascade);
            open_browser(url.clone(), tabs, active, window_options(bounds, true), cx);
        }

        // Only the window that started a sign-in holds its verifier; the others ignore the link.
        cx.spawn(async move |cx| {
            while let Some(link) = opened_links.next().await {
                cx.update(|cx| {
                    for browser in browsers(cx) {
                        browser
                            .update(cx, |browser, _, cx| browser.complete_sign_in(&link, cx))
                            .expect("browser window vanished");
                    }
                });
            }
        })
        .detach();
        cx.activate(true);
    });
}
