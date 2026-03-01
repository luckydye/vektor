import { type Easing, type InputState, Track, type Trait } from "@sv/elements/track";

export class DrawerTrack extends Track {
  public override traits: Trait[] = [
    {
      id: "drawer",
      input(track: DrawerTrack, inputState: InputState) {
        const openThresholdFixed = window.innerHeight / 2;
        const openThreshold = window.innerHeight - openThresholdFixed;

        if (track.position.y > openThreshold && !track.isOpen) {
          track.setOpen(true);
        }
        if (track.position.y < openThreshold && track.isOpen) {
          track.setOpen(false);
        }

        try {
          const scale = 1 - (track.position.y / window.innerHeight) * 0.075;
          const root = document.querySelector<HTMLDivElement>("#root");
          if (root) {
            if (scale > 0.999) {
              root.style.transform = ``;
            } else {
              root.style.transform = `scale(${scale})`;
            }
          }
        } catch (err) {
          console.error(err);
        }

        if (track.grabbing || track.interacting || track.target) return;
        if (track.deltaVelocity.y >= 0) return;
        if (track.isStatic) return;

        const vel = Math.round(track.velocity[track.currentAxis] * 10) / 10;
        const power = Math.round(vel / 15);

        if (power < 0) {
          track.minimize();
          track.dispatchEvent(new Event("minimize", { bubbles: true }));
        } else if (power > 0) {
          track.open();
          track.dispatchEvent(new Event("open", { bubbles: true }));
        } else {
          if (track.position.y > 400) {
            track.open();
            track.dispatchEvent(new Event("open", { bubbles: true }));
          } else if (track.position.y > 40) {
            track.minimize();
            track.dispatchEvent(new Event("minimize", { bubbles: true }));
          } else {
            track.collapse();
            track.dispatchEvent(new Event("collapse", { bubbles: true }));
          }
        }
      },
    },
  ];

  override transitionTime = 350;
  override drag = 0.98;
  isOpen = false;
  scrollContainer?: HTMLElement | null;
  clickTarget: HTMLElement | null = null;
  enabledDirection: 0 | 1 | null = null; // 1 for y 0 for x

  declare contentheight?: number;

  get isStatic() {
    return !!this.contentheight;
  }

  override onPointerUpOrCancel = (pointerEvent: PointerEvent) => {
    if (pointerEvent.type === "pointercancel") {
      return;
    }

    this.enabledDirection = null;
    this.clickTarget = null;

    // from original implementation
    this.mouseDown = false;
    this.mousePos.mul(0);

    if (this.grabbing) {
      this.grabbing = false;
      this.inputState.release.value = true;

      pointerEvent.preventDefault();
      pointerEvent.stopPropagation();
    }
  };

  constructor() {
    super();

    this.addEventListener("pointerdown", (e) => {
      if (this.isOpen) {
        this.clickTarget = e.target as HTMLElement;
      }
    });
    this.addEventListener("touchstart", (e) => {
      if (this.isOpen) {
        this.clickTarget = e.target as HTMLElement;
      }
    });

    this.addEventListener("click", (e) => {
      if (!this.isOpen) {
        this.open();
      }
    });

    this.vertical = true;
    this.overflow = "ignore";

    // ignore wheel interactions with the track
    // @ts-expect-error
    this.removeEventListener("wheel", this.onWheel, { passive: false });

    this.addEventListener("move", ((e: CustomEvent) => {
      const grabbing = this.grabbing; // the first move call is a check before grabbing is true, so false for the first event
      const dir = e.detail.delta;

      const directionThreshold = 0.1;

      // prevent scrolling on wrong direction, until touchend,
      /// This may be implemented in a-track, for nested tracks in general
      if (this.enabledDirection === null) {
        const direction = Math.abs(dir.x) - Math.abs(dir.y);
        if (direction > directionThreshold) {
          this.enabledDirection = 0;
        } else if (direction < directionThreshold) {
          this.enabledDirection = 1;
        }
      }

      // draw should not work if we scroll in a slider horizontally
      if (this.enabledDirection === 0) {
        e.preventDefault();
      }

      const scrollContainer = this.clickTarget?.closest("[data-scroll-container]");

      if (this.isOpen && !grabbing && scrollContainer) {
        if (scrollContainer?.scrollTop !== 0) {
          e.preventDefault();
        }
        if (scrollContainer?.scrollTop === 0 && dir.y < 0) {
          e.preventDefault();
        }
      }
    }) as EventListener);
  }

  static override get properties() {
    return {
      ...Track.properties,
      contentheight: { type: Number, reflect: true },
    };
  }

  setOpen(value: boolean) {
    this.isOpen = value;

    // dely event to prevent jank
    if (value === true) {
      this.dispatchEvent(new Event("open", { bubbles: true }));
    } else {
      this.dispatchEvent(new Event("minimize", { bubbles: true }));
    }
  }

  open(ease: Easing = "linear") {
    this.scrollContainer = this.querySelector("[data-scroll-container]");
    this.acceleration.mul(0.25);
    this.inputForce.mul(0.125);
    this.setTarget(this.getToItemPosition(1), ease);
  }

  minimize(ease: Easing = "linear") {
    let height = 200;
    if (this.isStatic) {
      const value = this.getAttribute("contentheight");
      const valueInt = value ? +value : Number.NaN;
      const openedPosition = this.getToItemPosition(1);
      height = valueInt > openedPosition.y ? openedPosition.y : valueInt;
    }

    this.acceleration.mul(0.25);
    this.inputForce.mul(0.125);
    this.setTarget([0, height], ease);
  }

  collapse(ease: Easing = "linear") {
    this.acceleration.mul(0.25);
    this.inputForce.mul(0.125);
    this.setTarget([0, 10], ease);
  }
}

customElements.define("drawer-track", DrawerTrack);
