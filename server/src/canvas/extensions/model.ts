import { drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import {
  type CanvasGpu,
  parseColor,
  useProgram,
  withScissor,
} from "#canvas/render/webgl.ts";
import type { CanvasPaintHelpers, CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { loadMesh } from "#components/model-viewer/load.ts";
import {
  lookAt,
  multiply,
  perspective,
  rotationX,
  rotationY,
  translation,
} from "#components/model-viewer/math.ts";
import type { Mesh } from "#components/model-viewer/mesh.ts";

// A 3D model on the canvas: a resizable shape whose mesh is lit and auto-spun
// with the canvas's own WebGL context, framed like <model-viewer-3d>.

const FOV_Y = (45 * Math.PI) / 180;
const AUTO_SPIN_PER_SECOND = 0.5;
const PITCH = 0.35;

const meshes = new Map<string, Mesh | "loading" | "error">();

const MODEL_VERTEX = `
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_normal;
void main() {
  gl_Position = u_mvp * vec4(a_position, 1.0);
  v_normal = (u_model * vec4(a_normal, 0.0)).xyz;
}
`;

const MODEL_FRAGMENT = `
in vec3 v_normal;
out vec4 outColor;
void main() {
  vec3 n = normalize(v_normal);
  vec3 key = normalize(vec3(0.4, 0.9, 0.5));
  vec3 fill = normalize(vec3(-0.6, 0.1, -0.3));
  float diffuse = max(dot(n, key), 0.0) * 0.85 + max(dot(n, fill), 0.0) * 0.25;
  float ambient = 0.28;
  vec3 base = vec3(0.60, 0.65, 0.72);
  vec3 lit = base * (ambient + diffuse);
  outColor = vec4(pow(lit, vec3(1.0 / 2.2)), 1.0);
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

function vertexBuffer(gl: WebGL2RenderingContext, location: number, data: Float32Array) {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("createBuffer failed");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
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
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const buffers = { vao, count: mesh.indices.length };
  gpu.resources.objects.set(mesh, buffers);
  return buffers;
}

// Recentres the model and backs the camera off until its bounding sphere fits the field of view.
function modelMatrices(mesh: Mesh, aspect: number) {
  const radius =
    0.5 *
      Math.hypot(
        mesh.max[0] - mesh.min[0],
        mesh.max[1] - mesh.min[1],
        mesh.max[2] - mesh.min[2],
      ) || 1;
  const distance = (radius / Math.sin(FOV_Y / 2)) * 1.25;
  const recenter = translation(
    -(mesh.min[0] + mesh.max[0]) / 2,
    -(mesh.min[1] + mesh.max[1]) / 2,
    -(mesh.min[2] + mesh.max[2]) / 2,
  );
  const yaw = (performance.now() / 1000) * AUTO_SPIN_PER_SECOND;
  const model = multiply(rotationX(PITCH), multiply(rotationY(yaw), recenter));
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

  const { model, mvp } = modelMatrices(mesh, width / height);
  // Places the [-1,1] clip square onto the rect, so gl.viewport stays the full canvas.
  const place = new Float32Array(16);
  place[0] = width / screen.width;
  place[5] = height / screen.height;
  place[10] = 1;
  place[12] = ((x + width / 2) / screen.width) * 2 - 1;
  place[13] = 1 - ((y + height / 2) / screen.height) * 2;
  place[15] = 1;

  const program = useProgram(gpu, "model", MODEL_VERTEX, MODEL_FRAGMENT);
  gl.uniformMatrix4fv(program.uniform("u_mvp"), false, multiply(place, mvp));
  gl.uniformMatrix4fv(program.uniform("u_model"), false, model);
  const buffers = meshBuffers(gpu, mesh);
  withScissor(gpu, { x, y, width, height }, () => {
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.bindVertexArray(buffers.vao);
    gl.drawElements(gl.TRIANGLES, buffers.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  });
  helpers.requestFrame();
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
    return { paint: paintModel };
  },

  addBehavior() {
    return { transform: { move: true, resize: "box" as const, rotate: false } };
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
