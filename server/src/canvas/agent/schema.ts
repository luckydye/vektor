/**
 * The JSON schema of one `edit_canvas` operation: the field reference a model
 * reads with the tool, so it can build a canvas without fetching the recipe.
 * One flat object, since providers reject `oneOf`; each field says where it applies.
 */

import { GEO_KINDS, LINE_HEADS, LINE_ROUTES } from "#canvas/render/shapeGeometry.ts";

const ELEMENT_TYPES = [...GEO_KINDS, "circle", "text", "note", "arrow", "line", "frame", "slide", "image"];
const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };
const end = {
  type: ["string", "array", "object"],
  description:
    'Arrow end: an element id (attaches and follows it), {"id", "anchor": "top"|"bottom"|"left"|"right"|"center"|[ax, ay] as 0–1 fractions}, or a point [x, y].',
};

export const CANVAS_OPERATION_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["add", "update", "delete", "front", "back", "align", "distribute", "diagram", "chart"],
      description:
        "add: a new element. update: change fields of `id` (or every one of `ids`). delete/front/back: `ids`. " +
        "align: `ids` along `edge`. distribute: `ids` along `axis`. diagram/chart: laid out for you.",
    },
    type: { enum: ELEMENT_TYPES, description: "add: what to make. A slide is a 1920×1080 frame placed after the last one." },
    id: { type: "string", description: "Your own short id, e.g. \"s2-title\"; for diagram/chart, running it again with the same id replaces it." },
    ids: { type: "array", items: { type: "string" }, description: "A diagram's or chart's id stands for all its parts." },
    in: { type: ["string", "null"], description: "A frame or slide id: every coordinate in this operation is relative to its top-left." },
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number", description: "Shapes fit their text when w/h are left out." },
    h: { type: "number" },
    rotation: { type: "number", description: "Degrees." },
    text: { type: "string", description: "Markdown: **bold**, *italic*, - lists; a blank line starts a spaced paragraph." },
    title: {
      type: "string",
      description: 'frame/slide: a slide shows it as its title text box, id "<slide>-title"; update the slide\'s title to change it.',
    },
    fill: { type: "string", description: 'Colour (#rrggbb, rgba(), "transparent"). Shapes default to white; on a frame it is an accent tint.' },
    background: { type: "string", description: "frame/slide: opaque background colour." },
    stroke: { type: "string", description: "Outline or line colour, #334155 by default." },
    strokeWidth: { type: "number", description: "2 by default; 0 for no outline." },
    dash: { type: "string", enum: ["solid", "dashed", "dotted"] },
    radius: { type: "number", description: "rect corner radius." },
    fontSize: {
      type: "number",
      description: "Defaults: shapes 18, text 24, notes 15, arrow labels 14; on a slide shapes 28, text 32, notes and labels 24.",
    },
    textColor: { type: "string", description: "Default contrasts with the fill." },
    align: { type: "string", enum: ["start", "center", "end"] },
    valign: { type: "string", enum: ["top", "middle", "bottom"] },
    padding: { type: "number", description: "Between a shape's outline and its text: 12, text boxes 0." },
    points: { type: "array", items: point, description: "path: [[x, y], …] relative to x, y." },
    closed: { type: "boolean", description: "path: false draws an open polyline." },
    from: end,
    to: end,
    via: { type: "array", items: point, description: "arrow: points it passes through." },
    route: { type: "string", enum: [...LINE_ROUTES], description: "arrow; for diagram, how its edges run (curve by default)." },
    startHead: { type: "string", enum: [...LINE_HEADS] },
    endHead: { type: "string", enum: [...LINE_HEADS], description: 'An "arrow" ends with "arrow" by default.' },
    label: { type: "string", description: "arrow label." },
    labelAt: { type: "number", description: "arrow: where the label sits, 0 to 1 along it (0.5)." },
    src: { type: "string", description: "image URL." },
    alt: { type: "string" },
    clip: { type: "boolean", description: "frame: crop what overhangs it." },
    edge: { type: "string", enum: ["left", "center", "right", "top", "middle", "bottom"], description: "align." },
    axis: { type: "string", enum: ["x", "y"], description: "distribute." },
    gap: { type: "number", description: "distribute: space between; diagram: between layers (90)." },
    direction: { type: "string", enum: ["right", "down"], description: "diagram flow direction." },
    spacing: { type: "number", description: "diagram: between nodes in a layer (40)." },
    nodes: {
      type: "array",
      items: { type: "object" },
      description: "diagram: [{id, text, type?, …any shape field}]; sizes follow the text. Without x, y the diagram is centred in `in`.",
    },
    edges: { type: "array", items: { type: "object" }, description: "diagram: [{from, to, label?, …any arrow field}]." },
    style: { type: "object", description: "diagram: shape fields for every node, w and h included." },
    kind: { type: "string", enum: ["column", "bar", "line"], description: "chart." },
    data: { type: "array", items: { type: "object" }, description: 'chart: [{label, value, text?}]; text replaces the value label, e.g. "1 day".' },
    labels: { type: "array", items: { type: "string" }, description: "chart with several series." },
    series: { type: "array", items: { type: "object" }, description: "chart: [{name, values, color?}] with labels." },
    min: { type: "number", description: "chart axis; 0 by default." },
    max: { type: "number" },
    decimals: { type: "number", description: "chart value labels." },
    prefix: { type: "string", description: 'chart values, e.g. "$".' },
    suffix: { type: "string", description: 'chart values, e.g. "M".' },
    values: { type: "boolean", description: "chart: false hides value labels." },
    grid: { type: "boolean", description: "chart: false hides gridlines." },
    color: { type: "string", description: "chart with one series." },
  },
  required: ["op"],
} as const;
