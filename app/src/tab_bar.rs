use std::rc::Rc;

use gpui::{
    App, Context, ElementId, IntoElement, MouseButton, Render, RenderOnce, SharedString, Window,
    div, prelude::*, px, rgba, svg,
};

use crate::{palette::Palette, titlebar};

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
    /// Moves the tab at the first index to the second.
    pub on_move: Rc<dyn Fn(usize, usize, &mut Window, &mut App)>,
    pub on_new: Rc<dyn Fn(&mut Window, &mut App)>,
}

impl RenderOnce for TabBar {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let palette = self.palette;
        let tabs = self.tabs.into_iter().enumerate().map(|(index, tab)| {
            let is_active = index == self.active;
            let on_select = self.on_select.clone();
            let on_close = self.on_close.clone();
            let on_move = self.on_move.clone();
            let dragged = DraggedTab {
                index,
                title: tab.title.clone(),
                palette,
            };

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
                .on_drag(dragged, |dragged, _, _, cx| cx.new(|_| dragged.clone()))
                .drag_over::<DraggedTab>(move |tab, _, _, _| tab.bg(palette.hover))
                .on_drop(move |dragged: &DraggedTab, window, cx| {
                    on_move(dragged.index, index, window, cx)
                })
                // `truncate()` never ellipsizes: with `nowrap` gpui keeps the first, width-less measurement.
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .text_ellipsis()
                        .line_clamp(1)
                        .child(tab.title),
                )
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
                    titlebar::drag_window(window);
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

/// The tab being dragged, rendered under the cursor as the active pill.
#[derive(Clone)]
pub struct DraggedTab {
    pub index: usize,
    pub title: SharedString,
    pub palette: Palette,
}

impl Render for DraggedTab {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .items_center()
            .h_8()
            .w(px(200.))
            .pl_4()
            .pr_1()
            .rounded_md()
            .border_1()
            .bg(self.palette.surface)
            .border_color(self.palette.border)
            .text_size(px(14.))
            .text_color(self.palette.foreground)
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .text_ellipsis()
                    .line_clamp(1)
                    .child(self.title.clone()),
            )
    }
}
