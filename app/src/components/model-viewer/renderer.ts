// A tiny WebGPU renderer: one lit, indexed triangle mesh drawn with a fixed
// three-point-ish lighting rig. No materials, no textures, no post-processing —
// just enough to read the shape of a model. Everything lives behind
// `createRenderer` so the custom element never touches raw WebGPU objects.

import type { Mesh } from "./mesh.ts";

const SHADER = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
};

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>) -> VSOut {
  var out: VSOut;
  out.clip = u.mvp * vec4<f32>(position, 1.0);
  out.normal = (u.model * vec4<f32>(normal, 0.0)).xyz;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let key = normalize(vec3<f32>(0.4, 0.9, 0.5));
  let fill = normalize(vec3<f32>(-0.6, 0.1, -0.3));
  let diffuse = max(dot(n, key), 0.0) * 0.85 + max(dot(n, fill), 0.0) * 0.25;
  let ambient = 0.28;
  let base = vec3<f32>(0.60, 0.65, 0.72);
  let lit = base * (ambient + diffuse);
  return vec4<f32>(pow(lit, vec3<f32>(1.0 / 2.2)), 1.0);
}
`;

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus";

export type Renderer = {
  setMesh(mesh: Mesh): void;
  resize(width: number, height: number): void;
  render(mvp: Float32Array, model: Float32Array): void;
  destroy(): void;
};

export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No suitable GPU adapter found");
  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Failed to acquire a WebGPU canvas context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const module = device.createShaderModule({ code: SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
        },
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
        },
      ],
    },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
  });

  const uniformBuffer = device.createBuffer({
    size: 128, // two mat4x4<f32>
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  const uniformData = new Float32Array(32);

  let positionBuffer: GPUBuffer | null = null;
  let normalBuffer: GPUBuffer | null = null;
  let indexBuffer: GPUBuffer | null = null;
  let indexCount = 0;
  let depthTexture: GPUTexture | null = null;
  let destroyed = false;

  const uploadVertexBuffer = (data: Float32Array): GPUBuffer => {
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };

  return {
    setMesh(mesh: Mesh) {
      positionBuffer?.destroy();
      normalBuffer?.destroy();
      indexBuffer?.destroy();
      positionBuffer = uploadVertexBuffer(mesh.positions);
      normalBuffer = uploadVertexBuffer(mesh.normals);
      const index = device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(index, 0, mesh.indices);
      indexBuffer = index;
      indexCount = mesh.indices.length;
    },

    resize(width: number, height: number) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      canvas.width = w;
      canvas.height = h;
      depthTexture?.destroy();
      depthTexture = device.createTexture({
        size: [w, h],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    },

    render(mvp: Float32Array, model: Float32Array) {
      if (destroyed || !positionBuffer || !normalBuffer || !indexBuffer || !depthTexture)
        return;
      uniformData.set(mvp, 0);
      uniformData.set(model, 16);
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, positionBuffer);
      pass.setVertexBuffer(1, normalBuffer);
      pass.setIndexBuffer(indexBuffer, "uint32");
      pass.drawIndexed(indexCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },

    destroy() {
      destroyed = true;
      positionBuffer?.destroy();
      normalBuffer?.destroy();
      indexBuffer?.destroy();
      depthTexture?.destroy();
      uniformBuffer.destroy();
      device.destroy();
    },
  };
}
