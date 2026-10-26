/**
 * Charts as ordinary canvas elements — bars, axes, gridlines and labels — so a
 * model hands over the numbers and gets a chart it can still edit piece by piece.
 */

import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import { layoutLine } from "#canvas/raster/text.ts";

const FIELDS = ["id", "in", "x", "y", "w", "h", "kind", "labels", "series", "data", "min", "max", "fontSize", "values", "grid", "prefix", "suffix", "decimals", "color"];
const PALETTE = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];
const MUTED = "#64748b";
const GRID = "#e2e8f0";

interface Context {
  faces: ReadonlyMap<FontFace, Font>;
  at: string;
  fail: (message: string) => never;
  exists: (id: string) => boolean;
}

type Spec = Record<string, unknown>;
type Series = { name: string; color: string; values: number[] };

/** Round tick steps: 1, 2 or 5 times a power of ten, about five ticks. */
function ticks(min: number, max: number) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  const first = Math.floor(min / step) * step;
  const last = Math.ceil(max / step) * step;
  const values: number[] = [];
  for (let value = first; value <= last + step / 2; value += step) values.push(Math.round(value / step) * step);
  return values;
}

export function layoutChart(spec: Spec, context: Context) {
  for (const key of Object.keys(spec)) {
    if (!FIELDS.includes(key)) context.fail(`${context.at}: "${key}" is not a chart field. Fields: ${FIELDS.join(", ")}.`);
  }
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof spec[key] !== "number") context.fail(`${context.at}: a chart needs ${key}.`);
  }
  const kind = spec.kind ?? "column";
  if (kind !== "column" && kind !== "bar" && kind !== "line") context.fail(`${context.at}: kind must be column, bar or line.`);

  let labels: string[];
  // Value labels written out, such as "1 day" for 1440 minutes.
  let texts: (string | undefined)[] = [];
  let series: Series[];
  if (Array.isArray(spec.data)) {
    const data = spec.data as { label?: unknown; value?: unknown }[];
    if (!data.every((item) => typeof item?.label === "string" && typeof item?.value === "number")) {
      context.fail(`${context.at}: data is a list of {"label", "value"}.`);
    }
    labels = data.map((item) => item.label as string);
    texts = data.map((item) => (typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : undefined));
    series = [{ name: "", color: typeof spec.color === "string" ? spec.color : PALETTE[0], values: data.map((item) => item.value as number) }];
  } else {
    if (!Array.isArray(spec.labels) || !Array.isArray(spec.series)) {
      context.fail(`${context.at}: a chart needs data [{label, value}], or labels plus series [{name, values}].`);
    }
    labels = (spec.labels as unknown[]).map(String);
    series = (spec.series as Record<string, unknown>[]).map((item, i) => {
      const values = item?.values;
      if (!Array.isArray(values) || values.length !== labels.length || !values.every((value) => typeof value === "number")) {
        context.fail(`${context.at}: series ${i + 1} needs one number in values per label.`);
      }
      return {
        name: typeof item.name === "string" ? item.name : `Series ${i + 1}`,
        color: typeof item.color === "string" ? item.color : PALETTE[i % PALETTE.length],
        values: values as number[],
      };
    });
  }
  if (labels.length === 0) context.fail(`${context.at}: a chart needs at least one value.`);

  const prefix = spec.id as string;
  const x = spec.x as number;
  const y = spec.y as number;
  const w = spec.w as number;
  const h = spec.h as number;
  const fontSize = typeof spec.fontSize === "number" ? spec.fontSize : 20;
  const decimals = typeof spec.decimals === "number" ? spec.decimals : undefined;
  const format = (value: number, fixed = decimals) => {
    const text = fixed === undefined ? String(Math.round(value * 100) / 100) : value.toFixed(fixed);
    return `${spec.prefix ?? ""}${text}${spec.suffix ?? ""}`;
  };
  // Ticks are round numbers and read best without forced decimals.
  const formatTick = (value: number) => format(value, undefined);
  const all = series.flatMap((item) => item.values);
  const scale = ticks(
    typeof spec.min === "number" ? spec.min : Math.min(0, ...all),
    typeof spec.max === "number" ? spec.max : Math.max(0, ...all),
  );
  const low = scale[0];
  const high = scale[scale.length - 1];
  const width = (text: string, size = fontSize) =>
    layoutLine(text, { face: "regular", size, color: "#000" }, context.faces).width;
  const lineHeight = fontSize * 1.35;
  const inFrame = spec.in === undefined ? {} : { in: spec.in };
  const elements: Spec[] = [];
  const text = (id: string, at: { x: number; y: number; w: number }, content: string, options: Spec = {}) =>
    elements.push({ type: "text", id: `${prefix}-${id}`, ...inFrame, ...at, text: content, fontSize, textColor: MUTED, ...options });
  const rule = (id: string, from: [number, number], to: [number, number], options: Spec = {}) =>
    elements.push({ type: "line", id: `${prefix}-${id}`, ...inFrame, from, to, stroke: GRID, strokeWidth: 1, ...options });

  const legend = series.length > 1 ? lineHeight + 12 : 0;
  const horizontal = kind === "bar";
  // The plot area, leaving room for tick labels, category labels and a legend.
  const tickWidth = Math.max(...scale.map((value) => width(formatTick(value)))) + 16;
  const categoryWidth = Math.max(...labels.map((label) => width(label))) + 20;
  const plot = horizontal
    ? { x: x + categoryWidth, y: y + legend, w: w - categoryWidth - width(formatTick(high)) / 2, h: h - legend - lineHeight - 12 }
    : { x: x + tickWidth, y: y + legend + lineHeight / 2, w: w - tickWidth, h: h - legend - lineHeight * 1.5 - 16 };
  if (plot.w < 40 || plot.h < 40) context.fail(`${context.at}: the chart is too small for its labels; make w and h larger or fontSize smaller.`);
  const toValue = (value: number) => (value - low) / (high - low || 1);

  scale.forEach((value, i) => {
    const grid = spec.grid !== false || value === 0;
    if (horizontal) {
      const at = plot.x + toValue(value) * plot.w;
      if (grid) rule(`grid-${i}`, [at, plot.y], [at, plot.y + plot.h], value === low ? { stroke: MUTED } : {});
      const label = formatTick(value);
      text(`tick-${i}`, { x: at - width(label) / 2 - 2, y: plot.y + plot.h + 8, w: width(label) + 4 }, label, { align: "center" });
    } else {
      const at = plot.y + plot.h - toValue(value) * plot.h;
      if (grid) rule(`grid-${i}`, [plot.x, at], [plot.x + plot.w, at], value === low ? { stroke: MUTED } : {});
      const label = formatTick(value);
      text(`tick-${i}`, { x: x, y: at - lineHeight / 2, w: tickWidth - 12 }, label, { align: "end" });
    }
  });

  const band = (horizontal ? plot.h : plot.w) / labels.length;
  labels.forEach((label, i) => {
    const middle = (horizontal ? plot.y : plot.x) + band * (i + 0.5);
    if (horizontal) text(`label-${i}`, { x, y: middle - lineHeight / 2, w: categoryWidth - 12 }, label, { align: "end", textColor: "#0f172a" });
    else text(`label-${i}`, { x: middle - band / 2, y: plot.y + plot.h + 10, w: band }, label, { align: "center", textColor: "#0f172a" });
  });

  const zero = toValue(Math.max(low, Math.min(high, 0)));
  if (kind === "line") {
    series.forEach((item, s) => {
      const points = item.values.map((value, i) => [plot.x + band * (i + 0.5), plot.y + plot.h - toValue(value) * plot.h]);
      if (points.length > 1) {
        const minX = Math.min(...points.map((point) => point[0]));
        const minY = Math.min(...points.map((point) => point[1]));
        elements.push({
          type: "path", id: `${prefix}-line-${s}`, ...inFrame, x: minX, y: minY,
          points: points.map(([px, py]) => [px - minX, py - minY]), closed: false, fill: "transparent", stroke: item.color, strokeWidth: 4,
        });
      }
      points.forEach(([px, py], i) => {
        elements.push({ type: "ellipse", id: `${prefix}-dot-${s}-${i}`, ...inFrame, x: px - 7, y: py - 7, w: 14, h: 14, fill: item.color, stroke: "#ffffff", strokeWidth: 2 });
        if (spec.values !== false) {
          const label = (s === 0 && texts[i]) || format(item.values[i]);
          text(`value-${s}-${i}`, { x: px - width(label) / 2 - 2, y: py - lineHeight - 10, w: width(label) + 4 }, label, { align: "center", textColor: "#0f172a" });
        }
      });
    });
  } else {
    const groupWidth = band * 0.7;
    const barWidth = groupWidth / series.length;
    series.forEach((item, s) => {
      item.values.forEach((value, i) => {
        const start = (horizontal ? plot.y : plot.x) + band * i + (band - groupWidth) / 2 + barWidth * s;
        const from = Math.min(zero, toValue(value));
        const to = Math.max(zero, toValue(value));
        const label = (s === 0 && texts[i]) || format(value);
        if (horizontal) {
          const bar = { x: plot.x + from * plot.w, y: start, w: Math.max(1, (to - from) * plot.w), h: barWidth - 2 };
          elements.push({ type: "rect", id: `${prefix}-bar-${s}-${i}`, ...inFrame, ...bar, fill: item.color, strokeWidth: 0, radius: 3 });
          if (spec.values !== false) {
            text(`value-${s}-${i}`, { x: bar.x + bar.w + 8, y: bar.y + bar.h / 2 - lineHeight / 2, w: width(label) + 4 }, label, { textColor: "#0f172a" });
          }
        } else {
          const bar = { x: start, y: plot.y + plot.h - to * plot.h, w: barWidth - 2, h: Math.max(1, (to - from) * plot.h) };
          elements.push({ type: "rect", id: `${prefix}-bar-${s}-${i}`, ...inFrame, ...bar, fill: item.color, strokeWidth: 0, radius: 3 });
          if (spec.values !== false) {
            const size = Math.min(fontSize, Math.max(12, ((barWidth - 4) / Math.max(1, width(label))) * fontSize));
            const labelWidth = width(label, size) + 4;
            text(`value-${s}-${i}`, { x: bar.x + bar.w / 2 - labelWidth / 2, y: bar.y - size * 1.35 - 6, w: labelWidth }, label, { align: "center", textColor: "#0f172a", fontSize: size });
          }
        }
      });
    });
  }

  if (series.length > 1) {
    let cursor = x + (horizontal ? categoryWidth : tickWidth);
    series.forEach((item, s) => {
      elements.push({ type: "rect", id: `${prefix}-key-${s}`, ...inFrame, x: cursor, y: y + lineHeight / 2 - 8, w: 16, h: 16, fill: item.color, strokeWidth: 0, radius: 3 });
      text(`key-label-${s}`, { x: cursor + 24, y, w: width(item.name) + 4 }, item.name, { textColor: "#0f172a" });
      cursor += width(item.name) + 56;
    });
  }
  return { elements, bounds: { x, y, w, h }, id: prefix };
}
