use gpui::{Rgba, rgb, rgba};

/// Chrome colours derived from the page's top edge, so the bar blends into whatever the page
/// shows there, including dimmed dialog backdrops and dark themes.
#[derive(Clone, Copy)]
pub struct Palette {
    pub background: Rgba,
    pub foreground: Rgba,
    pub muted: Rgba,
    pub surface: Rgba,
    pub border: Rgba,
    pub hover: Rgba,
}

impl Palette {
    pub fn new(background: u32) -> Self {
        let background = rgb(background);
        let luminance = 0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b;
        if luminance > 0.5 {
            Self {
                background,
                foreground: rgb(0x141414),
                muted: rgba(0x14141499),
                surface: rgb(0xffffff),
                border: rgba(0x0000002e),
                hover: rgba(0x0000001a),
            }
        } else {
            Self {
                background,
                foreground: rgb(0xfbfbfb),
                muted: rgba(0xfbfbfb99),
                surface: rgba(0xffffff1a),
                border: rgba(0xffffff26),
                hover: rgba(0xffffff1a),
            }
        }
    }
}
