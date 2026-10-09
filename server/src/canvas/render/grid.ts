import {
  type CanvasGpu,
  parseColor,
  setColor,
  useProgram,
} from "#canvas/render/webgl.ts";

interface WorldGridLevel {
  // Distance between grid lines in world units.
  size: number;
  color: string;
  lineWidth: number;
  // Hide this level while its cell spacing is too dense on screen.
  minScreenSpacing: number;
}

// Opacity for a level from its on-screen cell spacing, fading over one threshold
// width as it approaches the cutoff instead of popping.
function levelFadeAlpha(screenSpacing: number, minScreenSpacing: number): number {
  if (screenSpacing <= minScreenSpacing) return 0;
  return Math.min(1, (screenSpacing - minScreenSpacing) / minScreenSpacing);
}

// One small quad per dot or line, so only the grid's own pixels are shaded
// rather than every pixel on screen. Instances count columns, then rows.
const GRID_VERTEX = `
uniform int u_dots;
uniform int u_columns;
uniform vec2 u_first;
uniform float u_spacing;
uniform float u_width;
out vec2 v_local;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0;
  float pad = 1.0 / u_dpr;
  if (u_dots == 1) {
    vec2 cell = vec2(gl_InstanceID % u_columns, gl_InstanceID / u_columns);
    vec2 center = u_first + cell * u_spacing;
    v_local = corner * (u_width + pad);
    gl_Position = screenToClip(center + v_local);
    return;
  }
  // Lines snap to CSS pixel centres, so a 1px line stays crisp at every dpr.
  bool vertical = gl_InstanceID < u_columns;
  float index = float(vertical ? gl_InstanceID : gl_InstanceID - u_columns);
  float at = floor((vertical ? u_first.x : u_first.y) + index * u_spacing + 0.5) + 0.5;
  float across = corner.x * (u_width * 0.5 + pad);
  v_local = vec2(across, 0.0);
  vec2 point = vertical
    ? vec2(at + across, (corner.y * 0.5 + 0.5) * u_screen.y)
    : vec2((corner.y * 0.5 + 0.5) * u_screen.x, at + across);
  gl_Position = screenToClip(point);
}
`;

const GRID_FRAGMENT = `
uniform int u_dots;
uniform float u_width;
uniform vec4 u_color;
in vec2 v_local;
out vec4 outColor;
void main() {
  float coverage = u_dots == 1
    ? clamp(u_width * u_dpr + 0.5 - length(v_local) * u_dpr, 0.0, 1.0)
    : clamp(u_width * u_dpr * 0.5 + 0.5 - abs(v_local.x) * u_dpr, 0.0, 1.0);
  outColor = u_color * coverage;
}
`;

function drawLevels(gpu: CanvasGpu, levels: readonly WorldGridLevel[], dots: boolean) {
  const { gl } = gpu;
  const { transform, screen } = gpu.view;
  const program = useProgram(gpu, "grid", GRID_VERTEX, GRID_FRAGMENT);
  gl.uniform1i(program.uniform("u_dots"), dots ? 1 : 0);
  for (const level of levels) {
    const spacing = level.size * transform.scale;
    const alpha = levelFadeAlpha(spacing, level.minScreenSpacing);
    if (alpha <= 0) continue;
    // The first line or dot at or before the screen's top-left corner.
    const first = {
      x: Math.floor(-transform.dx / spacing) * spacing + transform.dx,
      y: Math.floor(-transform.dy / spacing) * spacing + transform.dy,
    };
    const columns = Math.ceil((screen.width - first.x) / spacing) + 1;
    const rows = Math.ceil((screen.height - first.y) / spacing) + 1;
    gl.uniform1i(program.uniform("u_columns"), columns);
    gl.uniform2f(program.uniform("u_first"), first.x, first.y);
    gl.uniform1f(program.uniform("u_spacing"), spacing);
    gl.uniform1f(program.uniform("u_width"), level.lineWidth);
    setColor(gpu, program.uniform("u_color"), parseColor(level.color), alpha);
    gl.drawArraysInstanced(
      gl.TRIANGLE_STRIP,
      0,
      4,
      dots ? columns * rows : columns + rows,
    );
  }
}

export function drawWorldGrid(gpu: CanvasGpu, levels: readonly WorldGridLevel[]) {
  drawLevels(gpu, levels, false);
}

/** A dot at each grid intersection; `radius` is in screen pixels at every zoom. */
export function drawWorldDots(
  gpu: CanvasGpu,
  options: { size: number; color: string; radius: number; minScreenSpacing: number },
) {
  drawLevels(
    gpu,
    [
      {
        size: options.size,
        color: options.color,
        lineWidth: options.radius,
        minScreenSpacing: options.minScreenSpacing,
      },
    ],
    true,
  );
}
