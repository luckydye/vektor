use std::rc::Rc;

use gpui::{
    App, ElementId, IntoElement, MouseButton, RenderOnce, SharedString, Window, div, prelude::*,
    px, rgba, svg,
};

use crate::palette::Palette;

pub struct TabLabel {
    pub title: SharedString,
}

/// Mirrors the web kit's `Tabs`: the active tab is an outlined pill.
#[derive(IntoElement)]
pub struct TabBar {
    pub tabs: Vec<TabLabel>,
    pub active: usize,
    pub palette: Palette,
    /// Leaves room for the macOS traffic lights, which are hidden in fullscreen.
    pub leading_inset: bool,
    pub on_select: Rc<dyn Fn(usize, &mut Window, &mut App)>,
    pub on_close: Rc<dyn Fn(usize, &mut Window, &mut App)>,
    pub on_new: Rc<dyn Fn(&mut Window, &mut App)>,
}

impl RenderOnce for TabBar {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let palette = self.palette;
        let tabs = self.tabs.into_iter().enumerate().map(|(index, tab)| {
            let is_active = index == self.active;
            let on_select = self.on_select.clone();
            let on_close = self.on_close.clone();

            div()
                .id(ElementId::Integer(index as u64))
                .group("tab")
                .flex()
                .flex_shrink()
                .items_center()
                .gap_1()
                .h_8()
                .w(px(200.))
                .min_w(px(72.))
                .pl_4()
                .pr_1()
                .rounded_md()
                .border_1()
                .text_size(px(14.))
                .text_color(palette.foreground)
                .when(is_active, |tab| {
                    tab.bg(palette.surface).border_color(palette.border)
                })
                .when(!is_active, |tab| {
                    tab.border_color(rgba(0x00000000))
                        .opacity(0.6)
                        .hover(|tab| tab.opacity(1.))
                })
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_select(index, window, cx);
                })
                .child(div().flex_1().truncate().child(tab.title))
                .child(
                    div()
                        .id("close")
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(20.))
                        .rounded_sm()
                        .invisible()
                        .when(is_active, |close| close.visible())
                        .group_hover("tab", |close| close.visible())
                        .hover(|close| close.bg(palette.hover))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(move |_, window, cx| on_close(index, window, cx))
                        .child(
                            svg()
                                .path("icons/cancel.svg")
                                .size(px(14.))
                                .text_color(palette.muted),
                        ),
                )
        });
        let on_new = self.on_new;

        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_1()
            .h(px(48.))
            .px_2()
            .when(self.leading_inset, |bar| bar.pl(px(92.)))
            .bg(palette.background)
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(div().flex().min_w_0().p(px(2.)).children(tabs))
            .child(
                div()
                    .id("new-tab")
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size_8()
                    .rounded_md()
                    .opacity(0.6)
                    .hover(|button| button.opacity(1.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, window, cx| on_new(window, cx))
                    .child(
                        svg()
                            .path("icons/add.svg")
                            .size(px(16.))
                            .text_color(palette.foreground),
                    ),
            )
    }
}
