//! Android entry point and the page in Android's WebView. `android-activity` loads the library
//! and calls `android_main` on its native thread, which runs the app until the activity is
//! destroyed. The WebView lives in `VektorActivity.java`; the app drives it from here and hears
//! back through the activity's native methods.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::channel::mpsc::UnboundedSender;
use gpui::{Bounds, Pixels, Window};
use gpui_android::android::jni as platform;
use gpui_android::android_activity::AndroidApp;
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JClass, JObject, JString, JValue};
use jni::{EnvUnowned, jni_sig, jni_str};
use url::{Origin, Url};
use vektor_shell::{CHROME_COLOR_SCRIPT, app_info, is_internal};

use crate::PageEvent;

/// Set once the app runs in this process (see `android_main`).
static STARTED: AtomicBool = AtomicBool::new(false);
/// Where the activity's native methods deliver; set when the page is shown.
static EVENTS: OnceLock<UnboundedSender<PageEvent>> = OnceLock::new();
static ORIGIN: OnceLock<Origin> = OnceLock::new();

#[unsafe(no_mangle)]
fn android_main(app: AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("vektor"),
    );
    // Android may recreate the activity in this process (a configuration or asset change apps
    // cannot handle themselves, common right after an install) and call `android_main` again.
    // GPUI runs once per process: the first run relaunches the app in a fresh process instead.
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // Panics go to logcat instead of aborting silently.
    platform::install_panic_hook();
    platform::init_platform(&app);
    let shared = platform::shared_platform().expect("the platform was just initialised");
    // `run` blocks in the platform's event loop until the activity ends.
    crate::run(gpui::Application::with_platform(shared.into_rc()));
    // The activity is gone. Unless the app was closed, it is being recreated: launch it anew, in
    // the fresh process that ending this one leaves for it.
    if !activity_is_finishing() {
        relaunch();
    }
    // `_exit`, not `exit`: static destructors would run under Android's still-running render
    // threads and abort.
    // SAFETY: ends the process; nothing runs afterwards.
    unsafe { libc::_exit(0) }
}

/// Runs `f` with the activity, a `VektorActivity`.
fn with_activity(f: impl FnOnce(&mut jni::Env, &JObject) -> jni::errors::Result<()>) {
    platform::with_env(|env| {
        let activity = platform::activity(env)?;
        f(env, &activity).map_err(|e| e.to_string())
    })
    .expect("failed to call the activity");
}

/// Whether the activity was closed for good rather than recreated.
fn activity_is_finishing() -> bool {
    platform::with_env(|env| {
        let activity = platform::activity(env)?;
        env.call_method(&activity, jni_str!("isFinishing"), jni_sig!("()Z"), &[])
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())
    })
    .expect("failed to ask whether the activity is finishing")
}

/// Start the app's launcher activity in a new task.
fn relaunch() {
    // `Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK`.
    const NEW_CLEAR_TASK: i32 = 0x1000_0000 | 0x0000_8000;
    with_activity(|env, activity| {
        let context = env
            .call_method(
                activity,
                jni_str!("getApplicationContext"),
                jni_sig!("()Landroid/content/Context;"),
                &[],
            )?
            .l()?;
        let package = env
            .call_method(
                &context,
                jni_str!("getPackageName"),
                jni_sig!("()Ljava/lang/String;"),
                &[],
            )?
            .l()?;
        let manager = env
            .call_method(
                &context,
                jni_str!("getPackageManager"),
                jni_sig!("()Landroid/content/pm/PackageManager;"),
                &[],
            )?
            .l()?;
        let intent = env
            .call_method(
                &manager,
                jni_str!("getLaunchIntentForPackage"),
                jni_sig!("(Ljava/lang/String;)Landroid/content/Intent;"),
                &[JValue::Object(&package)],
            )?
            .l()?;
        env.call_method(
            &intent,
            jni_str!("addFlags"),
            jni_sig!("(I)Landroid/content/Intent;"),
            &[JValue::Int(NEW_CLEAR_TASK)],
        )?;
        env.call_method(
            &context,
            jni_str!("startActivity"),
            jni_sig!("(Landroid/content/Intent;)V"),
            &[JValue::Object(&intent)],
        )?;
        Ok(())
    });
}

/// The page, in the WebView `VektorActivity` holds. There is one per process.
#[derive(Clone)]
pub struct Page;

impl Page {
    pub fn new(url: &Url, events: UnboundedSender<PageEvent>, _: &Window) -> Self {
        assert!(EVENTS.set(events).is_ok(), "the page was already shown");
        assert!(
            ORIGIN.set(url.origin()).is_ok(),
            "the page was already shown"
        );
        register_natives();
        // The WebView cannot run a script before the page's own; this one only follows the page,
        // so it runs once each document has loaded.
        let script = format!(
            "if (!window.__vektorChrome) {{ window.__vektorChrome = true; {CHROME_COLOR_SCRIPT} }}"
        );
        let app = app_info(env!("CARGO_PKG_VERSION"));
        with_activity(|env, activity| {
            let url = env.new_string(url.as_str())?;
            let app = env.new_string(&app)?;
            let script = env.new_string(&script)?;
            env.call_method(
                activity,
                jni_str!("showPage"),
                jni_sig!("(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V"),
                &[
                    JValue::Object(&url),
                    JValue::Object(&app),
                    JValue::Object(&script),
                ],
            )?;
            Ok(())
        });
        Self
    }

    /// Places the page at `bounds`, in the window's logical pixels.
    pub fn place(&self, bounds: Bounds<Pixels>, scale: f32) {
        let [x, y, width, height] = [
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        ]
        .map(|value| (f32::from(value) * scale).round() as i32);
        with_activity(|env, activity| {
            env.call_method(
                activity,
                jni_str!("placePage"),
                jni_sig!("(IIII)V"),
                &[
                    JValue::Int(x),
                    JValue::Int(y),
                    JValue::Int(width),
                    JValue::Int(height),
                ],
            )?;
            Ok(())
        });
    }

    pub fn load(&self, url: &str) {
        self.call_with_string(jni_str!("loadPage"), url);
    }

    pub fn evaluate(&self, script: &str) {
        self.call_with_string(jni_str!("evaluate"), script);
    }

    fn call_with_string(&self, method: &jni::strings::JNIStr, value: &str) {
        with_activity(|env, activity| {
            let value = env.new_string(value)?;
            env.call_method(
                activity,
                method,
                jni_sig!("(Ljava/lang/String;)V"),
                &[JValue::Object(&value)],
            )?;
            Ok(())
        });
    }

    /// Status bar and navigation bar content that reads on a light or a dark page, which GPUI
    /// paints under both bars (the window is edge to edge).
    pub fn style_system_bars(light: bool) {
        let style = match light {
            true => gpui_android::StatusBarContentStyle::Dark,
            false => gpui_android::StatusBarContentStyle::Light,
        };
        gpui_android::set_system_chrome(&gpui_android::SystemChromeStyle {
            status_bar_color: None,
            status_bar_style: style,
            navigation_bar_color: None,
        });
    }
}

fn send(event: PageEvent) {
    // The window is gone when nobody receives; nothing is left to act on the event then.
    let _ = EVENTS
        .get()
        .expect("the page is shown")
        .unbounded_send(event);
}

/// `VektorActivity.leaves(String url)`, called on Android's UI thread.
extern "system" fn leaves<'local>(
    mut env: EnvUnowned<'local>,
    _: JClass<'local>,
    url: JString<'local>,
) -> bool {
    env.with_env(|env| -> jni::errors::Result<bool> {
        let url = url.try_to_string(env)?;
        if is_internal(ORIGIN.get().expect("the page is shown"), &url) {
            return Ok(false);
        }
        send(PageEvent::OpenExternal(url));
        Ok(true)
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// `VektorActivity.message(String json)`, called on the WebView's JavaScript bridge thread.
extern "system" fn message<'local>(
    mut env: EnvUnowned<'local>,
    _: JClass<'local>,
    json: JString<'local>,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        // The page is untrusted: anything that does not parse is dropped. The bridge also reaches
        // the page's frames, which can at worst recolour the bars or start a sign-in.
        if let Ok(message) = serde_json::from_str(&json.try_to_string(env)?) {
            send(PageEvent::Message(message));
        }
        Ok(())
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// `VektorActivity.opened(String link)`, called on Android's UI thread.
extern "system" fn opened<'local>(
    mut env: EnvUnowned<'local>,
    _: JClass<'local>,
    link: JString<'local>,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        send(PageEvent::Opened(link.try_to_string(env)?));
        Ok(())
    })
    .resolve::<ThrowRuntimeExAndDefault>()
}

/// Binds `VektorActivity`'s native methods: the activity loads this library itself, so Java
/// cannot find them by name.
fn register_natives() {
    platform::with_env(|env| {
        let class = platform::find_app_class(env, "de.vektor.app.VektorActivity")?;
        let returns_boolean = jni_sig!("(Ljava/lang/String;)Z");
        let returns_nothing = jni_sig!("(Ljava/lang/String;)V");
        // SAFETY: each function has the JNI signature declared next to it.
        let methods = unsafe {
            [
                jni::NativeMethod::from_raw_parts(
                    jni_str!("leaves"),
                    returns_boolean.sig(),
                    leaves as *mut std::ffi::c_void,
                ),
                jni::NativeMethod::from_raw_parts(
                    jni_str!("message"),
                    returns_nothing.sig(),
                    message as *mut std::ffi::c_void,
                ),
                jni::NativeMethod::from_raw_parts(
                    jni_str!("opened"),
                    returns_nothing.sig(),
                    opened as *mut std::ffi::c_void,
                ),
            ]
        };
        // SAFETY: as above.
        unsafe { env.register_native_methods(&class, &methods) }.map_err(|e| e.to_string())
    })
    .expect("failed to register the activity's native methods");
}
