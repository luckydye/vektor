/**
 * The canvas's one WebGL2 context. It renders offscreen and hands each finished
 * pass to an on-page `<canvas>` as a bitmap, so the scene below the DOM world and
 * the overlay above it share every buffer, texture and program.
 */

import type { ScreenSize, WorldTransform } from "#canvas/runtime/geometry.ts";

/** Straight (not premultiplied) RGBA in 0..1. */
export type Rgba = readonly [number, number, number, number];

export interface CanvasView {
  transform: WorldTransform;
  screen: ScreenSize;
  dpr: number;
}

/** GPU objects. Replaced wholesale when the context is restored after a loss. */
export interface CanvasGpuResources {
  programs: Map<string, CanvasProgram>;
  /** Keyed by the object the GPU data was built from: a path, an image, a tile. */
  objects: WeakMap<object, unknown>;
  named: Map<string, unknown>;
}

export interface CanvasGpu {
  gl: WebGL2RenderingContext;
  canvas: OffscreenCanvas;
  resources: CanvasGpuResources;
  view: CanvasView;
  lost: boolean;
  /** Backing stores grow in `backingSize` steps instead of matching every resize. */
  bucketed: boolean;
  /** Device-pixel row the pass's viewport starts at: its content sits at the top. */
  originY: number;
  /** The active `withScissor` rect in screen CSS px, or null when unclipped. */
  scissor: ScreenRect | null;
}

type ScreenRect = { x: number; y: number; width: number; height: number };

export interface CanvasProgram {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

const liveGpus = new Set<CanvasGpu>();

/** Every context currently mounted, for releasing a texture from all of them. */
export function canvasGpus(): ReadonlySet<CanvasGpu> {
  return liveGpus;
}

function createResources(): CanvasGpuResources {
  return { programs: new Map(), objects: new WeakMap(), named: new Map() };
}

/**
 * Device-pixel size of the canvases behind a screen, in 256px steps, so a
 * viewport animating its size reallocates only every 256px. Passes draw the
 * exact screen into its top-left; the viewport element clips the rest.
 */
export function backingSize(screen: { width: number; height: number }, dpr: number) {
  return {
    width: Math.ceil((screen.width * dpr) / 256) * 256,
    height: Math.ceil((screen.height * dpr) / 256) * 256,
  };
}

export function createCanvasGpu(onRestored: () => void, bucketed = false): CanvasGpu {
  const canvas = new OffscreenCanvas(1, 1);
  // Anti-aliasing comes from our own multisampled framebuffer: some engines
  // ignore `antialias` on an OffscreenCanvas.
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: true,
    stencil: false,
  });
  if (!gl) throw new Error("The canvas needs WebGL2");

  const gpu: CanvasGpu = {
    gl,
    canvas,
    resources: createResources(),
    view: {
      transform: { scale: 1, dx: 0, dy: 0 },
      screen: { width: 1, height: 1 },
      dpr: 1,
    },
    lost: false,
    bucketed,
    originY: 0,
    scissor: null,
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    gpu.lost = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    gpu.lost = false;
    gpu.resources = createResources();
    onRestored();
  });
  liveGpus.add(gpu);
  return gpu;
}

export function destroyCanvasGpu(gpu: CanvasGpu) {
  liveGpus.delete(gpu);
  gpu.gl.getExtension("WEBGL_lose_context")?.loseContext();
}

interface MultisampleTarget {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  stencil: WebGLRenderbuffer;
  width: number;
  height: number;
}

// Every pass draws here and is resolved into the canvas on present.
function multisampleTarget(gpu: CanvasGpu, width: number, height: number) {
  const { gl } = gpu;
  let target = gpu.resources.named.get("multisample") as MultisampleTarget | undefined;
  if (!target) {
    const framebuffer = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const stencil = gl.createRenderbuffer();
    if (!framebuffer || !color || !stencil)
      throw new Error("Framebuffer allocation failed");
    target = { framebuffer, color, stencil, width: 0, height: 0 };
    gpu.resources.named.set("multisample", target);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  if (target.width !== width || target.height !== height) {
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    gl.bindRenderbuffer(gl.RENDERBUFFER, target.color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, target.stencil);
    gl.renderbufferStorageMultisample(
      gl.RENDERBUFFER,
      samples,
      gl.DEPTH24_STENCIL8,
      width,
      height,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.RENDERBUFFER,
      target.color,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      target.stencil,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new Error(`Multisample framebuffer incomplete: ${status}`);
    }
    target.width = width;
    target.height = height;
  }
  return target;
}

/** Clears the drawing buffer for a new pass at the given camera. */
export function beginPass(gpu: CanvasGpu, view: CanvasView) {
  const { gl, canvas } = gpu;
  gpu.view = view;
  const width = Math.max(1, Math.round(view.screen.width * view.dpr));
  const height = Math.max(1, Math.round(view.screen.height * view.dpr));
  const backing = gpu.bucketed ? backingSize(view.screen, view.dpr) : { width, height };
  if (canvas.width !== backing.width || canvas.height !== backing.height) {
    canvas.width = backing.width;
    canvas.height = backing.height;
  }
  multisampleTarget(gpu, backing.width, backing.height);
  gpu.originY = backing.height - height;
  gl.viewport(0, gpu.originY, width, height);
  gpu.scissor = null;
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.colorMask(true, true, true, true);
  gl.clearColor(0, 0, 0, 0);
  gl.clearStencil(0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

/**
 * Paints with drawing limited to `rect` (screen CSS px), intersected with any
 * clip already active, and restores that clip afterwards.
 */
export function withScissor(gpu: CanvasGpu, rect: ScreenRect, paint: () => void) {
  const { gl } = gpu;
  const outer = gpu.scissor;
  const x = Math.max(rect.x, outer?.x ?? -Infinity);
  const y = Math.max(rect.y, outer?.y ?? -Infinity);
  const right = Math.min(rect.x + rect.width, outer ? outer.x + outer.width : Infinity);
  const bottom = Math.min(
    rect.y + rect.height,
    outer ? outer.y + outer.height : Infinity,
  );
  if (right <= x || bottom <= y) return;
  const apply = (clip: ScreenRect) => {
    const { dpr, screen } = gpu.view;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.floor(clip.x * dpr),
      gpu.originY + Math.floor((screen.height - clip.y - clip.height) * dpr),
      Math.ceil(clip.width * dpr),
      Math.ceil(clip.height * dpr),
    );
  };
  gpu.scissor = { x, y, width: right - x, height: bottom - y };
  apply(gpu.scissor);
  try {
    paint();
  } finally {
    gpu.scissor = outer;
    if (outer) apply(outer);
    else gl.disable(gl.SCISSOR_TEST);
  }
}

/** Resolves the samples and hands the finished pass to an on-page canvas. */
export function presentPass(gpu: CanvasGpu, target: HTMLCanvasElement) {
  const context = target.getContext("bitmaprenderer");
  if (!context) throw new Error("bitmaprenderer context unavailable");
  resolvePass(gpu);
  context.transferFromImageBitmap(gpu.canvas.transferToImageBitmap());
}

/** Resolves the samples into `gpu.canvas`, where they can be read or encoded. */
export function resolvePass(gpu: CanvasGpu) {
  const { gl, canvas } = gpu;
  const multisample = gpu.resources.named.get("multisample") as MultisampleTarget;
  gl.disable(gl.SCISSOR_TEST);
  const { screen, dpr } = gpu.view;
  const width = Math.max(1, Math.round(screen.width * dpr));
  const height = Math.max(1, Math.round(screen.height * dpr));
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, multisample.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  // A multisample resolve needs matching rects; the pass drew at the top.
  gl.blitFramebuffer(
    0,
    gpu.originY,
    width,
    gpu.originY + height,
    0,
    gpu.originY,
    width,
    gpu.originY + height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Shared by every program: `u_view` is the world→screen transform (scale, dx,
 * dy) and positions leave the vertex shader in CSS pixels via `screenToClip`.
 */
export const GLSL_PRELUDE = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 u_view;
uniform vec2 u_screen;
uniform float u_dpr;
vec2 worldToScreen(vec2 p) { return p * u_view.x + u_view.yz; }
vec4 screenToClip(vec2 p) {
  return vec4(p.x / u_screen.x * 2.0 - 1.0, 1.0 - p.y / u_screen.y * 2.0, 0.0, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/** A linked program, cached per context, with the shared view uniforms set. */
export function useProgram(
  gpu: CanvasGpu,
  key: string,
  vertex: string,
  fragment: string,
): CanvasProgram {
  const { gl } = gpu;
  let cached = gpu.resources.programs.get(key);
  if (!cached) {
    const program = gl.createProgram();
    if (!program) throw new Error("createProgram failed");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, GLSL_PRELUDE + vertex));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, GLSL_PRELUDE + fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    const locations = new Map<string, WebGLUniformLocation | null>();
    cached = {
      program,
      uniform: (name) => {
        if (!locations.has(name))
          locations.set(name, gl.getUniformLocation(program, name));
        return locations.get(name) ?? null;
      },
    };
    gpu.resources.programs.set(key, cached);
  }
  gl.useProgram(cached.program);
  const { transform, screen, dpr } = gpu.view;
  gl.uniform3f(cached.uniform("u_view"), transform.scale, transform.dx, transform.dy);
  gl.uniform2f(cached.uniform("u_screen"), screen.width, screen.height);
  gl.uniform1f(cached.uniform("u_dpr"), dpr);
  return cached;
}

/** Sets a premultiplied colour uniform from a straight colour and extra alpha. */
export function setColor(
  gpu: CanvasGpu,
  location: WebGLUniformLocation | null,
  color: Rgba,
  alpha = 1,
) {
  const a = color[3] * alpha;
  gpu.gl.uniform4f(location, color[0] * a, color[1] * a, color[2] * a, a);
}

const parsedColors = new Map<string, Rgba>();

/** `#rgb[a]`, `#rrggbb[aa]`, `rgb()`/`rgba()` and `transparent` — what the canvas themes use. */
export function parseColor(color: string): Rgba {
  const cached = parsedColors.get(color);
  if (cached) return cached;
  const value = color.trim().toLowerCase();
  let rgba: Rgba;
  if (value === "transparent") {
    rgba = [0, 0, 0, 0];
  } else if (value.startsWith("#")) {
    const short = value.length === 4 || value.length === 5;
    const hex = short ? [...value.slice(1)].map((c) => c + c).join("") : value.slice(1);
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) throw new Error(`Bad colour ${color}`);
    const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    rgba = [channel(0), channel(2), channel(4), hex.length === 8 ? channel(6) : 1];
  } else {
    const match = /^rgba?\(([^)]*)\)$/.exec(value);
    if (!match) throw new Error(`Unsupported colour ${color}`);
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) throw new Error(`Bad colour ${color}`);
    const number = (part: string, max: number) =>
      part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part) / max;
    rgba = [
      number(parts[0], 255),
      number(parts[1], 255),
      number(parts[2], 255),
      parts[3] === undefined ? 1 : number(parts[3], 1),
    ];
  }
  parsedColors.set(color, rgba);
  return rgba;
}

/**
 * A mipmapped texture for an image or tile, uploaded once per context. Call
 * `releaseTexture` when the source is replaced, or it stays resident.
 */
export function textureFor(gpu: CanvasGpu, source: TexImageSource): WebGLTexture {
  const cached = gpu.resources.objects.get(source);
  if (cached) return cached as WebGLTexture;
  const { gl } = gpu;
  const texture = gl.createTexture();
  if (!texture) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gpu.resources.objects.set(source, texture);
  return texture;
}

export function releaseTexture(source: object) {
  for (const gpu of liveGpus) {
    const texture = gpu.resources.objects.get(source);
    if (!texture) continue;
    gpu.gl.deleteTexture(texture as WebGLTexture);
    gpu.resources.objects.delete(source);
  }
}
