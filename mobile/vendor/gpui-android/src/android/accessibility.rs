//! Screen-reader support: hands GPUI's AccessKit tree to TalkBack.
//!
//! GPUI builds an AccessKit tree every frame once a screen reader is active and passes
//! it to `PlatformWindow::a11y_tree_update`. `accesskit_android`'s [`InjectingAdapter`]
//! exposes that tree as virtual `AccessibilityNodeInfo`s by installing an
//! `AccessibilityDelegate` on an existing `View`, so hosts need no Java changes.
//!
//! Node bounds are in surface pixels, so the `View` must line up with GPUI's surface:
//! the decor view on the `android-activity` path (the native surface fills the window)
//! and the content view on the host-driven path (it holds the `SurfaceView`).
//!
//! Only the active window's Activity is on screen, so one adapter serves the active
//! window, and a window that becomes active takes it over. The adapter is attached when
//! the window becomes active (on resume, and when its surface arrives), after the
//! Activity's `setContentView`: AppCompat moves `android.R.id.content` there. A
//! recreated Activity has new views, so the adapter follows it then too.
//!
//! This adapter version has no "screen reader stopped" callback, and raises events from
//! a runnable it posts to the UI thread without checking whether anyone listens, which
//! Android answers by throwing there (`accesskit_android` 0.9 checks in that runnable,
//! but needs `accesskit` 0.25). So each update first asks
//! `AccessibilityManager.isEnabled()`; once it is off, GPUI is told to stop building
//! trees and a fresh adapter waits for the next screen reader. The patched injection layer
//! also checks on the UI thread before raising queued events,
//! closing the race between this check and event delivery.

use std::{
    mem::ManuallyDrop,
    sync::{Arc, Mutex, OnceLock},
};

use super::accesskit_adapter::InjectingAdapter;
use super::host::HostId;
use accesskit_android::jni::{
    objects::{GlobalRef, JObject, JString},
    JNIEnv, JavaVM,
};
use gpui::{
    accesskit::{ActionHandler, ActionRequest, ActivationHandler, TreeUpdate},
    A11yCallbacks,
};

static BRIDGE: Mutex<Option<Bridge>> = Mutex::new(None);

/// The JavaVM in `accesskit_android`'s jni version.
static VM: OnceLock<JavaVM> = OnceLock::new();

/// `android.view.accessibility.AccessibilityManager`, one per process.
static MANAGER: OnceLock<GlobalRef> = OnceLock::new();

/// `android.R.id.content`.
const CONTENT_VIEW_ID: i32 = 0x0102_0002;

struct Bridge {
    callbacks: Handlers,
    adapter: Option<Adapter>,
}

struct Adapter {
    inner: ManuallyDrop<InjectingAdapter>,
    /// The Activity whose view `inner` is on.
    activity: GlobalRef,
}

impl Drop for Adapter {
    fn drop(&mut self) {
        // SAFETY: `inner` is not used after this.
        in_local_frame(|| unsafe { ManuallyDrop::drop(&mut self.inner) });
    }
}

/// One window's GPUI callbacks, shared by every adapter its Activity gets, and the
/// window's host on the host-driven path.
#[derive(Clone)]
pub(super) struct Handlers(Arc<Mutex<A11yCallbacks>>, Option<HostId>);

impl Handlers {
    pub(super) fn new(callbacks: A11yCallbacks, host: Option<HostId>) -> Self {
        Self(Arc::new(Mutex::new(callbacks)), host)
    }

    fn deactivate(&self) {
        (self.0.lock().expect("poisoned").deactivation)();
    }
}

impl ActivationHandler for Handlers {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        (self.0.lock().expect("poisoned").activation)()
    }
}

impl ActionHandler for Handlers {
    fn do_action(&mut self, request: ActionRequest) {
        (self.0.lock().expect("poisoned").action)(request)
    }
}

/// Point the screen reader at this window, on the GPUI thread. Called from
/// `PlatformWindow::a11y_init` and when the window becomes active again.
pub(super) fn init(callbacks: &Handlers) {
    let mut bridge = BRIDGE.lock().expect("poisoned");
    if let Some(previous) = bridge.as_mut() {
        if Arc::ptr_eq(&previous.callbacks.0, &callbacks.0) {
            // An earlier attach may have failed (no JavaVM or Activity yet, a JNI
            // error), or the Activity was recreated; attach again in both cases.
            if !previous.is_current() {
                previous.attach();
            }
            return;
        }
        // The previous window is off screen; stop it building trees.
        previous.callbacks.deactivate();
    }
    bridge
        .insert(Bridge {
            callbacks: callbacks.clone(),
            adapter: None,
        })
        .attach();
}

/// `PlatformWindow::a11y_tree_update`, on the GPUI thread that called [`init`].
pub(super) fn update(callbacks: &Handlers, tree: TreeUpdate) {
    // Outside the lock: a JNI call every frame should not hold up `init`.
    let enabled = is_accessibility_enabled();
    let mut bridge = BRIDGE.lock().expect("poisoned");
    let Some(bridge) = bridge
        .as_mut()
        .filter(|bridge| Arc::ptr_eq(&bridge.callbacks.0, &callbacks.0))
    else {
        return;
    };
    let Some(adapter) = bridge.adapter.as_mut() else {
        return;
    };
    if enabled {
        in_local_frame(|| adapter.inner.update_if_active(|| tree));
        // Raising events calls into Java; don't leave its exception to the next caller.
        if let Ok(mut env) = vm().and_then(|vm| vm.get_env().map_err(|e| e.to_string())) {
            let _ = clear_exception(&mut env, Ok(()));
        }
        return;
    }
    // The screen reader has gone. Stop GPUI building trees, and swap in an adapter
    // that is not yet active, so the next screen reader activates GPUI again.
    bridge.callbacks.deactivate();
    bridge.attach();
}

/// The window is closing: drop its adapter, which takes the delegate off its view, so
/// a later screen reader cannot reach the closed window's callbacks.
pub(super) fn close(callbacks: &Handlers) {
    let mut bridge = BRIDGE.lock().expect("poisoned");
    if bridge
        .as_ref()
        .is_some_and(|bridge| Arc::ptr_eq(&bridge.callbacks.0, &callbacks.0))
    {
        *bridge = None;
    }
}

impl Bridge {
    /// Whether the adapter is on the window's current Activity.
    fn is_current(&self) -> bool {
        let Some(adapter) = &self.adapter else {
            return false;
        };
        with_activity(self.callbacks.1, |env, activity| {
            Ok(Ok(env.is_same_object(&adapter.activity, activity)?))
        })
        .unwrap_or(false)
    }

    fn attach(&mut self) {
        // Dropping the old adapter removes its delegate from the old view.
        self.adapter = None;
        let callbacks = self.callbacks.clone();
        match with_activity(self.callbacks.1, |env, activity| {
            let view = host_view(env, activity)?;
            if view.is_null() {
                return Ok(Err("the Activity has no content view".into()));
            }
            let view = &view;
            // `InjectingAdapter` panics on the UI thread, aborting the process, if the
            // view has a delegate already: the host's, or an androidx layer's.
            if let Some(class) = foreign_delegate(env, view)? {
                return Ok(Err(format!(
                    "the view already has an accessibility delegate ({class})"
                )));
            }
            if MANAGER.get().is_none() {
                let _ = MANAGER.set(accessibility_manager(env, view)?);
            }
            Ok(Ok(Adapter {
                inner: ManuallyDrop::new(InjectingAdapter::new(
                    env,
                    view,
                    callbacks.clone(),
                    callbacks,
                )),
                activity: env.new_global_ref(activity)?,
            }))
        }) {
            Ok(adapter) => self.adapter = Some(adapter),
            Err(err) => log::warn!("accessibility: cannot attach to the host view: {err}"),
        }
    }
}

/// `false` until an adapter has been attached.
fn is_accessibility_enabled() -> bool {
    let (Some(vm), Some(manager)) = (VM.get(), MANAGER.get()) else {
        return false;
    };
    let enabled = vm.get_env().and_then(|mut env| {
        let enabled = env
            .call_method(manager, "isEnabled", "()Z", &[])
            .and_then(|value| value.z());
        clear_exception(&mut env, enabled)
    });
    enabled.unwrap_or_else(|err| {
        log::warn!("accessibility: AccessibilityManager.isEnabled failed: {err}");
        false
    })
}

fn vm() -> Result<&'static JavaVM, String> {
    if let Some(vm) = VM.get() {
        return Ok(vm);
    }
    let vm = super::jni::java_vm();
    if vm.is_null() {
        return Err("JavaVM not available".into());
    }
    // SAFETY: the pointer comes from the running JVM, which lives as long as the process.
    let vm = unsafe { JavaVM::from_raw(vm.cast()) }.map_err(|e| e.to_string())?;
    Ok(VM.get_or_init(|| vm))
}

/// Run `f` in its own local reference frame. `accesskit_android` creates local references
/// in every update and drop and never deletes them, and the GPUI thread stays attached,
/// so they would pile up and keep old views alive.
fn in_local_frame<T>(f: impl FnOnce() -> T) -> T {
    // On a thread that is not attached, `accesskit_android` attaches only for the call,
    // and detaching frees them.
    let Some(env) = VM.get().and_then(|vm| vm.get_env().ok()) else {
        return f();
    };
    if env.push_local_frame(16).is_err() {
        return f();
    }
    let value = f();
    // SAFETY: no local reference from inside the frame is used after it.
    let _ = unsafe { env.pop_local_frame(&JObject::null()) };
    value
}

/// `accesskit_android`'s jni 0.21 returns an error for a Java exception but leaves it
/// pending, and no further JNI call is allowed until it is cleared. Clear it (after
/// logging it) so it does not surface in the next, unrelated call on this thread.
fn clear_exception<T>(
    env: &mut JNIEnv,
    result: accesskit_android::jni::errors::Result<T>,
) -> accesskit_android::jni::errors::Result<T> {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result
}

/// The class of `view`'s accessibility delegate, unless it has none or it is an earlier
/// adapter's (whose removal is queued ahead of the new one on the UI thread).
fn foreign_delegate(
    env: &mut JNIEnv,
    view: &JObject,
) -> accesskit_android::jni::errors::Result<Option<String>> {
    let delegate = super::accesskit_adapter::get_accessibility_delegate(env, view)?;
    if delegate.is_null() {
        return Ok(None);
    }
    let class = env
        .call_method(&delegate, "getClass", "()Ljava/lang/Class;", &[])?
        .l()?;
    let name = env
        .call_method(&class, "getName", "()Ljava/lang/String;", &[])?
        .l()?;
    let name: String = env.get_string(&JString::from(name))?.into();
    Ok((name != "dev.accesskit.android.Delegate").then_some(name))
}

fn accessibility_manager(
    env: &mut JNIEnv,
    view: &JObject,
) -> accesskit_android::jni::errors::Result<GlobalRef> {
    let context = env
        .call_method(view, "getContext", "()Landroid/content/Context;", &[])?
        .l()?;
    let name = env.new_string("accessibility")?;
    let manager = env
        .call_method(
            &context,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[(&name).into()],
        )?
        .l()?;
    env.new_global_ref(manager)
}

/// Run `f` with the window's own Activity, on this thread's (permanently attached) env.
fn with_activity<T>(
    host: Option<HostId>,
    f: impl FnOnce(&mut JNIEnv, &JObject) -> accesskit_android::jni::errors::Result<Result<T, String>>,
) -> Result<T, String> {
    match host {
        Some(host) => super::host::with_activity(host, |activity| with_raw_activity(activity, f)),
        None => with_raw_activity(super::jni::activity_as_ptr(), f),
    }
}

fn with_raw_activity<T>(
    activity: *mut std::ffi::c_void,
    f: impl FnOnce(&mut JNIEnv, &JObject) -> accesskit_android::jni::errors::Result<Result<T, String>>,
) -> Result<T, String> {
    if activity.is_null() {
        return Err("Activity not available".into());
    }
    let vm = vm()?;
    // SAFETY: the Activity is a global reference that `super::host` or `super::jni`
    // keeps alive for this call.
    let activity = unsafe { JObject::from_raw(activity.cast()) };
    // `InjectingAdapter::update_if_active` expects the calling thread to stay attached.
    let mut env = vm
        .attach_current_thread_permanently()
        .map_err(|e| e.to_string())?;
    let result = env.with_local_frame(8, |env| f(env, &activity));
    clear_exception(&mut env, result).map_err(|e| e.to_string())?
}

/// The `View` that lines up with GPUI's surface; null if the Activity has none yet.
fn host_view<'local>(
    env: &mut JNIEnv<'local>,
    activity: &JObject,
) -> accesskit_android::jni::errors::Result<JObject<'local>> {
    let window = env
        .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?
        .l()?;
    let view = env
        .call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?
        .l()?;
    if super::jni::android_app().is_some() {
        return Ok(view);
    }
    env.call_method(
        &view,
        "findViewById",
        "(I)Landroid/view/View;",
        &[CONTENT_VIEW_ID.into()],
    )?
    .l()
}
