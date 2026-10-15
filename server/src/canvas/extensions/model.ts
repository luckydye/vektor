import { drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import {
  type CanvasGpu,
  parseColor,
  useProgram,
  withScissor,
} from "#canvas/render/webgl.ts";
import { pointInRotatedShape } from "#canvas/runtime/geometry.ts";
import type {
  CanvasPaintHelpers,
  CanvasPointerGestureHandlers,
  CanvasPoint,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { loadMesh } from "#components/model-viewer/load.ts";
import {
  lookAt,
  multiply,
  perspective,
  rotationX,
  rotationY,
  transformPoint,
  translation,
  type Vec3,
} from "#components/model-viewer/math.ts";
import type { Material, Mesh } from "#components/model-viewer/mesh.ts";

// A 3D model on the canvas: a resizable shape whose textured mesh is lit with the
// canvas's own WebGL context, framed like <model-viewer-3d>. It stays still until
// it is grabbed: a ray from the pointer must hit the mesh itself (not just its
// box) for a drag to rotate it instead of moving the shape.

const FOV_Y = (45 * Math.PI) / 180;
const INITIAL_PITCH = 0.35;
const RADIANS_PER_PIXEL = 0.01;
const MAX_PITCH = Math.PI / 2 - 0.01;

const meshes = new Map<string, Mesh | "loading" | "error">();

// Per-viewer view state, kept out of the shared document on purpose.
type ModelView = { yaw: number; pitch: number };
const views = new Map<string, ModelView>();

function viewFor(shapeId: string): ModelView {
  let view = views.get(shapeId);
  if (!view) {
    view = { yaw: 0, pitch: INITIAL_PITCH };
    views.set(shapeId, view);
  }
  return view;
}

// Three-point lighting, fixed relative to the camera so the model turns through it.
// Only the key light casts (self-)shadows, from a depth map rendered each frame.
const KEY_DIRECTION: Vec3 = [0.5, 0.8, 0.6]; // towards the light, normalised in the shader
const SHADOW_SIZE = 1024;

const MODEL_VERTEX = `
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
uniform mat4 u_mvp;
uniform mat4 u_model;
uniform mat4 u_lightMvp;
out vec3 v_normal;
out vec2 v_uv;
out vec3 v_shadow;
void main() {
  gl_Position = u_mvp * vec4(a_position, 1.0);
  v_normal = (u_model * vec4(a_normal, 0.0)).xyz;
  v_uv = a_uv;
  v_shadow = (u_lightMvp * vec4(a_position, 1.0)).xyz * 0.5 + 0.5;
}
`;

const MODEL_FRAGMENT = `
in vec3 v_normal;
in vec2 v_uv;
in vec3 v_shadow;
uniform vec4 u_color;
uniform sampler2D u_texture;
uniform highp sampler2DShadow u_shadowMap;
uniform float u_textured;
out vec4 outColor;

float shadowFactor(float nDotL) {
  float bias = max(0.0015, 0.006 * (1.0 - nDotL));
  float lit = 0.0;
  float texel = 1.0 / ${SHADOW_SIZE}.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 offset = vec2(float(x), float(y)) * texel;
      lit += texture(u_shadowMap, vec3(v_shadow.xy + offset, v_shadow.z - bias));
    }
  }
  return lit / 9.0;
}

void main() {
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  vec3 key = normalize(vec3(${KEY_DIRECTION.join(", ")}));
  vec3 fill = normalize(vec3(-0.8, 0.1, 0.5));
  vec3 rim = normalize(vec3(0.0, 0.5, -1.0));
  float keyDiffuse = max(dot(n, key), 0.0);
  vec3 light = vec3(1.0, 0.96, 0.9) * 0.95 * keyDiffuse * shadowFactor(keyDiffuse)
    + vec3(0.75, 0.85, 1.0) * 0.35 * max(dot(n, fill), 0.0)
    + vec3(1.0) * 0.45 * pow(1.0 - max(n.z, 0.0), 2.0) * max(dot(n, rim) + 0.4, 0.0);
  // Sky/ground ambient so the shadowed side never goes flat black.
  light += mix(vec3(0.16, 0.15, 0.15), vec3(0.28, 0.30, 0.34), n.y * 0.5 + 0.5);
  vec3 base = u_color.rgb;
  if (u_textured > 0.5) base *= pow(texture(u_texture, v_uv).rgb, vec3(2.2));
  outColor = vec4(pow(base * light, vec3(1.0 / 2.2)), 1.0);
}
`;

const SHADOW_VERTEX = `
layout(location = 0) in vec3 a_position;
uniform mat4 u_lightMvp;
void main() {
  gl_Position = u_lightMvp * vec4(a_position, 1.0);
}
`;

const SHADOW_FRAGMENT = `
out vec4 outColor;
void main() {
  outColor = vec4(1.0);
}
`;

interface MeshBuffers {
  vao: WebGLVertexArrayObject;
  count: number;
}

function modelSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : "";
}

function meshFor(src: string, helpers: CanvasPaintHelpers) {
  const cached = meshes.get(src);
  if (cached) return cached;
  meshes.set(src, "loading");
  loadMesh(src).then(
    (mesh) => {
      meshes.set(src, mesh);
      helpers.invalidate();
    },
    () => meshes.set(src, "error"),
  );
  return "loading";
}

function vertexBuffer(
  gl: WebGL2RenderingContext,
  location: number,
  data: Float32Array,
  size = 3,
) {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("createBuffer failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function meshBuffers(gpu: CanvasGpu, mesh: Mesh): MeshBuffers {
  const cached = gpu.resources.objects.get(mesh);
  if (cached) return cached as MeshBuffers;
  const { gl } = gpu;
  const vao = gl.createVertexArray();
  const indices = gl.createBuffer();
  if (!vao || !indices) throw new Error("Mesh buffer allocation failed");
  gl.bindVertexArray(vao);
  vertexBuffer(gl, 0, mesh.positions);
  vertexBuffer(gl, 1, mesh.normals);
  vertexBuffer(gl, 2, mesh.uvs, 2);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const buffers = { vao, count: mesh.indices.length };
  gpu.resources.objects.set(mesh, buffers);
  return buffers;
}

type ShadowTarget = { framebuffer: WebGLFramebuffer; depth: WebGLTexture };

function shadowTarget(gpu: CanvasGpu): ShadowTarget {
  const cached = gpu.resources.named.get("model-shadow");
  if (cached) return cached as ShadowTarget;
  const { gl } = gpu;
  const framebuffer = gl.createFramebuffer();
  const depth = gl.createTexture();
  if (!framebuffer || !depth) throw new Error("Shadow target allocation failed");
  gl.bindTexture(gl.TEXTURE_2D, depth);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.DEPTH_COMPONENT24,
    SHADOW_SIZE,
    SHADOW_SIZE,
    0,
    gl.DEPTH_COMPONENT,
    gl.UNSIGNED_INT,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  const target = { framebuffer, depth };
  gpu.resources.named.set("model-shadow", target);
  return target;
}

// Orthographic view from the key light that just contains the model's bounding sphere.
function lightMatrix(mesh: Mesh) {
  const { radius } = framing(mesh);
  const length = Math.hypot(...KEY_DIRECTION);
  const eye: Vec3 = KEY_DIRECTION.map((v) => (v / length) * radius * 2) as Vec3;
  const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
  const near = radius * 0.5;
  const far = radius * 3.5;
  const proj = new Float32Array(16);
  proj[0] = 1 / radius;
  proj[5] = 1 / radius;
  proj[10] = -2 / (far - near);
  proj[14] = -(far + near) / (far - near);
  proj[15] = 1;
  return multiply(proj, view);
}

// Renders the model's depth from the key light, then puts the previous target back.
function renderShadowMap(
  gpu: CanvasGpu,
  mesh: Mesh,
  buffers: MeshBuffers,
  lightMvp: Float32Array,
) {
  const { gl } = gpu;
  const target = shadowTarget(gpu);
  const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const program = useProgram(gpu, "model-shadow", SHADOW_VERTEX, SHADOW_FRAGMENT);
  gl.uniformMatrix4fv(program.uniform("u_lightMvp"), false, lightMvp);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
  gl.disable(gl.SCISSOR_TEST);
  gl.depthMask(true);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.bindVertexArray(buffers.vao);
  gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);
  gl.disable(gl.DEPTH_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
  gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);
  return target;
}

function materialTexture(gpu: CanvasGpu, image: ImageBitmap): WebGLTexture {
  const cached = gpu.resources.objects.get(image);
  if (cached) return cached as WebGLTexture;
  const { gl } = gpu;
  const texture = gl.createTexture();
  if (!texture) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gpu.resources.objects.set(image, texture);
  return texture;
}

// The mesh's centre, and a camera distance at which its bounding sphere fits the field of view.
function framing(mesh: Mesh) {
  const radius =
    0.5 *
      Math.hypot(
        mesh.max[0] - mesh.min[0],
        mesh.max[1] - mesh.min[1],
        mesh.max[2] - mesh.min[2],
      ) || 1;
  const center: Vec3 = [
    (mesh.min[0] + mesh.max[0]) / 2,
    (mesh.min[1] + mesh.max[1]) / 2,
    (mesh.min[2] + mesh.max[2]) / 2,
  ];
  return { center, radius, distance: (radius / Math.sin(FOV_Y / 2)) * 1.25 };
}

// Recentres the model and backs the camera off until its bounding sphere fits the field of view.
function modelMatrices(mesh: Mesh, aspect: number, view3d: ModelView) {
  const { center, distance } = framing(mesh);
  const recenter = translation(-center[0], -center[1], -center[2]);
  const model = multiply(
    rotationX(view3d.pitch),
    multiply(rotationY(view3d.yaw), recenter),
  );
  const proj = perspective(FOV_Y, aspect, 0.01, distance * 100);
  const view = lookAt([0, 0, distance], [0, 0, 0], [0, 1, 0]);
  return { model, mvp: multiply(proj, multiply(view, model)) };
}

function paintModel(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const { gl } = gpu;
  const { screen } = gpu.view;
  const x = shape.frame.x * helpers.scale + helpers.dx;
  const y = shape.frame.y * helpers.scale + helpers.dy;
  const width = shape.frame.width * helpers.scale;
  const height = shape.frame.height * helpers.scale;
  if (width <= 0 || height <= 0) return;

  const mesh = meshFor(modelSource(shape), helpers);
  if (typeof mesh === "string") {
    drawRoundedRect(gpu, rectQuad(x, y, width, height), {
      fill: parseColor(helpers.color("--canvas-handle-bg")),
      radius: 8 * helpers.scale,
    });
    return;
  }

  const { model, mvp } = modelMatrices(mesh, width / height, viewFor(shape.id));
  // Places the [-1,1] clip square onto the rect, so gl.viewport stays the full canvas.
  const place = new Float32Array(16);
  place[0] = width / screen.width;
  place[5] = height / screen.height;
  place[10] = 1;
  place[12] = ((x + width / 2) / screen.width) * 2 - 1;
  place[13] = 1 - ((y + height / 2) / screen.height) * 2;
  place[15] = 1;

  const buffers = meshBuffers(gpu, mesh);
  const lightMvp = multiply(lightMatrix(mesh), model);
  const shadow = renderShadowMap(gpu, mesh, buffers, lightMvp);

  const program = useProgram(gpu, "model", MODEL_VERTEX, MODEL_FRAGMENT);
  gl.uniformMatrix4fv(program.uniform("u_mvp"), false, multiply(place, mvp));
  gl.uniformMatrix4fv(program.uniform("u_model"), false, model);
  gl.uniformMatrix4fv(program.uniform("u_lightMvp"), false, lightMvp);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, shadow.depth);
  gl.uniform1i(program.uniform("u_shadowMap"), 1);
  withScissor(gpu, { x, y, width, height }, () => {
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.bindVertexArray(buffers.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(program.uniform("u_texture"), 0);
    for (const group of mesh.groups) {
      const { color, image } = group.material;
      gl.uniform4fv(program.uniform("u_color"), color);
      gl.uniform1f(program.uniform("u_textured"), image ? 1 : 0);
      if (image) gl.bindTexture(gl.TEXTURE_2D, materialTexture(gpu, image));
      gl.drawElements(gl.TRIANGLES, group.count, gl.UNSIGNED_INT, group.start * 4);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  });
}

// Whether the ray through `point` (world units) strikes the mesh itself, rather than
// only the shape's box. The ray is moved into model space so the triangles are used as loaded.
function rayHitsMesh(shape: CanvasShape, mesh: Mesh, point: CanvasPoint) {
  const { frame } = shape;
  const aspect = frame.width / frame.height;
  const ndcX = ((point.x - frame.x) / frame.width) * 2 - 1;
  const ndcY = 1 - ((point.y - frame.y) / frame.height) * 2;
  const tan = Math.tan(FOV_Y / 2);
  const { center, distance } = framing(mesh);
  const view = viewFor(shape.id);
  const inverse = multiply(rotationY(-view.yaw), rotationX(-view.pitch));

  const o: Vec3 = [0, 0, 0];
  const d: Vec3 = [0, 0, 0];
  transformPoint(inverse, 0, 0, distance, o);
  transformPoint(inverse, ndcX * tan * aspect, ndcY * tan, -1, d);
  for (let axis = 0; axis < 3; axis++) o[axis] += center[axis];

  // Cheap reject against the bounding box (slab test) before any triangle.
  let near = -Infinity;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const inv = 1 / d[axis];
    const a = (mesh.min[axis] - o[axis]) * inv;
    const b = (mesh.max[axis] - o[axis]) * inv;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (far < Math.max(near, 0)) return false;

  // Möller–Trumbore against every triangle; any hit in front of the camera counts.
  const { positions, indices } = mesh;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    const px = d[1] * e2z - d[2] * e2y;
    const py = d[2] * e2x - d[0] * e2z;
    const pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const tx = o[0] - positions[a];
    const ty = o[1] - positions[a + 1];
    const tz = o[2] - positions[a + 2];
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2x * qx + e2y * qy + e2z * qz) / det > 0) return true;
  }
  return false;
}

// "model" when the ray strikes the mesh, "body" for the rest of the box (which moves the shape).
function hitTestModel(shape: CanvasShape, point: CanvasPoint) {
  if (!pointInRotatedShape(point, shape.frame)) return null;
  const mesh = meshes.get(modelSource(shape));
  return typeof mesh === "object" && rayHitsMesh(shape, mesh, point) ? "model" : "body";
}

// Dragging a grabbed model turns it; the controller repaints after each move.
function grabModel(shape: CanvasShape): CanvasPointerGestureHandlers {
  const view = viewFor(shape.id);
  let last: CanvasPoint | null = null;
  return {
    onMove: ({ screen }) => {
      if (last) {
        view.yaw += (screen.x - last.x) * RADIANS_PER_PIXEL;
        view.pitch = Math.max(
          -MAX_PITCH,
          Math.min(MAX_PITCH, view.pitch + (screen.y - last.y) * RADIANS_PER_PIXEL),
        );
      }
      last = screen;
    },
  };
}

export const CanvasModel = CanvasElement.create({
  name: "model",

  addOptions() {
    return {
      size: { width: 260, height: 220 },
      minSize: { width: 120, height: 100 },
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: "transparent" },
      data: { text: "" },
    };
  },

  isValid: (shape) => Boolean(modelSource(shape)),

  addRender() {
    return {
      paint: paintModel,
      hitTest: hitTestModel,
      cursor: (_shape, region) => (region === "model" ? "grab" : null),
    };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: false },
      press: (_shape, region) => (region === "model" ? "grab" : "drag"),
    };
  },

  addEvents() {
    return { grab: grabModel };
  },

  parseData(data, context) {
    const src = data.src;
    return {
      ...data,
      src:
        typeof src === "string" && src.startsWith("/")
          ? `${context.currentOrigin}${src}`
          : src,
    };
  },
});

export function createModelShape(params: {
  at: { x: number; y: number };
  src: string;
  filename: string;
  origin?: "center" | "top-left";
}): CanvasShape {
  const origin = params.origin ?? "center";
  const size = CanvasModel.defaults.size;
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "model",
    frame: {
      x: Math.round(origin === "center" ? params.at.x - size.width / 2 : params.at.x),
      y: Math.round(origin === "center" ? params.at.y - size.height / 2 : params.at.y),
      width: size.width,
      height: size.height,
      rotation: 0,
    },
    style: { ...CanvasModel.defaults.style },
    data: { ...CanvasModel.defaults.data, src: params.src, alt: params.filename },
    updatedAt: Date.now(),
  };
}
