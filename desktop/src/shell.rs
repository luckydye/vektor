//! What the app tells the page, what the page may ask of it, which URLs stay in the app and the
//! browser sign-in.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::{Origin, Url};

/// Reports the colour of the page's top pixel row so the chrome can blend into it. The layers
/// under that row are composited on a canvas, which also resolves any CSS colour syntax.
pub const CHROME_COLOR_SCRIPT: &str = r##"
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

/// The app as the web UI's `window.vektorApp` describes it (`server/src/utils/nativeApp.ts`).
/// `platform` is Rust's `std::env::consts::OS`.
pub fn app_info(version: &str) -> String {
    serde_json::json!({ "version": version, "platform": std::env::consts::OS }).to_string()
}

/// Announces the app to the web UI as `window.vektorApp`, before any page script runs.
pub fn native_app_script(version: &str) -> String {
    format!(
        "Object.defineProperty(window, 'vektorApp', {{ value: Object.freeze({}) }});",
        app_info(version)
    )
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
    /// `navigator.geolocation.getCurrentPosition`, answered through `__vektorLocation`.
    LocationRequest {
        id: u64,
    },
}

pub fn is_internal(origin: &Origin, url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| url.origin() == *origin)
}

/// Only web and mail links leave the app; other schemes could launch arbitrary local apps.
pub fn may_open_externally(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto"))
}

/// A browser sign-in in progress. The server's `desktopAuth` plugin holds the other half of this
/// exchange; only the verifier's hash ever leaves the app.
pub struct SignIn {
    pub verifier: String,
}

impl SignIn {
    /// The sign-in and the page that starts it in the system browser.
    pub fn start(base: &Url) -> (Self, Url) {
        let verifier = hex::encode(rand::random::<[u8; 32]>());
        let challenge = hex::encode(Sha256::digest(verifier.as_bytes()));
        let mut url = base.clone();
        url.set_path("/desktop-login");
        url.set_query(Some(&format!("challenge={challenge}")));
        (Self { verifier }, url)
    }

    /// The page that trades `code` for a session in the webview.
    pub fn complete(self, base: &Url, code: &str) -> Url {
        let mut url = base.clone();
        url.set_path("/api/auth/desktop-handoff/complete");
        url.query_pairs_mut()
            .append_pair("code", code)
            .append_pair("verifier", &self.verifier);
        url
    }
}

/// The code in `vektor-desktop://auth?code=…`, which the browser hands back through the app's URL
/// scheme; `None` for any other link.
pub fn sign_in_code(link: &str) -> Option<String> {
    let link = Url::parse(link).ok()?;
    if link.scheme() != "vektor-desktop" || link.host_str() != Some("auth") {
        return None;
    }
    link.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, code)| code.into_owned())
}
