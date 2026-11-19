//! Two-finger pinch recognition (a local addition; upstream has none, and
//! GPUI's portable recognizer ignores additional touches).
//!
//! While two fingers are down they pinch: the touch GPUI was tracking is
//! cancelled (no scroll or tap comes of it) and the change in distance between
//! the fingers goes out as `PinchEvent`s at their midpoint. Every finger of a
//! pinch stays away from GPUI's touch recognition until the last one lifts.

use std::collections::{HashMap, HashSet};

use gpui::{Modifiers, PinchEvent, Pixels, PlatformInput, Point, TouchPhase};

#[derive(Default)]
pub struct PinchTracker {
    /// Fingers down (Android pointer id → position).
    down: HashMap<i32, Point<Pixels>>,
    /// Fingers taken from GPUI's touch recognition by a pinch.
    claimed: HashSet<i32>,
    /// Distance between the two pinching fingers at the last event.
    distance: Option<f32>,
}

/// What to do with a touch event.
pub enum Route {
    /// Hand it to GPUI's touch recognition.
    Touch,
    /// A pinch began: cancel the touch GPUI is tracking, then send this.
    StartPinch(PlatformInput),
    /// Send this instead of the touch.
    Pinch(PlatformInput),
    /// Drop it (a finger of a pinch).
    Swallow,
}

impl PinchTracker {
    pub fn route(
        &mut self,
        pointer: i32,
        phase: TouchPhase,
        position: Point<Pixels>,
    ) -> Route {
        match phase {
            TouchPhase::Started => {
                self.down.insert(pointer, position);
                if self.down.len() == 2 && self.claimed.is_empty() {
                    self.claimed.extend(self.down.keys().copied());
                    self.distance = Some(self.span());
                    return Route::StartPinch(self.event(0., TouchPhase::Started));
                }
                if !self.claimed.is_empty() {
                    // A third finger, or one landing while a pinch winds down.
                    self.claimed.insert(pointer);
                    return Route::Swallow;
                }
                Route::Touch
            }
            TouchPhase::Moved => {
                self.down.insert(pointer, position);
                if !self.claimed.contains(&pointer) {
                    return Route::Touch;
                }
                match (self.distance, self.down.len()) {
                    (Some(last), 2) => {
                        let distance = self.span();
                        self.distance = Some(distance);
                        Route::Pinch(self.event(distance / last - 1., TouchPhase::Moved))
                    }
                    _ => Route::Swallow,
                }
            }
            TouchPhase::Ended | TouchPhase::Cancelled => {
                self.down.remove(&pointer);
                if !self.claimed.remove(&pointer) {
                    return Route::Touch;
                }
                if self.distance.take().is_some() {
                    return Route::Pinch(self.event(0., TouchPhase::Ended));
                }
                Route::Swallow
            }
        }
    }

    fn span(&self) -> f32 {
        let mut points = self.down.values();
        let (a, b) = (points.next().unwrap(), points.next().unwrap());
        let (dx, dy) = (f32::from(a.x - b.x), f32::from(a.y - b.y));
        (dx * dx + dy * dy).sqrt().max(1.)
    }

    fn event(&self, delta: f32, phase: TouchPhase) -> PlatformInput {
        let (sum, count) = self
            .down
            .values()
            .fold((Point::default(), 0.), |(sum, count), p| {
                (sum + *p, count + 1.)
            });
        PlatformInput::Pinch(PinchEvent {
            position: sum / count,
            delta,
            modifiers: Modifiers::default(),
            phase,
        })
    }
}
