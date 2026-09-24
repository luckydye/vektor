use std::rc::Rc;

use gpui::{
    App, IntoElement, MouseButton, RenderOnce, SharedString, Transformation, Window, div,
    percentage, prelude::*, px, svg,
};

use crate::palette::Palette;

#[derive(IntoElement)]
pub struct FindBar {
    pub query: SharedString,
    /// "2 of 5" / "No results"; absent while the query is empty.
    pub result: Option<SharedString>,
    pub focused: bool,
    pub palette: Palette,
    pub on_previous: Rc<dyn Fn(&mut Window, &mut App)>,
    pub on_next: Rc<dyn Fn(&mut Window, &mut App)>,
    pub on_dismiss: Rc<dyn Fn(&mut Window, &mut App)>,
}

fn icon_button(
    id: &'static str,
    icon: &'static str,
    rotation: f32,
    palette: Palette,
    on_click: Rc<dyn Fn(&mut Window, &mut App)>,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size_8()
        .rounded_md()
        .opacity(0.6)
        .hover(|button| button.opacity(1.))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| on_click(window, cx))
        .child(
            svg()
                .path(icon)
                .size(px(16.))
                .text_color(palette.foreground)
                .with_transformation(Transformation::rotate(percentage(rotation))),
        )
}

impl RenderOnce for FindBar {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let is_empty = self.query.is_empty();
        let palette = self.palette;

        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_end()
            .gap_1()
            .h(px(40.))
            .px_2()
            .bg(palette.background)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .w(px(280.))
                    .h_8()
                    .px_2()
                    .rounded_md()
                    .border_1()
                    .bg(palette.surface)
                    .border_color(if self.focused {
                        palette.muted
                    } else {
                        palette.border
                    })
                    .text_size(px(14.))
                    .child(
                        svg()
                            .path("icons/search.svg")
                            .size(px(14.))
                            .text_color(palette.muted),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .when(!is_empty, |field| {
                                field.text_color(palette.foreground).child(self.query)
                            })
                            .when(self.focused, |field| {
                                field.child(
                                    div()
                                        .flex_none()
                                        .w(px(1.))
                                        .h(px(16.))
                                        .bg(palette.foreground),
                                )
                            })
                            .when(is_empty, |field| {
                                field.text_color(palette.muted).child("Find in page")
                            }),
                    )
                    .children(self.result.map(|result| {
                        div()
                            .flex_none()
                            .text_size(px(12.))
                            .text_color(palette.muted)
                            .child(result)
                    })),
            )
            .child(icon_button(
                "find-previous",
                "icons/chevron-down.svg",
                0.5,
                palette,
                self.on_previous,
            ))
            .child(icon_button(
                "find-next",
                "icons/chevron-down.svg",
                0.,
                palette,
                self.on_next,
            ))
            .child(icon_button(
                "find-dismiss",
                "icons/cancel.svg",
                0.,
                palette,
                self.on_dismiss,
            ))
    }
}
