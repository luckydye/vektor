/**
 * Filled vector paths in world space, drawn stencil-then-cover: the rings write
 * winding counts into the stencil buffer, then one quad over their bounds paints
 * where it is set and clears it again. Edges are smoothed by the pass's MSAA.
 */

import { type FillPath, polygonBounds } from "#canvas/render/vector.ts";
import {
  type CanvasGpu,
  flushPending,
  type Rgba,
  setColor,
  useProgram,
} from "#canvas/render/webgl.ts";

const PATH_VERTEX = `
layout(location = 0) in vec2 a_world;
void main() {
  gl_Position = screenToClip(worldToScreen(a_world));
}
`;

const PATH_FRAGMENT = `
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}
`;

interface PathBuffer {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  data: Float32Array;
}

function pathBuffer(gpu: CanvasGpu): PathBuffer {
  const cached = gpu.resources.named.get("pathBuffer") as PathBuffer | undefined;
  if (cached) return cached;
  const { gl } = gpu;
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) throw new Error("Path buffer allocation failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  gl.bindVertexArray(null);
  const created = { vao, buffer, data: new Float32Array(4096) };
  gpu.resources.named.set("pathBuffer", created);
  return created;
}

/** Fills `path` (world units) with a straight-alpha colour. */
export function fillPath(gpu: CanvasGpu, path: FillPath, color: Rgba, alpha = 1) {
  const rings = path.rings.filter((ring) => ring.length >= 3);
  if (rings.length === 0 || color[3] * alpha <= 0) return;
  const { gl } = gpu;
  flushPending(gpu);
  const program = useProgram(gpu, "vectorPath", PATH_VERTEX, PATH_FRAGMENT);
  const target = pathBuffer(gpu);

  // Each ring as a fan from its first point; the stencil sorts out the winding.
  let floats = 0;
  for (const ring of rings) floats += (ring.length - 2) * 6;
  floats += 12;
  if (target.data.length < floats) {
    target.data = new Float32Array(2 ** Math.ceil(Math.log2(floats)));
  }
  const data = target.data;
  let offset = 0;
  for (const ring of rings) {
    const origin = ring[0];
    for (let i = 1; i < ring.length - 1; i++) {
      data[offset++] = origin.x;
      data[offset++] = origin.y;
      data[offset++] = ring[i].x;
      data[offset++] = ring[i].y;
      data[offset++] = ring[i + 1].x;
      data[offset++] = ring[i + 1].y;
    }
  }
  const fanVertices = offset / 2;
  const bounds = polygonBounds(rings);
  const x0 = bounds.x;
  const y0 = bounds.y;
  const x1 = bounds.x + bounds.width;
  const y1 = bounds.y + bounds.height;
  for (const value of [x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]) {
    data[offset++] = value;
  }

  gl.bindVertexArray(target.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, target.buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, offset), gl.STREAM_DRAW);

  gl.enable(gl.STENCIL_TEST);
  gl.colorMask(false, false, false, false);
  gl.stencilFunc(gl.ALWAYS, 1, 0xff);
  if (path.rule === "union") {
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  } else {
    gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
    gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
  }
  gl.drawArrays(gl.TRIANGLES, 0, fanVertices);

  gl.colorMask(true, true, true, true);
  gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
  gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
  setColor(gpu, program.uniform("u_color"), color, alpha);
  gl.drawArrays(gl.TRIANGLES, fanVertices, 6);

  gl.disable(gl.STENCIL_TEST);
  gl.bindVertexArray(null);
}
