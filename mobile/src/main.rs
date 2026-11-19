//! Entry point on iOS, and for running the touch UI on a desktop while developing. Android enters
//! through `android_main` (see `android.rs`).

fn main() {
    vektor_mobile::run(gpui_platform::application());
}
