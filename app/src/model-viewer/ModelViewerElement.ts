// <model-viewer-3d src="…"> — a self-contained, dependency-free WebGPU preview
// for glTF / GLB / OBJ models. Point it at a URL and it loads, frames, and
// slowly spins the geometry; drag to orbit. Everything (parsing, GPU setup,
// the render loop) is torn down on disconnect.
//
//   <model-viewer-3d src="/path/model.glb"></model-viewer-3d>
//
// It renders nothing but a status message when WebGPU is unavailable or the
// file cannot be parsed, so it degrades gracefully anywhere.

import { loadMesh } from "./load.ts";
import {
  lookAt,
  multiply,
  perspective,
  rotationX,
  rotationY,
  translation,
} from "./math.ts";
import type { Mesh } from "./mesh.ts";
import { createRenderer, type Renderer } from "./renderer.ts";

const FOV_Y = (45 * Math.PI) / 180;
const AUTO_SPIN_PER_SECOND = 0.5; // radians

export const MODEL_VIEWER_TAG = "model-viewer-3d";

// Guarded so the class body — which extends the DOM `HTMLElement` — is only
// evaluated in the browser. During Astro SSR `HTMLElement` is undefined and
// merely loading this module would otherwise throw.
if (typeof HTMLElement !== "undefined" && typeof customElements !== "undefined") {
  class ModelViewer3DElement extends HTMLElement {
    private shadow: ShadowRoot;
    private canvas: HTMLCanvasElement;
    private status: HTMLElement;
    private renderer: Renderer | null = null;
    private mesh: Mesh | null = null;
    private resizeObserver: ResizeObserver | null = null;

    private loadToken = 0;
    private frame: number | null = null;
    private lastTime = 0;
    private yaw = 0;
    private pitch = 0.35;
    private autoSpin = true;
    private dragging = false;
    private lastPointer = { x: 0, y: 0 };

    private center: [number, number, number] = [0, 0, 0];
    private cameraDistance = 3;

    static get observedAttributes() {
      return ["src"];
    }

    constructor() {
      super();
      this.shadow = this.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `
      <style>
        :host { display: block; position: relative; width: 100%; height: 100%; }
        canvas {
          display: block;
          width: 100%;
          height: 100%;
          touch-action: none;
          cursor: grab;
        }
        canvas.dragging { cursor: grabbing; }
        .status {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 8px;
          text-align: center;
          font: 11px/1.4 ui-sans-serif, system-ui, sans-serif;
          color: var(--color-neutral-500, #64748b);
          pointer-events: none;
        }
        .status[hidden] { display: none; }
      </style>
      <canvas></canvas>
      <div class="status">Loading 3D preview…</div>
    `;
      this.canvas = this.shadow.querySelector("canvas") as HTMLCanvasElement;
      this.status = this.shadow.querySelector(".status") as HTMLElement;
    }

    connectedCallback() {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this);
      this.canvas.addEventListener("pointerdown", this.onPointerDown);
      this.load();
    }

    disconnectedCallback() {
      this.teardown();
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    }

    attributeChangedCallback(
      name: string,
      oldValue: string | null,
      newValue: string | null,
    ) {
      if (name === "src" && oldValue !== newValue && this.isConnected) this.load();
    }

    get src(): string | null {
      return this.getAttribute("src");
    }
    set src(value: string | null) {
      if (value) this.setAttribute("src", value);
      else this.removeAttribute("src");
    }

    private setStatus(message: string | null) {
      if (message) {
        this.status.textContent = message;
        this.status.hidden = false;
      } else {
        this.status.hidden = true;
      }
    }

    private async load() {
      const src = this.getAttribute("src");
      const token = ++this.loadToken;
      this.stopLoop();
      if (!src) {
        this.setStatus("No model source");
        return;
      }
      if (!("gpu" in navigator)) {
        this.setStatus("WebGPU not supported");
        return;
      }
      this.setStatus("Loading 3D preview…");

      try {
        const [renderer, mesh] = await Promise.all([
          this.renderer ? Promise.resolve(this.renderer) : createRenderer(this.canvas),
          loadMesh(src),
        ]);
        if (token !== this.loadToken) {
          if (!this.renderer) renderer.destroy();
          return;
        }
        this.renderer = renderer;
        this.mesh = mesh;
        renderer.setMesh(mesh);
        this.frameCamera(mesh);
        this.handleResize();
        this.setStatus(null);
        this.startLoop();
      } catch (error) {
        if (token !== this.loadToken) return;
        this.setStatus(
          error instanceof Error ? error.message : "Unable to load 3D model",
        );
      }
    }

    // Centre the model at the origin and pull the camera back far enough that its
    // bounding sphere fits inside the vertical field of view.
    private frameCamera(mesh: Mesh) {
      this.center = [
        (mesh.min[0] + mesh.max[0]) / 2,
        (mesh.min[1] + mesh.max[1]) / 2,
        (mesh.min[2] + mesh.max[2]) / 2,
      ];
      const radius =
        0.5 *
          Math.hypot(
            mesh.max[0] - mesh.min[0],
            mesh.max[1] - mesh.min[1],
            mesh.max[2] - mesh.min[2],
          ) || 1;
      this.cameraDistance = (radius / Math.sin(FOV_Y / 2)) * 1.25;
    }

    private handleResize() {
      if (!this.renderer) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = this.clientWidth * dpr;
      const height = this.clientHeight * dpr;
      if (width <= 0 || height <= 0) return;
      this.renderer.resize(width, height);
      this.renderOnce();
    }

    private startLoop() {
      this.stopLoop();
      this.lastTime = 0;
      const tick = (time: number) => {
        const delta = this.lastTime ? (time - this.lastTime) / 1000 : 0;
        this.lastTime = time;
        if (this.autoSpin && !this.dragging) this.yaw += delta * AUTO_SPIN_PER_SECOND;
        this.renderOnce();
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }

    private stopLoop() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
    }

    private renderOnce() {
      if (!this.renderer || !this.mesh) return;
      const aspect = this.clientWidth / Math.max(1, this.clientHeight);
      const proj = perspective(FOV_Y, aspect || 1, 0.01, this.cameraDistance * 100);
      const view = lookAt([0, 0, this.cameraDistance], [0, 0, 0], [0, 1, 0]);
      // model = pitch * yaw * translate(-center): spin the recentred geometry.
      const recenter = translation(-this.center[0], -this.center[1], -this.center[2]);
      const model = multiply(
        rotationX(this.pitch),
        multiply(rotationY(this.yaw), recenter),
      );
      const mvp = multiply(proj, multiply(view, model));
      this.renderer.render(mvp, model);
    }

    private onPointerDown = (event: PointerEvent) => {
      this.dragging = true;
      this.autoSpin = false;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.canvas.classList.add("dragging");
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.addEventListener("pointermove", this.onPointerMove);
      this.canvas.addEventListener("pointerup", this.onPointerUp);
      this.canvas.addEventListener("pointercancel", this.onPointerUp);
    };

    private onPointerMove = (event: PointerEvent) => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.yaw += dx * 0.01;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.01));
      this.renderOnce();
    };

    private onPointerUp = (event: PointerEvent) => {
      this.dragging = false;
      this.canvas.classList.remove("dragging");
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be gone; ignore.
      }
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    };

    private teardown() {
      this.stopLoop();
      this.renderer?.destroy();
      this.renderer = null;
      this.mesh = null;
    }
  }

  if (!customElements.get(MODEL_VIEWER_TAG)) {
    customElements.define(MODEL_VIEWER_TAG, ModelViewer3DElement);
  }
}
