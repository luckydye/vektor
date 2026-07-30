import "#cosmetics/CosmeticElement.ts";
import { selectToolIcon } from "~/src/assets/icons.ts";

const canvasPresenceCursorTag = "canvas-presence-cursor";

const styles = `
  :host {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 8;
    display: block;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  [hidden] {
    display: none;
  }

  .cursor {
    position: absolute;
    left: -3px;
    top: -3px;
    width: 24px;
    height: 24px;
    color: var(--presence-color);
    transform: scaleX(-1);
    filter: drop-shadow(0 1px 1.5px rgba(15, 23, 42, 0.3));
  }

  .cursor svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .label {
    position: absolute;
    left: 14px;
    top: 16px;
    border-radius: 4px;
    background: var(--presence-color);
    padding: 3px 6px;
    color: var(--canvas-presence-text);
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: normal;
    white-space: nowrap;
  }

  .companion {
    position: absolute;
    left: 20px;
    top: -24px;
    width: 44px;
    height: 40px;
    opacity: 1;
    filter: drop-shadow(0 2px 2px rgba(15, 23, 42, 0.2));
    transition: opacity 100ms ease;
  }

  .companion.is-colliding {
    opacity: 0.25;
  }

`;

const CURSOR_FOLLOW_MS = 45;
const COMPANION_SPRING_FREQUENCY = 14;
const COMPANION_SPRING_DAMPING = 0.8;
const MAX_COMPANION_SPEED_PX_PER_SECOND = 1_600;
const POSITION_EPSILON = 0.05;
const VELOCITY_EPSILON = 0.05;
const CURSOR_BOUNDS = { left: -3, top: -3, right: 21, bottom: 21 };
const COMPANION_BOUNDS = { left: 24, top: -20, right: 60, bottom: 12 };

const CanvasPresenceCursorElement =
  typeof HTMLElement === "undefined"
    ? undefined
    : class CanvasPresenceCursorElement extends HTMLElement {
        static observedAttributes = [
          "class",
          "companion-id",
          "hide-label",
          "hide-pointer",
          "name",
          "x",
          "y",
        ];

        private readonly cursor: HTMLDivElement;
        private readonly label: HTMLSpanElement;
        private readonly companion: HTMLElement;
        private targetX = 0;
        private targetY = 0;
        private cursorX = 0;
        private cursorY = 0;
        private companionX = 0;
        private companionY = 0;
        private companionVelocityX = 0;
        private companionVelocityY = 0;
        private hasPosition = false;
        private animationFrame: number | null = null;
        private previousFrameTime = 0;

        constructor() {
          super();
          const shadow = this.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = styles;

          this.cursor = document.createElement("div");
          this.cursor.className = "cursor";
          this.cursor.innerHTML = selectToolIcon;

          this.label = document.createElement("span");
          this.label.className = "label";

          this.companion = document.createElement("vektor-cosmetic");
          this.companion.className = "companion";

          shadow.append(style, this.cursor, this.label, this.companion);
        }

        connectedCallback() {
          this.setAttribute("aria-hidden", "true");
          this.render();
          this.readTargetPosition();
        }

        disconnectedCallback() {
          if (this.animationFrame !== null) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
          }
        }

        attributeChangedCallback(name: string) {
          if (name === "x" || name === "y" || name === "class") {
            this.readTargetPosition();
            return;
          }
          this.render();
        }

        private render() {
          const name = this.getAttribute("name")?.trim() ?? "";
          this.cursor.hidden = this.hasAttribute("hide-pointer");
          this.label.hidden = this.hasAttribute("hide-label") || !name;
          this.label.textContent = name;

          const companionId = this.getAttribute("companion-id")?.trim();
          if (companionId) {
            this.companion.setAttribute("asset-id", companionId);
          } else {
            this.companion.removeAttribute("asset-id");
          }
        }

        private readTargetPosition() {
          const rawX = this.getAttribute("x");
          const rawY = this.getAttribute("y");
          if (rawX === null || rawY === null) return;
          const x = Number(rawX);
          const y = Number(rawY);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;

          this.targetX = x;
          this.targetY = y;

          if (!this.hasPosition || this.shouldSnap()) {
            this.hasPosition = true;
            this.cursorX = x;
            this.cursorY = y;
            this.companionX = x;
            this.companionY = y;
            this.companionVelocityX = 0;
            this.companionVelocityY = 0;
            this.applyPosition();
            return;
          }

          this.startAnimation();
        }

        private shouldSnap(): boolean {
          return (
            this.classList.contains("is-instant") ||
            (typeof window !== "undefined" &&
              window.matchMedia("(prefers-reduced-motion: reduce)").matches)
          );
        }

        private startAnimation() {
          if (this.animationFrame !== null) return;
          this.previousFrameTime = performance.now();
          this.animationFrame = requestAnimationFrame(this.stepFrame);
        }

        private stepFrame = (time: number) => {
          this.animationFrame = null;

          if (this.shouldSnap()) {
            this.cursorX = this.targetX;
            this.cursorY = this.targetY;
            this.companionX = this.targetX;
            this.companionY = this.targetY;
            this.companionVelocityX = 0;
            this.companionVelocityY = 0;
            this.applyPosition();
            return;
          }

          const elapsed = Math.min(Math.max(time - this.previousFrameTime, 0), 64);
          this.previousFrameTime = time;
          const cursorAmount = 1 - Math.exp(-elapsed / CURSOR_FOLLOW_MS);

          this.cursorX += (this.targetX - this.cursorX) * cursorAmount;
          this.cursorY += (this.targetY - this.cursorY) * cursorAmount;
          this.updateCompanionPosition(elapsed);
          this.applyPosition();

          const cursorDistance = Math.hypot(
            this.targetX - this.cursorX,
            this.targetY - this.cursorY,
          );
          const companionDistance = Math.hypot(
            this.targetX - this.companionX,
            this.targetY - this.companionY,
          );
          const companionSpeed = Math.hypot(
            this.companionVelocityX,
            this.companionVelocityY,
          );
          if (
            cursorDistance > POSITION_EPSILON ||
            companionDistance > POSITION_EPSILON ||
            companionSpeed > VELOCITY_EPSILON
          ) {
            this.animationFrame = requestAnimationFrame(this.stepFrame);
          } else {
            this.companionX = this.targetX;
            this.companionY = this.targetY;
            this.companionVelocityX = 0;
            this.companionVelocityY = 0;
            this.applyPosition();
          }
        };

        private updateCompanionPosition(elapsed: number) {
          const seconds = elapsed / 1000;
          const stiffness = COMPANION_SPRING_FREQUENCY ** 2;
          const damping = 2 * COMPANION_SPRING_DAMPING * COMPANION_SPRING_FREQUENCY;
          const accelerationX =
            (this.targetX - this.companionX) * stiffness -
            this.companionVelocityX * damping;
          const accelerationY =
            (this.targetY - this.companionY) * stiffness -
            this.companionVelocityY * damping;

          this.companionVelocityX += accelerationX * seconds;
          this.companionVelocityY += accelerationY * seconds;
          const speed = Math.hypot(this.companionVelocityX, this.companionVelocityY);
          if (speed > MAX_COMPANION_SPEED_PX_PER_SECOND) {
            const scale = MAX_COMPANION_SPEED_PX_PER_SECOND / speed;
            this.companionVelocityX *= scale;
            this.companionVelocityY *= scale;
          }
          this.companionX += this.companionVelocityX * seconds;
          this.companionY += this.companionVelocityY * seconds;
        }

        private applyPosition() {
          this.style.transform = `translate(${this.cursorX}px, ${this.cursorY}px)`;
          this.companion.style.transform = `translate(${this.companionX - this.cursorX}px, ${this.companionY - this.cursorY}px)`;
          this.companion.classList.toggle(
            "is-colliding",
            this.isCompanionCollidingWithCursor(),
          );
        }

        private isCompanionCollidingWithCursor(): boolean {
          const cursorLeft = this.cursorX + CURSOR_BOUNDS.left;
          const cursorTop = this.cursorY + CURSOR_BOUNDS.top;
          const cursorRight = this.cursorX + CURSOR_BOUNDS.right;
          const cursorBottom = this.cursorY + CURSOR_BOUNDS.bottom;
          const companionLeft = this.companionX + COMPANION_BOUNDS.left;
          const companionTop = this.companionY + COMPANION_BOUNDS.top;
          const companionRight = this.companionX + COMPANION_BOUNDS.right;
          const companionBottom = this.companionY + COMPANION_BOUNDS.bottom;

          return (
            cursorLeft < companionRight &&
            cursorRight > companionLeft &&
            cursorTop < companionBottom &&
            cursorBottom > companionTop
          );
        }
      };

if (
  typeof customElements !== "undefined" &&
  CanvasPresenceCursorElement &&
  !customElements.get(canvasPresenceCursorTag)
) {
  customElements.define(canvasPresenceCursorTag, CanvasPresenceCursorElement);
}
