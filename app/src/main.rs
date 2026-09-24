mod browser;
mod find_bar;
mod keychain;
mod mounts;
mod palette;
mod tab_bar;

use browser::{
    Browser, CloseTab, DismissFind, Find, FindNext, FindPrevious, NewTab, NextTab, PreviousTab,
    Reload, ToggleDevTools,
};
use std::borrow::Cow;

use futures::StreamExt;

use gpui::{
    App, AppContext, Application, AssetSource, Bounds, KeyBinding, Menu, MenuItem, OsAction,
    SharedString, SystemMenuType, TitlebarOptions, WindowBounds, WindowOptions, actions, point, px,
    size,
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
    let url = std::env::var("VEKTOR_URL").unwrap_or_else(|_| "http://127.0.0.1:4321".into());

    // The browser hands a sign-in back through `vektor-desktop://`, which macOS delivers here,
    // outside any window; the links are relayed to the browser once it exists.
    let (links, mut opened_links) = futures::channel::mpsc::unbounded::<String>();
    let app = Application::new().with_assets(Assets);
    app.on_open_urls(move |urls| {
        for url in urls {
            let _ = links.unbounded_send(url);
        }
    });
    app.run(move |cx: &mut App| {
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
            KeyBinding::new("secondary-f", Find, None),
            KeyBinding::new("secondary-g", FindNext, None),
            KeyBinding::new("secondary-shift-g", FindPrevious, None),
            KeyBinding::new("enter", FindNext, Some("FindBar")),
            KeyBinding::new("shift-enter", FindPrevious, Some("FindBar")),
            KeyBinding::new("escape", DismissFind, Some("FindBar")),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        // The Edit menu is what routes copy/paste to the focused webview on macOS.
        cx.set_menus(vec![
            Menu {
                name: "Vektor".into(),
                items: vec![
                    MenuItem::os_submenu("Services", SystemMenuType::Services),
                    MenuItem::separator(),
                    MenuItem::action("Quit Vektor", Quit),
                ],
            },
            Menu {
                name: "File".into(),
                items: vec![
                    MenuItem::action("New Tab", NewTab),
                    MenuItem::action("Close Tab", CloseTab),
                ],
            },
            Menu {
                name: "Edit".into(),
                items: vec![
                    MenuItem::os_action("Cut", Cut, OsAction::Cut),
                    MenuItem::os_action("Copy", Copy, OsAction::Copy),
                    MenuItem::os_action("Paste", Paste, OsAction::Paste),
                    MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
                    MenuItem::separator(),
                    MenuItem::action("Find…", Find),
                    MenuItem::action("Find Next", FindNext),
                    MenuItem::action("Find Previous", FindPrevious),
                ],
            },
            Menu {
                name: "View".into(),
                items: vec![
                    MenuItem::action("Reload", Reload),
                    MenuItem::action("Developer Tools", ToggleDevTools),
                ],
            },
            Menu {
                name: "Window".into(),
                items: vec![
                    MenuItem::action("Next Tab", NextTab),
                    MenuItem::action("Previous Tab", PreviousTab),
                ],
            },
        ]);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(1280.), px(840.)),
                cx,
            ))),
            titlebar: Some(TitlebarOptions {
                title: Some("Vektor".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(18.), px(18.))),
            }),
            window_min_size: Some(size(px(480.), px(320.))),
            ..Default::default()
        };
        mounts::init(&url::Url::parse(&url).expect("VEKTOR_URL is not a URL"), cx);
        let browser = cx
            .open_window(options, |window, cx| {
                cx.new(|cx| Browser::new(url, window, cx))
            })
            .expect("failed to open window");
        cx.spawn(async move |cx| {
            while let Some(link) = opened_links.next().await {
                let delivered =
                    browser.update(cx, |browser, _, cx| browser.complete_sign_in(&link, cx));
                if delivered.is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.activate(true);
    });
}
