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

const FULLSCREEN_VERTEX = `
void main() {
  gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Lines snap to CSS pixel centres like the old 2D grid, so a 1px line stays
// crisp at every dpr; dots are centred on the exact intersections.
const GRID_FRAGMENT = `
uniform int u_dots;
uniform float u_originY;
uniform int u_count;
uniform float u_size[2];
uniform float u_lineWidth[2];
uniform vec4 u_color[2];
out vec4 outColor;

float lineCoverage(float s, float offset, float spacing, float width) {
  float k = floor((s - offset) / spacing + 0.5);
  float line = floor(k * spacing + offset + 0.5) + 0.5;
  return clamp(width * u_dpr * 0.5 + 0.5 - abs(s - line) * u_dpr, 0.0, 1.0);
}

void main() {
  // gl_FragCoord counts from the framebuffer's bottom, below the viewport.
  vec2 s = vec2(gl_FragCoord.x, u_screen.y * u_dpr - (gl_FragCoord.y - u_originY)) / u_dpr;
  vec4 color = vec4(0.0);
  for (int i = 0; i < 2; i++) {
    if (i >= u_count) break;
    float spacing = u_size[i] * u_view.x;
    float coverage;
    if (u_dots == 1) {
      vec2 cell = floor((s - u_view.yz) / spacing + 0.5) * spacing + u_view.yz;
      coverage = clamp(u_lineWidth[i] * u_dpr + 0.5 - length(s - cell) * u_dpr, 0.0, 1.0);
    } else {
      coverage = max(
        lineCoverage(s.x, u_view.y, spacing, u_lineWidth[i]),
        lineCoverage(s.y, u_view.z, spacing, u_lineWidth[i])
      );
    }
    vec4 layer = u_color[i] * coverage;
    color = layer + color * (1.0 - layer.a);
  }
  outColor = color;
}
`;

function drawLevels(gpu: CanvasGpu, levels: readonly WorldGridLevel[], dots: boolean) {
  const { gl } = gpu;
  const visible = levels
    .map((level) => ({
      level,
      alpha: levelFadeAlpha(
        level.size * gpu.view.transform.scale,
        level.minScreenSpacing,
      ),
    }))
    .filter(({ alpha }) => alpha > 0);
  if (visible.length === 0) return;
  if (visible.length > 2) throw new Error("The grid shader draws at most two levels");

  const program = useProgram(gpu, "grid", FULLSCREEN_VERTEX, GRID_FRAGMENT);
  gl.uniform1i(program.uniform("u_dots"), dots ? 1 : 0);
  gl.uniform1f(program.uniform("u_originY"), gpu.originY);
  gl.uniform1i(program.uniform("u_count"), visible.length);
  visible.forEach(({ level, alpha }, index) => {
    gl.uniform1f(program.uniform(`u_size[${index}]`), level.size);
    gl.uniform1f(program.uniform(`u_lineWidth[${index}]`), level.lineWidth);
    setColor(gpu, program.uniform(`u_color[${index}]`), parseColor(level.color), alpha);
  });
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
