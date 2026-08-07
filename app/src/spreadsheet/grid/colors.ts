/**
 * The palette used to tint the ranges a formula refers to — each reference in
 * `=SUM(A1:A2)+B1` gets the next colour, in both the formula text and the
 * outline drawn around the range on the grid.
 *
 * Ported from IronCalc (`components/Editor/util.tsx`, tag v0.8.3), MIT OR
 * Apache-2.0. See ./README.md.
 */

const RANGE_COLORS = [
  { hex: "#59B9BC", rgb: [89, 185, 188] }, // Cyan
  { hex: "#EC5753", rgb: [236, 87, 83] }, // Flamingo
  { hex: "#3358B7", rgb: [51, 88, 183] }, // Blue
  { hex: "#F8CD3C", rgb: [248, 205, 60] }, // Yellow
  { hex: "#3BB68A", rgb: [59, 182, 138] }, // Emerald
  { hex: "#523E93", rgb: [82, 62, 147] }, // Violet
  { hex: "#A23C52", rgb: [162, 60, 82] }, // Burgundy
  { hex: "#8CB354", rgb: [140, 179, 84] }, // Wasabi
  { hex: "#D03627", rgb: [208, 54, 39] }, // Red
  { hex: "#1B717E", rgb: [27, 113, 126] }, // Teal
] as const;

export function getColor(index: number, alpha = 1): string {
  const color = RANGE_COLORS[
    index % RANGE_COLORS.length
  ] as (typeof RANGE_COLORS)[number];
  if (alpha === 1) return color.hex;
  const [red, green, blue] = color.rgb;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
