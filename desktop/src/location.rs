//! macOS WebKit has no location provider of its own, so the page's `navigator.geolocation` asks
//! the app over IPC and CoreLocation answers.

use std::cell::RefCell;

use futures::channel::mpsc::UnboundedSender;
use gpui::{App, Global};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_core_location::{
    CLAuthorizationStatus, CLError, CLLocation, CLLocationManager, CLLocationManagerDelegate,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};

use crate::browser::{TabEvent, TabEvents};

/// Replaces `getCurrentPosition`; the app settles each request through `__vektorLocation`.
pub const LOCATION_SCRIPT: &str = r#"
{
  const pending = new Map();
  let next = 0;
  window.__vektorLocation = (id, result) => {
    const request = pending.get(id);
    pending.delete(id);
    if ("code" in result) request.error?.({ ...result, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    else request.success({ coords: result, timestamp: Date.now() });
  };
  navigator.geolocation.getCurrentPosition = (success, error) => {
    const id = next++;
    pending.set(id, { success, error });
    window.ipc.postMessage(JSON.stringify({ type: "locationRequest", id }));
  };
}
"#;

const DENIED: &str = r#"{ code: 1, message: "User denied Geolocation" }"#;

pub struct LocatorIvars {
    events: UnboundedSender<TabEvent>,
    /// Tab and page request ids waiting for the next location.
    waiting: RefCell<Vec<(u64, u64)>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = LocatorIvars]
    pub struct Locator;

    unsafe impl NSObjectProtocol for Locator {}

    unsafe impl CLLocationManagerDelegate for Locator {
        #[unsafe(method(locationManagerDidChangeAuthorization:))]
        fn did_change_authorization(&self, manager: &CLLocationManager) {
            self.proceed(manager);
        }

        #[unsafe(method(locationManager:didUpdateLocations:))]
        fn did_update_locations(&self, _: &CLLocationManager, locations: &NSArray<CLLocation>) {
            let location = locations
                .lastObject()
                .expect("CoreLocation reported no location");
            let coordinate = unsafe { location.coordinate() };
            let accuracy = unsafe { location.horizontalAccuracy() };
            self.answer(&format!(
                "{{ latitude: {}, longitude: {}, accuracy: {accuracy} }}",
                coordinate.latitude, coordinate.longitude
            ));
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn did_fail(&self, _: &CLLocationManager, error: &NSError) {
            if error.code() == CLError::Denied.0 {
                self.answer(DENIED);
            } else {
                self.answer(r#"{ code: 2, message: "Position unavailable" }"#);
            }
        }
    }
);

impl Locator {
    pub fn proceed(&self, manager: &CLLocationManager) {
        if self.ivars().waiting.borrow().is_empty() {
            return;
        }
        match unsafe { manager.authorizationStatus() } {
            CLAuthorizationStatus::NotDetermined => unsafe {
                manager.requestWhenInUseAuthorization()
            },
            CLAuthorizationStatus::Restricted | CLAuthorizationStatus::Denied => {
                self.answer(DENIED)
            }
            _ => unsafe { manager.requestLocation() },
        }
    }

    pub fn answer(&self, result: &str) {
        for (tab, id) in self.ivars().waiting.take() {
            let script = format!("__vektorLocation({id}, {result})");
            let _ = self
                .ivars()
                .events
                .unbounded_send(TabEvent::Script(tab, script));
        }
    }
}

pub struct Location {
    pub manager: Retained<CLLocationManager>,
    pub locator: Retained<Locator>,
}

impl Global for Location {}

/// Needs the tab event channel, which carries the answers back to the pages.
pub fn init(cx: &mut App) {
    let main_thread = MainThreadMarker::new().expect("location starts on the main thread");
    let locator = Locator::alloc(main_thread).set_ivars(LocatorIvars {
        events: cx.global::<TabEvents>().0.clone(),
        waiting: RefCell::default(),
    });
    let locator: Retained<Locator> = unsafe { msg_send![super(locator), init] };
    let manager = unsafe { CLLocationManager::new() };
    unsafe { manager.setDelegate(Some(ProtocolObject::from_ref(&*locator))) };
    cx.set_global(Location { manager, locator });
}

pub fn request(tab: u64, id: u64, cx: &App) {
    let location = cx.global::<Location>();
    location
        .locator
        .ivars()
        .waiting
        .borrow_mut()
        .push((tab, id));
    location.locator.proceed(&location.manager);
}
