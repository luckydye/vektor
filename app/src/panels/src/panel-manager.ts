// Layered Panel Workspace — zero-dependency custom elements.
//
// Elements:
//   <panel-workspace>  root, stacks layers; exposes manager API as .manager
//   <panel-layer>      a static visual layer (background, map, canvas, etc.)
//   <panel-host>       the dynamic interactive panel layer; contains docks + floats
//   <panel-dock>       a dock zone inside a <panel-host>
//   <panel-item>       a single panel; declares id/title, hosts arbitrary slotted content
//
// The host is headless: it provides behavior (drag, resize, dock, focus, state)
// and the absolute minimum CSS required for layering + positioning. Visual
// chrome is left to the page.

export type Anchor = "left" | "right" | "top" | "bottom" | "center";

export type FloatingPlacement = {
  type: "floating";
  x: number;
  y: number;
  width: number;
  height: number;
};
export type DockedPlacement = { type: "docked"; dockId: string };
export type Placement = FloatingPlacement | DockedPlacement;

export type PanelVisibility = "open" | "minimized" | "hidden";

export type PanelLayoutState = {
  visibility: PanelVisibility;
  placement: Placement;
};

export type LayoutState = {
  panels: Record<string, PanelLayoutState>;
};

export type OpenOptions = {
  preferredDock?: string;
  fallback?: "floating" | string;
  placement?: Partial<Omit<FloatingPlacement, "type">>;
  title?: string;
};

export type DockInsets = { top: number; right: number; bottom: number; left: number };

type EventMap = {
  "panel-opened": { id: string };
  "panel-closed": { id: string };
  "panel-moved": { id: string; placement: Placement };
  "panel-docked": { id: string; dockId: string };
  "panel-focused": { id: string };
  "layout-changed": { state: LayoutState };
  "panel-insets-changed": { insets: DockInsets };
};

// --- small helper ---------------------------------------------------------

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Perpendicular distance from a point to a vertical line segment at x=sx,
// spanning [y1, y2]. Distance is 0 along the segment itself.
function distToVSegment(px: number, py: number, sx: number, y1: number, y2: number) {
  const dx = px - sx;
  const dy = py < y1 ? py - y1 : py > y2 ? py - y2 : 0;
  return Math.hypot(dx, dy);
}
function distToHSegment(px: number, py: number, sy: number, x1: number, x2: number) {
  const dy = py - sy;
  const dx = px < x1 ? px - x1 : px > x2 ? px - x2 : 0;
  return Math.hypot(dx, dy);
}

// --- <panel-dock> ---------------------------------------------------------

export class PanelDockElement extends HTMLElement {
  static get observedAttributes() {
    return ["anchor", "width", "height", "offset-start", "offset-end", "resizable"];
  }

  private _splitter: HTMLElement | null = null;

  connectedCallback() {
    if (!this.hasAttribute("role")) this.setAttribute("role", "region");
    this.applyStyle();
    this._ensureSplitter();
  }

  attributeChangedCallback() {
    this.applyStyle();
    this._ensureSplitter();
  }

  get dockId(): string {
    return this.id || this.getAttribute("dock-id") || "";
  }
  get anchor(): Anchor {
    return (this.getAttribute("anchor") as Anchor) || "center";
  }

  private applyStyle() {
    const s = this.style;
    const w = this.getAttribute("width");
    const h = this.getAttribute("height");
    // `offset-start` / `offset-end` crop the dock along its edge axis
    // (top/bottom for left|right docks, left/right for top|bottom docks).
    // The grid cell still claims its full column/row; the dock element
    // itself is shrunk by margins so the background shows through above
    // and below (or beside) a partial-length dock.
    const oStart = this.getAttribute("offset-start") ?? "0";
    const oEnd = this.getAttribute("offset-end") ?? "0";
    s.display = "flex";
    s.flexDirection = "column";
    s.overflow = "hidden";
    s.flex = "0 0 auto";
    s.position = "relative"; // splitter anchors here
    s.boxSizing = "border-box";
    // reset
    s.marginTop = s.marginBottom = s.marginLeft = s.marginRight = "0";
    switch (this.anchor) {
      case "left":
      case "right":
        s.width = w ?? "320px";
        s.height = "auto"; // stretch within cell minus margins
        s.marginTop = oStart;
        s.marginBottom = oEnd;
        break;
      case "top":
      case "bottom":
        s.height = h ?? "200px";
        s.width = "auto";
        s.marginLeft = oStart;
        s.marginRight = oEnd;
        break;
      case "center":
        s.flex = "1 1 auto";
        s.width = w ?? "auto";
        s.height = h ?? "auto";
        break;
    }
  }

  // ---- splitter for live resize -------------------------------------------

  private _ensureSplitter() {
    const allowed = this.getAttribute("resizable") !== "false" && this.anchor !== "center";
    if (!allowed) {
      this._splitter?.remove();
      this._splitter = null;
      return;
    }
    if (!this._splitter) {
      const el = document.createElement("div");
      el.dataset.splitter = "";
      Object.assign(el.style, {
        position: "absolute",
        background: "transparent",
        zIndex: "2",
      });
      el.addEventListener("pointerdown", (e) => this._beginSplitterDrag(e));
      this.append(el);
      this._splitter = el;
    }
    const s = this._splitter.style;
    s.top = s.bottom = s.left = s.right = s.width = s.height = "";
    switch (this.anchor) {
      case "left":
        s.top = s.bottom = "0";
        s.right = "-3px";
        s.width = "6px";
        s.cursor = "col-resize";
        break;
      case "right":
        s.top = s.bottom = "0";
        s.left = "-3px";
        s.width = "6px";
        s.cursor = "col-resize";
        break;
      case "top":
        s.left = s.right = "0";
        s.bottom = "-3px";
        s.height = "6px";
        s.cursor = "row-resize";
        break;
      case "bottom":
        s.left = s.right = "0";
        s.top = "-3px";
        s.height = "6px";
        s.cursor = "row-resize";
        break;
    }
  }

  private _beginSplitterDrag(ev: PointerEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const minW = Number(this.getAttribute("min-width")) || 40;
    const minH = Number(this.getAttribute("min-height")) || 40;
    const maxW = Number(this.getAttribute("max-width")) || Infinity;
    const maxH = Number(this.getAttribute("max-height")) || Infinity;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    const move = (e: PointerEvent) => {
      switch (this.anchor) {
        case "left":
          this.setAttribute("width", clampN(startW + (e.clientX - startX), minW, maxW) + "px");
          break;
        case "right":
          this.setAttribute("width", clampN(startW - (e.clientX - startX), minW, maxW) + "px");
          break;
        case "top":
          this.setAttribute("height", clampN(startH + (e.clientY - startY), minH, maxH) + "px");
          break;
        case "bottom":
          this.setAttribute("height", clampN(startH - (e.clientY - startY), minH, maxH) + "px");
          break;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}

function clampN(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// --- <panel-item> ---------------------------------------------------------

export class PanelItemElement extends HTMLElement {
  static get observedAttributes() {
    return ["title", "panel-title"];
  }

  // The host that currently owns this panel.
  _host: PanelHostElement | null = null;

  // Cached layout state for this panel.
  _state: PanelLayoutState = {
    visibility: "open",
    placement: { type: "floating", x: 40, y: 40, width: 320, height: 240 },
  };

  // Last known floating placement; survives docking so tear-out can restore size.
  _lastFloating: { x: number; y: number; width: number; height: number } | null = null;

  // Slotted titlebar element, lazily created if missing.
  private _titleBar: HTMLElement | null = null;

  private _initialized = false;
  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.setAttribute("role", "dialog");
      if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");

      const s = this.style;
      s.display = "flex";
      s.flexDirection = "column";
      s.boxSizing = "border-box";
      s.minWidth = "0";
      s.minHeight = "0";
      // Default to relative so the resize handle (position: absolute) anchors
      // here. float()/dock() override this — and crucially, we don't reset it
      // on subsequent reconnects (which fire when the host re-parents us
      // between docks and the floating layer; clobbering position there
      // breaks absolute placement).
      if (!s.position) s.position = "relative";
      s.background = s.background || "Canvas";
      s.color = s.color || "CanvasText";
      s.border = s.border || "1px solid currentColor";

      this.ensureTitleBar();
      this.addEventListener("pointerdown", this._onFocus, { capture: true });
    }
  }

  disconnectedCallback() {
    this.removeEventListener("pointerdown", this._onFocus, { capture: true } as any);
  }

  attributeChangedCallback() {
    if (this._titleBar) {
      const t = this._titleBar.querySelector("[data-panel-title]");
      if (t) t.textContent = this.panelTitle;
    }
  }

  get panelId(): string {
    return this.id;
  }
  get panelTitle(): string {
    return this.getAttribute("panel-title") || this.getAttribute("title") || this.id;
  }

  private _onFocus = () => {
    this._host?._focus(this.panelId);
  };

  // Build a default titlebar if the user didn't supply slot="titlebar".
  private ensureTitleBar() {
    const existing = this.querySelector(':scope > [slot="titlebar"]') as HTMLElement | null;
    if (existing) {
      this._titleBar = existing;
      this.wireTitleBar(existing);
      // ensure it comes first
      if (this.firstElementChild !== existing) this.prepend(existing);
      return;
    }
    const bar = document.createElement("header");
    bar.setAttribute("slot", "titlebar");
    bar.style.display = "flex";
    bar.style.alignItems = "center";
    bar.style.gap = "4px";
    bar.style.padding = "2px 6px";
    bar.style.cursor = "move";
    bar.style.userSelect = "none";
    bar.style.flex = "0 0 auto";

    const title = document.createElement("span");
    title.dataset.panelTitle = "";
    title.style.flex = "1 1 auto";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    title.style.whiteSpace = "nowrap";
    title.textContent = this.panelTitle;
    bar.append(title);

    const mkBtn = (label: string, action: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.all = "unset";
      b.style.cursor = "pointer";
      b.style.padding = "0 4px";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        action();
      });
      return b;
    };
    bar.append(mkBtn("×", () => this._host?.close(this.panelId)));

    this.prepend(bar);
    this._titleBar = bar;
    this.wireTitleBar(bar);
  }

  private wireTitleBar(bar: HTMLElement) {
    bar.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      this._host?._beginDrag(this, e);
    });
  }
}

// --- <panel-layer> --------------------------------------------------------

export class PanelLayerElement extends HTMLElement {
  connectedCallback() {
    const s = this.style;
    s.position = "absolute";
    s.inset = "0";
    s.display = "block";
    if (this.getAttribute("interactive") === "false") s.pointerEvents = "none";
    const z = this.getAttribute("z-index");
    if (z) s.zIndex = z;
  }
}

// --- <panel-host> ---------------------------------------------------------
//
// The dynamic layer. Children:
//   - any number of <panel-dock> elements
//   - a floating area (auto-created) holding floating <panel-item>s
//   - a fullscreen slot (auto-created) overlaying everything

export class PanelHostElement extends HTMLElement {
  static get observedAttributes() {
    return ["debug"];
  }

  private _docksWrap!: HTMLElement;
  private _floating!: HTMLElement;
  private _debugLayer: HTMLElement | null = null;
  private _zCounter = 10;
  private _focused: string | null = null;

  // panelId -> element (panels may be detached from DOM when hidden)
  private _panels = new Map<string, PanelItemElement>();

  connectedCallback() {
    const s = this.style;
    s.position = "absolute";
    s.inset = "0";
    s.display = "flex";
    s.flexDirection = "row";

    // Move any pre-existing <panel-dock> children into a docks row.
    this._docksWrap = document.createElement("div");
    this._docksWrap.dataset.role = "docks";
    Object.assign(this._docksWrap.style, {
      position: "absolute",
      inset: "0",
      display: "grid",
      // Sides-win (IDE-style): l and r are single spanning cells through all
      // three rows, so left/right docks claim the corners. Top/bottom docks
      // live only in the center column.
      gridTemplate:
        '"l t r" auto "l c r" 1fr "l b r" auto / auto 1fr auto',
      pointerEvents: "none",
    } as CSSStyleDeclaration);

    this._floating = document.createElement("div");
    this._floating.dataset.role = "floating";
    Object.assign(this._floating.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
    });

    // Inject wrappers, then route declared and late-arriving children. We
    // can't simply iterate this.children right now: when the HTML parser
    // fires our connectedCallback, our element's own children have not been
    // parsed yet, so any <panel-dock>/<panel-item> declared inside us would
    // be missed and end up as direct children of <panel-host> (which is a
    // flex row — they'd line up across the top of the viewport).
    this.append(this._docksWrap, this._floating);
    this._processDirectChildren();
    this._mo = new MutationObserver(() => this._processDirectChildren());
    this._mo.observe(this, { childList: true });

    if (this.hasAttribute("debug")) this._renderDebugOverlay();

    // Recompute insets when the host or any dock resizes (dock sizes can
    // be % based, and splitter drags resize docks live).
    this._insetRO = new ResizeObserver(() => {
      this._applyInsets();
      if (this.hasAttribute("debug")) this._renderDebugOverlay();
    });
    this._insetRO.observe(this);
    this._applyInsets();
  }

  private _insetRO: ResizeObserver | null = null;
  private _mo: MutationObserver | null = null;

  disconnectedCallback() {
    this._insetRO?.disconnect();
    this._insetRO = null;
    this._mo?.disconnect();
    this._mo = null;
  }

  /**
   * Route any direct children that are panel-docks or panel-items into their
   * proper internal wrapper. Safe to call repeatedly — idempotent for
   * already-routed children. Plain elements (overlays, author-supplied
   * content) are left alone.
   */
  private _processDirectChildren() {
    for (const child of Array.from(this.children)) {
      if (child instanceof PanelDockElement) {
        if (child.parentElement !== this._docksWrap) this._placeDock(child);
      } else if (child instanceof PanelItemElement) {
        if (child.parentElement !== this._floating) this._adoptPanel(child);
      }
    }
  }

  attributeChangedCallback(name: string) {
    if (name === "debug") {
      if (this.hasAttribute("debug")) this._renderDebugOverlay();
      else this._removeDebugOverlay();
    }
  }

  /** Toggle/set the dock-area debug overlay. */
  setDebug(on: boolean) {
    if (on) this.setAttribute("debug", "");
    else this.removeAttribute("debug");
  }

  private _renderDebugOverlay() {
    if (!this._debugLayer) {
      const el = document.createElement("div");
      el.dataset.role = "debug-overlay";
      Object.assign(el.style, {
        position: "absolute",
        inset: "0",
        pointerEvents: "none",
        zIndex: "9999",
        font: "11px ui-monospace, monospace",
      });
      this.append(el);
      this._debugLayer = el;
    }
    const host = this.getBoundingClientRect();
    this._debugLayer.replaceChildren();
    for (const dock of this.querySelectorAll<PanelDockElement>("panel-dock")) {
      const r = dock.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute",
        left: r.left - host.left + "px",
        top: r.top - host.top + "px",
        width: r.width + "px",
        height: r.height + "px",
        outline: "2px dashed magenta",
        outlineOffset: "-2px",
        background: "rgba(255, 0, 255, 0.08)",
        boxSizing: "border-box",
      });
      const label = document.createElement("div");
      Object.assign(label.style, {
        position: "absolute",
        left: "4px",
        top: "4px",
        padding: "2px 6px",
        background: "magenta",
        color: "white",
        borderRadius: "2px",
      });
      label.textContent = `${dock.dockId || "(no id)"} · ${dock.anchor} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      box.append(label);
      this._debugLayer.append(box);
    }

    // Keep the overlay in sync with size changes.
    if (!this._debugRO) {
      this._debugRO = new ResizeObserver(() => {
        if (this.hasAttribute("debug")) this._renderDebugOverlay();
      });
      this._debugRO.observe(this);
    }
  }

  private _debugRO: ResizeObserver | null = null;

  private _removeDebugOverlay() {
    this._debugLayer?.remove();
    this._debugLayer = null;
    this._debugRO?.disconnect();
    this._debugRO = null;
  }

  /**
   * Run a layout-mutating block inside a view transition so docking /
   * undocking animates as a smooth re-position. Falls back to running the
   * block synchronously when the View Transitions API isn't available.
   */
  // While the user is mid-drag, layout mutations (tear-out, snap-dock) must
  // commit instantly — running a 250ms cross-fade against a moving cursor
  // looks like input lag. Drag handlers set this flag around their internal
  // calls into dock/float.
  private _suppressTransitions = false;

  private _withTransition(panel: PanelItemElement, mutate: () => void, after?: () => void) {
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<unknown> };
    };
    if (this._suppressTransitions || typeof doc.startViewTransition !== "function") {
      mutate();
      after?.();
      return;
    }
    const prev = panel.style.viewTransitionName;
    // Stable per-panel name so the browser can match the "before" and
    // "after" rectangles across re-parenting.
    panel.style.viewTransitionName = `panel-${panel.id}`;
    const t = doc.startViewTransition(() => {
      // startViewTransition invokes this callback asynchronously (after the
      // "before" snapshot). Anything that reads the post-mutation DOM —
      // inset calc, event emission — must run *here*, not after the outer
      // call returns, or it will see stale state.
      mutate();
      after?.();
    });
    t.finished.finally(() => {
      panel.style.viewTransitionName = prev;
    });
  }

  // ---- public manager API (also reachable via element methods) -----------

  get manager() {
    return this;
  }

  open(id: string, opts: OpenOptions = {}) {
    let panel = this._panels.get(id);
    if (!panel) {
      // Late binding: maybe the user has a template/element with this id elsewhere.
      panel = (this.querySelector(`panel-item#${CSS.escape(id)}`) as PanelItemElement | null) ?? undefined;
      if (panel) this._adoptPanel(panel);
    }
    if (!panel) {
      panel = document.createElement("panel-item") as PanelItemElement;
      panel.id = id;
      if (opts.title) panel.setAttribute("panel-title", opts.title);
      this._adoptPanel(panel);
    }

    panel._state.visibility = "open";
    panel.style.display = "";

    const dockId = opts.preferredDock && this._findDock(opts.preferredDock) ? opts.preferredDock : null;
    // Initial placement shouldn't animate from the panel's transient
    // first-mount position into its target dock/float.
    this._suppressTransitions = true;
    try {
      if (dockId) {
        this.dock(id, dockId);
      } else if (opts.fallback && opts.fallback !== "floating" && this._findDock(opts.fallback)) {
        this.dock(id, opts.fallback);
      } else {
        const fp: FloatingPlacement = {
          type: "floating",
          x: opts.placement?.x ?? 40,
          y: opts.placement?.y ?? 40,
          width: opts.placement?.width ?? 320,
          height: opts.placement?.height ?? 240,
        };
        this.float(id, fp);
      }
    } finally {
      this._suppressTransitions = false;
    }
    this._focus(id);
    this._emit("panel-opened", { id });
    this._emitLayout();
    return panel;
  }

  close(id: string) {
    const p = this._panels.get(id);
    if (!p) return;
    p.remove();
    this._panels.delete(id);
    if (this._focused === id) this._focused = null;
    this._emit("panel-closed", { id });
    this._emitLayout();
  }

  hide(id: string) {
    const p = this._panels.get(id);
    if (!p) return;
    p._state.visibility = "hidden";
    p.style.display = "none";
    this._emitLayout();
  }

  minimize(id: string) {
    const p = this._panels.get(id);
    if (!p) return;
    p._state.visibility = "minimized";
    p.style.display = "none";
    this._emitLayout();
  }

  focusPanel(id: string) {
    this._focus(id);
  }

  dock(id: string, dockId: string) {
    const p = this._panels.get(id);
    const dock = this._findDock(dockId);
    if (!p || !dock) return;
    this._withTransition(
      p,
      () => {
        p._state.placement = { type: "docked", dockId };
        p._state.visibility = "open";
        dock.append(p);
        // reset floating styles AFTER reparent so the move-driven reconnect
        // can't clobber them.
        const s = p.style;
        s.position = "relative";
        s.left = s.top = s.width = s.height = s.zIndex = "";
        s.flex = "1 1 auto";
        s.display = "";
        dock.style.pointerEvents = "auto";
        const handle = p.querySelector(":scope > [data-resize]") as HTMLElement | null;
        if (handle) handle.style.display = "none";
      },
      () => {
        this._emit("panel-docked", { id, dockId });
        this._emit("panel-moved", { id, placement: p._state.placement });
        this._emitLayout();
      },
    );
  }

  float(id: string, placement: Partial<Omit<FloatingPlacement, "type">> = {}) {
    const p = this._panels.get(id);
    if (!p) return;
    const cur = p._state.placement.type === "floating" ? (p._state.placement as FloatingPlacement) : null;
    const fp: FloatingPlacement = {
      type: "floating",
      x: placement.x ?? cur?.x ?? 40,
      y: placement.y ?? cur?.y ?? 40,
      width: placement.width ?? cur?.width ?? 320,
      height: placement.height ?? cur?.height ?? 240,
    };
    this._withTransition(
      p,
      () => {
        p._state.placement = fp;
        p._lastFloating = { x: fp.x, y: fp.y, width: fp.width, height: fp.height };
        p._state.visibility = "open";
        // Reparent first; then set styles so an inadvertent reconnect can't
        // overwrite position.
        this._floating.append(p);
        const s = p.style;
        s.position = "absolute";
        s.left = fp.x + "px";
        s.top = fp.y + "px";
        s.width = fp.width + "px";
        s.height = fp.height + "px";
        s.flex = "";
        s.display = "";
        s.zIndex = String(++this._zCounter);
        this._floating.style.pointerEvents = "none";
        p.style.pointerEvents = "auto";
        this._ensureResizeHandle(p);
      },
      () => {
        this._emit("panel-moved", { id, placement: fp });
        this._emitLayout();
      },
    );
  }

  getState(): LayoutState {
    const panels: Record<string, PanelLayoutState> = {};
    for (const [id, p] of this._panels) {
      panels[id] = {
        visibility: p._state.visibility,
        placement: JSON.parse(JSON.stringify(p._state.placement)),
      };
    }
    return { panels };
  }

  setState(state: LayoutState) {
    for (const [id, ps] of Object.entries(state.panels)) {
      if (!this._panels.has(id)) {
        const el = document.createElement("panel-item") as PanelItemElement;
        el.id = id;
        this._adoptPanel(el);
      }
      const p = this._panels.get(id)!;
      p._state.visibility = ps.visibility;
      switch (ps.placement.type) {
        case "docked":
          this.dock(id, ps.placement.dockId);
          break;
        case "floating":
          this.float(id, ps.placement);
          break;
      }
      if (ps.visibility !== "open") {
        p.style.display = "none";
      }
    }
    this._emitLayout();
  }

  // ---- internals ---------------------------------------------------------

  _adoptPanel(panel: PanelItemElement) {
    if (!panel.id) panel.id = "panel-" + Math.random().toString(36).slice(2, 8);
    panel._host = this;
    this._panels.set(panel.id, panel);
    // Only move it if it's stray (not yet in floating, not in a dock).
    const parent = panel.parentElement;
    const inDock = parent instanceof PanelDockElement;
    if (parent !== this._floating && !inDock) {
      this._floating.append(panel);
    }
  }

  _findDock(dockId: string): PanelDockElement | null {
    return this.querySelector<PanelDockElement>(`panel-dock#${CSS.escape(dockId)}`);
  }

  private _placeDock(dock: PanelDockElement) {
    const a = dock.anchor;
    const area =
      a === "left" ? "l" : a === "right" ? "r" : a === "top" ? "t" : a === "bottom" ? "b" : "c";
    dock.style.gridArea = area;
    dock.style.pointerEvents = "auto";
    if (dock.parentElement !== this._docksWrap) this._docksWrap.append(dock);
    // Observe so live splitter drags update insets (and debug overlay).
    this._insetRO?.observe(dock);
  }

  _focus(id: string) {
    const p = this._panels.get(id);
    if (!p) return;
    if (p._state.placement.type === "floating") {
      p.style.zIndex = String(++this._zCounter);
    }
    if (this._focused !== id) {
      this._focused = id;
      this._emit("panel-focused", { id });
    }
  }

  // Distance (in px) from the cursor inside which we snap to a dock.
  private static SNAP_THRESHOLD = 64;

  private _snapOverlay: HTMLElement | null = null;
  private _ensureSnapOverlay(): HTMLElement {
    if (!this._snapOverlay) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        pointerEvents: "none",
        background: "currentColor",
        opacity: "0.15",
        display: "none",
        transition: "left 60ms, top 60ms, width 60ms, height 60ms",
      });
      this.append(el);
      this._snapOverlay = el;
    }
    return this._snapOverlay;
  }

  private _dockCandidate(clientX: number, clientY: number): PanelDockElement | null {
    const docks = this.querySelectorAll<PanelDockElement>("panel-dock");
    let best: { dock: PanelDockElement; d: number } | null = null;
    const thr = PanelHostElement.SNAP_THRESHOLD;
    for (const d of docks) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Distance from cursor to the dock's *anchor edge segment*, not its
      // whole rect — so dragging across the inside of a (possibly empty)
      // dock area doesn't snap by accident. The user has to get the cursor
      // close to the edge the dock is anchored to.
      let dist: number;
      switch (d.anchor) {
        case "left":
          dist = distToVSegment(clientX, clientY, r.left, r.top, r.bottom);
          break;
        case "right":
          dist = distToVSegment(clientX, clientY, r.right, r.top, r.bottom);
          break;
        case "top":
          dist = distToHSegment(clientX, clientY, r.top, r.left, r.right);
          break;
        case "bottom":
          dist = distToHSegment(clientX, clientY, r.bottom, r.left, r.right);
          break;
        case "center":
          continue; // center docks don't participate in edge snapping
      }
      if (dist <= thr && (!best || dist < best.d)) {
        best = { dock: d, d: dist };
      }
    }
    return best?.dock ?? null;
  }

  // Drag (called by panel titlebar). Works from floating *or* docked state
  // (docked panels tear out into floating once movement crosses a threshold).
  _beginDrag(panel: PanelItemElement, ev: PointerEvent) {
    ev.preventDefault();

    const startX = ev.clientX;
    const startY = ev.clientY;
    const hostRect = this.getBoundingClientRect();
    const wasDocked = panel._state.placement.type === "docked";

    // Snapshot floating origin. If currently docked we don't have one yet;
    // tear-out (below) computes one from the cursor + panel rect.
    let startLeft = 0;
    let startTop = 0;
    if (panel._state.placement.type === "floating") {
      startLeft = panel._state.placement.x;
      startTop = panel._state.placement.y;
    }

    let torn = !wasDocked;

    const tearOut = () => {
      // Use the last-known floating size, or a sensible default. The docked
      // rect (e.g. a full-height side dock) is the wrong size for a free
      // floating panel — using it makes the panel huge and hang offscreen.
      const last = panel._lastFloating;
      const w = last?.width ?? 320;
      const h = last?.height ?? 240;

      // Anchor the grab proportionally along the (docked) titlebar so the
      // cursor visually stays on the title bar after the resize.
      const dockedRect = panel.getBoundingClientRect();
      const bar = panel.firstElementChild as HTMLElement | null;
      const barRect = bar?.getBoundingClientRect() ?? dockedRect;
      const xProp = clamp((startX - barRect.left) / Math.max(1, barRect.width), 0, 1);
      const grabX = xProp * w;
      const barHeight = Math.min(barRect.height || 24, h);
      const grabY = clamp(startY - barRect.top, 0, barHeight - 1);

      startLeft = startX - hostRect.left - grabX;
      startTop = startY - hostRect.top - grabY;
      this._suppressTransitions = true;
      try {
        this.float(panel.panelId, { x: startLeft, y: startTop, width: w, height: h });
      } finally {
        this._suppressTransitions = false;
      }
      torn = true;
    };

    let snapTarget: PanelDockElement | null = null;
    const overlay = this._ensureSnapOverlay();

    const updateSnapOverlay = (dock: PanelDockElement | null) => {
      if (!dock) {
        overlay.style.display = "none";
        return;
      }
      const dr = dock.getBoundingClientRect();
      overlay.style.display = "block";
      overlay.style.left = dr.left - hostRect.left + "px";
      overlay.style.top = dr.top - hostRect.top + "px";
      overlay.style.width = dr.width + "px";
      overlay.style.height = dr.height + "px";
    };

    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!torn) {
        if (Math.abs(dx) + Math.abs(dy) < 6) return;
        tearOut();
      }
      const placement = panel._state.placement as FloatingPlacement;
      const maxX = hostRect.width - 40;
      const maxY = hostRect.height - 24;
      const nx = clamp(startLeft + dx, 0, Math.max(0, maxX));
      const ny = clamp(startTop + dy, 0, Math.max(0, maxY));
      panel.style.left = nx + "px";
      panel.style.top = ny + "px";
      placement.x = nx;
      placement.y = ny;

      snapTarget = this._dockCandidate(e.clientX, e.clientY);
      updateSnapOverlay(snapTarget);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      overlay.style.display = "none";
      if (torn && panel._state.placement.type === "floating") {
        const fp = panel._state.placement;
        panel._lastFloating = { x: fp.x, y: fp.y, width: fp.width, height: fp.height };
      }
      if (snapTarget) {
        this._suppressTransitions = true;
        try {
          this.dock(panel.panelId, snapTarget.dockId);
        } finally {
          this._suppressTransitions = false;
        }
        return;
      }
      if (torn) {
        this._emit("panel-moved", { id: panel.panelId, placement: panel._state.placement });
        this._emitLayout();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private _ensureResizeHandle(panel: PanelItemElement) {
    let h = panel.querySelector(":scope > [data-resize]") as HTMLElement | null;
    if (!h) {
      h = document.createElement("div");
      h.dataset.resize = "";
      Object.assign(h.style, {
        position: "absolute",
        right: "0",
        bottom: "0",
        width: "14px",
        height: "14px",
        cursor: "nwse-resize",
        background:
          "linear-gradient(135deg, transparent 50%, currentColor 50%, currentColor 60%, transparent 60%, transparent 70%, currentColor 70%, currentColor 80%, transparent 80%)",
        opacity: "0.5",
      });
      panel.append(h);
      h.addEventListener("pointerdown", (e) => this._beginResize(panel, e));
    }
    h.style.display = panel._state.placement.type === "floating" ? "" : "none";
  }

  private _beginResize(panel: PanelItemElement, ev: PointerEvent) {
    if (panel._state.placement.type !== "floating") return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = panel._state.placement.width;
    const startH = panel._state.placement.height;
    const move = (e: PointerEvent) => {
      const w = Math.max(80, startW + (e.clientX - startX));
      const h = Math.max(48, startH + (e.clientY - startY));
      panel.style.width = w + "px";
      panel.style.height = h + "px";
      const fp = panel._state.placement as FloatingPlacement;
      fp.width = w;
      fp.height = h;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._emit("panel-moved", { id: panel.panelId, placement: panel._state.placement });
      this._emitLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---- events ------------------------------------------------------------

  on<K extends keyof EventMap>(type: K, listener: (detail: EventMap[K]) => void) {
    const h = (e: Event) => listener((e as CustomEvent<EventMap[K]>).detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  private _emit<K extends keyof EventMap>(type: K, detail: EventMap[K]) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }

  private _emitLayout() {
    this._emit("layout-changed", { state: this.getState() });
    this._applyInsets();
    if (this.hasAttribute("debug")) this._renderDebugOverlay();
  }

  /**
   * The pixel area currently occupied by docks that hold at least one open
   * panel. Lower layers (background, map, canvas, ...) can use this to keep
   * their important content out from under the panels.
   */
  getInsets(): DockInsets {
    let top = 0,
      right = 0,
      bottom = 0,
      left = 0;
    const hostRect = this.getBoundingClientRect();
    for (const dock of this.querySelectorAll<PanelDockElement>("panel-dock")) {
      const hasOpen = Array.from(dock.children).some(
        (c) => c instanceof PanelItemElement && (c as PanelItemElement)._state.visibility === "open",
      );
      if (!hasOpen) continue;
      const r = dock.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      switch (dock.anchor) {
        case "left":
          left = Math.max(left, r.right - hostRect.left);
          break;
        case "right":
          right = Math.max(right, hostRect.right - r.left);
          break;
        case "top":
          top = Math.max(top, r.bottom - hostRect.top);
          break;
        case "bottom":
          bottom = Math.max(bottom, hostRect.bottom - r.top);
          break;
        case "center":
          // center docks float over the layer's middle; they don't push the
          // background's safe area at the edges.
          break;
      }
    }
    return { top, right, bottom, left };
  }

  private _lastInsets: DockInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private _applyInsets() {
    const insets = this.getInsets();
    const last = this._lastInsets;
    if (
      insets.top === last.top &&
      insets.right === last.right &&
      insets.bottom === last.bottom &&
      insets.left === last.left
    )
      return;
    this._lastInsets = insets;
    const target = (this.closest("panel-workspace") as HTMLElement | null) ?? this;
    target.style.setProperty("--panel-inset-top", insets.top + "px");
    target.style.setProperty("--panel-inset-right", insets.right + "px");
    target.style.setProperty("--panel-inset-bottom", insets.bottom + "px");
    target.style.setProperty("--panel-inset-left", insets.left + "px");
    this._emit("panel-insets-changed", { insets });
  }
}

// --- <panel-workspace> ----------------------------------------------------

export class PanelWorkspaceElement extends HTMLElement {
  connectedCallback() {
    const s = this.style;
    s.position = s.position || "relative";
    s.display = "block";
    if (!s.width) s.width = "100%";
    if (!s.height) s.height = "100%";
    s.overflow = "hidden";
  }

  /** Convenience: returns the first <panel-host> descendant. */
  get host(): PanelHostElement | null {
    return this.querySelector("panel-host");
  }

  /** Convenience: proxies to the host's manager. */
  get manager(): PanelHostElement | null {
    return this.host;
  }
}

// --- registration ---------------------------------------------------------

export function definePanelElements() {
  if (!customElements.get("panel-workspace"))
    customElements.define("panel-workspace", PanelWorkspaceElement);
  if (!customElements.get("panel-layer"))
    customElements.define("panel-layer", PanelLayerElement);
  if (!customElements.get("panel-host")) customElements.define("panel-host", PanelHostElement);
  if (!customElements.get("panel-dock")) customElements.define("panel-dock", PanelDockElement);
  if (!customElements.get("panel-item")) customElements.define("panel-item", PanelItemElement);
}

definePanelElements();
