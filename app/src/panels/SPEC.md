# Layered Panel Workspace — Specification

## 1. Goal

A web component system for application authors to compose **layered UI
surfaces**. The top layer hosts dynamic, movable panels (drag, dock, resize,
close); lower layers carry static or semi-static content (background image,
canvas, map, video, dashboard) and remain visible behind transparent areas
of the panel layer.

The name **Layered Panel Workspace** captures the full scope better than
"tiling panel manager" — the system covers floating, docking, *and* layered
composition.

## 2. Layers

A workspace contains an ordered stack of layers, front-to-back. Two kinds of
layer exist in this base system:

- **Background layers** — non-interactive (`pointer-events: none` by
  default); arbitrary author content.
- **Panel layer** — exactly one; hosts the panels and dock zones described
  below.

Lower layers must remain visible behind the panel layer wherever the panel
layer has no opaque content. Only interactive layers receive pointer events;
unhit areas of the panel layer must not steal clicks from layers below.

## 3. Panels

A panel is a rectangular region of slotted content with an `id` and a title.
Its `visibility` is one of `open`, `minimized`, `hidden`. Its `placement`
is one of two shapes:

- **floating** — free `{ x, y, width, height }` inside the panel layer.
- **docked** — bound to a `dockId`.

There is no `fullscreen` / `maximized` placement. If an author wants that
effect, they declare a dock that fills the viewport and dock the panel into
it. Keeping the placement model closed under docking eliminates a parallel,
ad-hoc maximized state.

## 4. Dock zones

The author declares dock zones; each has an `id`, an `anchor` of
`left | right | top | bottom | center`, and optional size constraints
(`width`, `height`, `min*`, `max*`).

### 4.1 Edge offsets

A dock occupies its anchor edge by default, but may be cropped along that
edge by two scalar offsets — `offset-start` and `offset-end` — measured
inwards from the edge's start and end:

- Side docks (`left` / `right`): `offset-start` is distance from the top of
  the edge, `offset-end` from the bottom.
- Top/bottom docks: `offset-start` is distance from the left, `offset-end`
  from the right.

A partial-length dock leaves the unclaimed portions of its edge transparent
so the background layer shows through. The dock's *column* (or row) still
reserves its full width (or height) — top/bottom docks remain confined
between the side docks' columns even when those sides are cropped — so
corner ownership stays predictable.

### 4.2 Corner ownership (sides-win)

When edge docks coexist with top/bottom docks, **the sides own the
corners**. Left/right docks extend the full height of the panel layer;
top/bottom docks live only in the center column between them:

```
┌─────┬──────────┬─────┐
│     │   top    │     │
│ L   ├──────────┤  R  │
│     │  center  │     │
│     ├──────────┤     │
│     │  bottom  │     │
└─────┴──────────┴─────┘
```

This is a fixed rule, not a runtime option — it matches the dominant
desktop-IDE convention and avoids the two empty corner rectangles a naive
3×3 grid would leave showing the background layer through.

## 5. Opening a panel

`open(id, options)` requests a placement. Options include
`preferredDock`, a `fallback` ("floating" or another dock id), an initial
floating `placement`, and a `title`. The manager picks the final position
from: available docks, current occupancy, panel constraints, viewport size,
and any author-defined rules.

## 6. Floating panels

Floating panels are positioned absolutely inside the panel layer's floating
area. Their `x` / `y` are coordinates within that area — not offsets from
siblings, the cursor, or any "natural flow" position. A floating panel with
`y === 0` sits at the top edge of the panel layer regardless of how many
other panels exist, whether it was previously docked, or whether the host
re-parented it internally.

Implementations that re-parent panels between docks and the floating area
must keep the effective CSS `position` as `absolute` for floating and
`relative` (or equivalent) for docked — and must not let side effects of
re-parenting (e.g., custom-element reconnect callbacks) silently reset it.

Floating panels support: drag, resize, focus ordering, snap-to-dock (§7.1),
bounds checking, optional collision avoidance.

### 6.1 Drag invariants

These are non-negotiable. Failing any is a bug, not a styling choice.

- **One-to-one tracking.** Panel movement per frame equals cursor delta
  (`Δpanel = Δcursor`). The drag origin must be a snapshot taken at
  `pointerdown`; mutating live placement during `pointermove` and re-reading
  it next frame causes compounding deltas. The panel must never accelerate
  away from the cursor.
- **Grab anchoring.** The cursor stays anchored to the exact pixel on the
  titlebar where the drag started, including immediately after a tear-out
  from a dock (§7.2).

### 6.2 Resize

Every floating panel exposes a visible resize affordance (default: a corner
handle at bottom-right). The affordance is hidden while the panel is
docked.

## 7. Docked panels

Docked panels are bound to a dock zone. They may be fixed-size, resizable,
collapsible, stacked, or tabbed.

### 7.0 Resizing a docked panel

A docked panel is resized by resizing its dock. Each edge dock exposes a
draggable splitter on its inner edge — the edge that faces the panel
layer's center:

- Left dock → splitter on its right edge.
- Right dock → splitter on its left edge.
- Top dock → splitter on its bottom edge.
- Bottom dock → splitter on its top edge.

The splitter shows the appropriate resize cursor (`col-resize` /
`row-resize`), captures the pointer, and updates the dock's `width`
(side docks) or `height` (top/bottom docks) live. The panel inside fills
the dock, so it follows the splitter without further coordination.

Author may suppress the splitter with `resizable="false"` on the dock,
and constrain the range with `min-width` / `max-width` /
`min-height` / `max-height` attributes. `center` docks have no splitter.

Live resize must update the dock-aware insets (§8) and the debug overlay
(§15) on every frame, not just on pointer-up — so lower layers reflow as
the user drags.

### 7.1 Snap-to-dock

While a floating panel is being dragged, the manager continuously measures
the cursor's distance to each dock's **anchor edge segment** — not its full
bounding box. The anchor edge is the line the dock is attached to:

- `left` → the dock's left edge (a vertical segment).
- `right` → the dock's right edge.
- `top` → the dock's top edge (a horizontal segment).
- `bottom` → the dock's bottom edge.
- `center` → does not participate in edge snapping.

If the cursor is within a small proximity threshold of an anchor segment,
that dock becomes the **snap candidate** and is highlighted (translucent
overlay of the dock's box) so the user can see where release will land it.

Using the anchor segment instead of the dock's whole rect prevents
accidental docking when a user drags a floating panel *through* a docked
region on the way somewhere else — the cursor has to deliberately approach
the edge the dock owns.

- If multiple docks qualify, the nearest one wins.
- On `pointerup` with a candidate, the panel commits into that dock through
  the same code path as `dock(id, dockId)`; `panel-docked` and
  `layout-changed` fire.
- On `pointerup` with no candidate, the panel remains floating.

The threshold is a hint, not a force-field — users must remain able to
release a panel *near* a dock without snapping. Authors must be able to
tune or disable it.

### 7.2 Tear-out from dock

Docked panels are draggable out of their dock by grabbing the titlebar. The
docked → floating transition happens once the pointer crosses a small
movement threshold (a few pixels), so a click can't tear out by accident.

- **Sizing.** The new floating panel adopts the panel's last-known floating
  size if one exists, otherwise a sensible default (≈ 320×240). It must
  *not* reuse the docked rect — side docks are typically full-height and
  would produce a panel that dwarfs the viewport.
- **Cursor anchoring.** The grab point is mapped proportionally onto the
  new (smaller) titlebar: if the user grabbed at horizontal fraction `p` of
  the docked titlebar, the floating panel is positioned so the grab lands
  at fraction `p` of its titlebar. Vertical offset within the titlebar is
  preserved.

This applies on every tear-out, including repeated tear-outs after
re-docking.

## 8. Layer composition & lower-layer awareness

Lower layers (backgrounds, maps, canvases, dashboards) must be able to lay
out their important content so it is not hidden by a populated dock. The
panel manager publishes the current footprint of occupied docks as four
edge insets, in two complementary ways:

1. **CSS custom properties** on the workspace root —
   `--panel-inset-top`, `--panel-inset-right`, `--panel-inset-bottom`,
   `--panel-inset-left` — consumable declaratively:

   ```css
   .map { padding-left: var(--panel-inset-left, 0); }
   ```

2. **`panel-insets-changed` event** with `detail: { insets }` for code that
   needs to react imperatively (camera recentering, etc.).

### 8.1 Inset rules

- An inset is non-zero exactly when at least one dock on that edge contains
  an **open** panel. Empty docks contribute nothing, even with a declared
  size.
- `center` anchors never contribute to edge insets.
- Multiple docks on the same edge collapse to the maximum extent.
- Insets update on every layout change (open/close/dock/undock) and on
  workspace resize, and only when the values actually change.

### 8.2 Why insets and not a hit-test API

A generic hit-test ("which layers cover point (x, y)?") is more powerful
but forces every lower-layer author into per-frame JS. Per-edge insets
cover the dominant use case — *keep important content out from under the
bars* — declaratively, and the event is available when the dominant case
isn't enough.

### 7.3 Animated transitions

Programmatic dock / undock operations (`dock()`, `float()`, button-driven
re-layouts, `setState()` restores) animate the panel smoothly between its
before and after rectangles using the browser's View Transitions API when
available. Each panel uses a stable view-transition name so the browser
pairs the two snapshots across re-parenting.

Animations are **suppressed** in three cases where they would feel like lag
rather than polish:

- During an active pointer drag — tear-out and snap-on-release commit
  instantly so the panel keeps tracking the cursor.
- On a panel's first appearance (`open()`'s initial placement) — there is
  no meaningful "before" rectangle.
- When the View Transitions API is unavailable; the mutation runs
  synchronously.

The animation is a visual nicety, never a state machine — the layout is
considered committed the moment the mutation runs, before the animation
finishes. Events (`panel-docked`, `panel-moved`, `layout-changed`) fire on
commit, not on animation end.

## 9. Programmatic API

The minimum surface of the panel manager:

- `open(id, options)`
- `close(id)`
- `hide(id)` / `minimize(id)`
- `focusPanel(id)`
- `dock(id, dockId)`
- `float(id, placement?)`
- `getInsets()` — current `{ top, right, bottom, left }`.
- `getState()` / `setState(state)` — serializable layout state for
  persistence, restore, undo/redo, collaborative sync.

## 10. Events

- `panel-opened` `{ id }`
- `panel-closed` `{ id }`
- `panel-moved` `{ id, placement }`
- `panel-docked` `{ id, dockId }`
- `panel-focused` `{ id }`
- `layout-changed` `{ state }`
- `panel-insets-changed` `{ insets }`

All events bubble from the panel host as `CustomEvent`s.

## 11. Declared children & parser ordering

Authors must be able to declare docks and panels as direct HTML children of
the panel host, and the implementation must route them into the correct
internal arrangement regardless of when they appear:

- Children present at parse time must work even though the HTML parser
  fires the host's connect callback *before* the host's own children are
  parsed.
- Children added later (imperative DOM mutations, framework rendering, late
  registration) must work too.

The host catches both cases — typically by observing its own child list and
re-routing any stray dock/panel into the right wrapper. The behavior is
required; the mechanism (MutationObserver vs. equivalent) is not.

## 12. Default titlebar controls

When a panel does not supply its own titlebar, the default chrome exposes
**only `close`**. Controls that put the panel into a state the user cannot
leave without additional, author-provided UI must not appear in the
default titlebar. Specifically excluded:

- **minimize** — no defined restore affordance in the base system; the
  default chrome would orphan the panel.
- **fullscreen / maximize** — not a defined placement at all (§3).
- dock-to-X, tab-split, etc.

These actions remain on the programmatic API. Authors may add buttons for
them in a custom titlebar (via a `titlebar` slot) once they also provide
the matching restore UI. Adding unspecified affordances to the default
chrome is a spec violation.

## 13. Responsiveness

Dock zones may behave differently at different viewport sizes (e.g.,
collapse a sidebar below 800px, or convert it to floating). The mechanism
is author-driven and not prescribed here.

## 14. Accessibility

Panels support keyboard focus management, keyboard move/resize, ARIA
labels, escape-to-close where appropriate, logical tab order, and
screen-reader-friendly titles.

## 15. Debug overlay

The panel host exposes an opt-in overlay that visualizes every defined
dock as a bounding box with a label (`id`, `anchor`, current size). The
overlay is purely visual (no pointer interception), refreshes on host
resize and layout change, and is toggled via a boolean attribute on the
host (or an equivalent imperative API). It is a developer affordance with
no styling guarantees beyond legibility.

## 16. Non-goals

- Managing browser windows.
- Replacing the application router.
- Enforcing a single visual style — the system is headless; styling is the
  author's responsibility beyond the minimum needed for layering and
  positioning.
- Non-rectangular panels (rectangular is the default and only base model).

## 17. Example use case

An image-editing application defines a static canvas background layer and
a panel layer containing a left toolbar, a right inspector, a floating
color picker, a floating histogram, and an export dialog that opens into a
viewport-filling dock zone. The inspector docks right, the color picker
opens floating with an initial placement, and the background reflows
itself via the `--panel-inset-*` variables as docks fill or empty.
