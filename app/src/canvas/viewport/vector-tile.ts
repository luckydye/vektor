import { classifyRings, VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { WorldTransform } from "./transform";

// Where a vector tile sits in world space.
export interface VectorTileRect {
  worldX: number;
  worldY: number;
  worldWidth: number;
  worldHeight: number;
}

export type VectorTileLayerStyle = {
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  // Radius in screen pixels for point features
  pointRadius?: number;
};

// Called once per feature. Return null to skip the feature entirely.
export type VectorTileStyleFn = (
  layerName: string,
  properties: Record<string, number | string | boolean>,
) => VectorTileLayerStyle | null;

// Minimal default style keyed on common OpenMapTiles / MapTiler layer names.
const DEFAULT_STYLE: VectorTileStyleFn = (layerName) => {
  switch (layerName) {
    case "water":
    case "waterway":
      return { fill: "#a8c8e8", stroke: null };
    case "road":
    case "roads":
    case "transportation":
      return { fill: null, stroke: "#c0b8b0", strokeWidth: 1 };
    case "building":
    case "buildings":
      return { fill: "#d8d0c8", stroke: "#b8b0a8", strokeWidth: 0.5 };
    case "landuse":
    case "land":
    case "landcover":
      return { fill: "#e8e4dc", stroke: null };
    case "boundary":
    case "admin":
      return { fill: null, stroke: "#999", strokeWidth: 1 };
    default:
      return { fill: "#ddd", stroke: null };
  }
};

// ---------------------------------------------------------------------------
// Parsed tile cache — geometry is decoded once per tile, not once per frame.
// Keyed on the ArrayBuffer identity so it's GC'd when the tile is evicted.
// ---------------------------------------------------------------------------

type ParsedFeature = {
  type: 0 | 1 | 2 | 3;
  properties: Record<string, number | string | boolean>;
  geometry: { x: number; y: number }[][];
};

type ParsedLayer = {
  name: string;
  extent: number;
  features: ParsedFeature[];
};

const parsedTileCache = new WeakMap<ArrayBuffer, ParsedLayer[]>();

function getParsedTile(data: ArrayBuffer): ParsedLayer[] {
  const cached = parsedTileCache.get(data);
  if (cached) return cached;

  const tile = new VectorTile(new PbfReader(data));
  const layers: ParsedLayer[] = [];
  for (const layerName of Object.keys(tile.layers)) {
    const layer = tile.layers[layerName];
    const features: ParsedFeature[] = [];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      features.push({
        type: f.type,
        properties: f.properties,
        geometry: f.loadGeometry(),
      });
    }
    layers.push({ name: layerName, extent: layer.extent, features });
  }
  parsedTileCache.set(data, layers);
  return layers;
}

// Render a single Mapbox Vector Tile (MVT) onto a canvas context.
//
// data       — raw .pbf bytes (ArrayBuffer or Uint8Array)
// tileRect   — where this tile sits in viewport world space
// transform  — the current world→screen transform from buildTransform()
// style      — optional per-feature style callback; defaults to a basic scheme
export function drawVectorTile(
  ctx: CanvasRenderingContext2D,
  data: ArrayBuffer | Uint8Array,
  tileRect: VectorTileRect,
  transform: WorldTransform,
  style: VectorTileStyleFn = DEFAULT_STYLE,
): void {
  // Normalise to ArrayBuffer for WeakMap keying.
  const buf = data instanceof Uint8Array ? data.buffer : data;
  const layers = getParsedTile(buf);

  for (const layer of layers) {
    const { name: layerName, extent } = layer;

    // Precompute the affine coefficients that map tile coords → screen coords.
    // screenX = ox + tileX * sx
    const sx = (tileRect.worldWidth / extent) * transform.scale;
    const sy = (tileRect.worldHeight / extent) * transform.scale;
    const ox = tileRect.worldX * transform.scale + transform.dx;
    const oy = tileRect.worldY * transform.scale + transform.dy;

    for (const feature of layer.features) {
      const s = style(layerName, feature.properties);
      if (!s) continue;

      const geometry = feature.geometry;

      switch (feature.type) {
        case 1: {
          // Point — draw a filled circle per coordinate
          const r = s.pointRadius ?? 3;
          for (const ring of geometry) {
            for (const pt of ring) {
              ctx.beginPath();
              ctx.arc(ox + pt.x * sx, oy + pt.y * sy, r, 0, Math.PI * 2);
              if (s.fill) {
                ctx.fillStyle = s.fill;
                ctx.fill();
              }
              if (s.stroke) {
                ctx.strokeStyle = s.stroke;
                ctx.lineWidth = s.strokeWidth ?? 1;
                ctx.stroke();
              }
            }
          }
          break;
        }
        case 2: {
          // LineString
          if (!s.stroke) break;
          ctx.beginPath();
          for (const ring of geometry) {
            if (ring.length === 0) continue;
            ctx.moveTo(ox + ring[0].x * sx, oy + ring[0].y * sy);
            for (let j = 1; j < ring.length; j++) {
              ctx.lineTo(ox + ring[j].x * sx, oy + ring[j].y * sy);
            }
          }
          ctx.strokeStyle = s.stroke;
          ctx.lineWidth = s.strokeWidth ?? 1;
          ctx.stroke();
          break;
        }
        case 3: {
          // Polygon — classifyRings splits outer rings from holes so we can
          // use the even-odd rule to punch holes correctly.
          if (!s.fill && !s.stroke) break;
          const polygons = classifyRings(geometry);
          for (const rings of polygons) {
            ctx.beginPath();
            for (const ring of rings) {
              if (ring.length === 0) continue;
              ctx.moveTo(ox + ring[0].x * sx, oy + ring[0].y * sy);
              for (let j = 1; j < ring.length; j++) {
                ctx.lineTo(ox + ring[j].x * sx, oy + ring[j].y * sy);
              }
              ctx.closePath();
            }
            if (s.fill) {
              ctx.fillStyle = s.fill;
              ctx.fill("evenodd");
            }
            if (s.stroke) {
              ctx.strokeStyle = s.stroke;
              ctx.lineWidth = s.strokeWidth ?? 1;
              ctx.stroke();
            }
          }
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VectorTileMap — LOD tile manager
// ---------------------------------------------------------------------------

export interface VectorTileMapOptions {
  // Returns the fetch URL for a given z/x/y tile.
  getTileUrl: (z: number, x: number, y: number) => string;
  // World-space rect occupied by the full tile grid (the entire map).
  // worldX/worldY default to 0; worldWidth/worldHeight define the coordinate space.
  worldX?: number;
  worldY?: number;
  worldWidth: number;
  worldHeight: number;
  // Minimum tile zoom level (used for backdrop lookup). Default: 0.
  minZ?: number;
  // Maximum tile zoom to fetch. Default: 14.
  maxZ?: number;
  // Per-feature style callback forwarded to drawVectorTile.
  style?: VectorTileStyleFn;
  // Device pixel ratio forwarded from the page — used to size tile surfaces at
  // physical pixel resolution so they look crisp on high-DPR displays. Default: 1.
  devicePixelRatio?: number;
  // Hard cap on the offscreen surface size in pixels. Default: 4096.
  maxRenderSize?: number;
  // Called after each tile finishes loading — use to trigger a redraw.
  onLoad?: () => void;
}

export interface VectorTileMapStats {
  tileZ: number;
  loaded: number;
  total: number;
}

export interface VectorTileMap {
  // Kick off fetches for any uncached tiles visible in the current view.
  ensureTiles(
    cameraZoom: number,
    transform: WorldTransform,
    screenW: number,
    screenH: number,
  ): void;
  // Draw all cached tiles with backdrop buffering: a lower-zoom tile is
  // rendered first so there is no blank gap while higher-zoom tiles load.
  draw(
    ctx: CanvasRenderingContext2D,
    transform: WorldTransform,
    cameraZoom: number,
  ): VectorTileMapStats;
  // Draw tile borders + z/x/y labels for the active zoom level (debug overlay).
  drawDebug(
    ctx: CanvasRenderingContext2D,
    transform: WorldTransform,
    cameraZoom: number,
  ): void;
}

export function createVectorTileMap(options: VectorTileMapOptions): VectorTileMap {
  const {
    getTileUrl,
    worldX = 0,
    worldY = 0,
    worldWidth,
    worldHeight,
    minZ = 0,
    maxZ = 14,
    style,
    devicePixelRatio: dpr = 1,
    maxRenderSize = 4096,
    onLoad,
  } = options;

  // "z/x/y" → ArrayBuffer | "loading" | "error"
  const cache = new Map<string, ArrayBuffer | "loading" | "error">();

  // Compute only the tiles visible in the current viewport at the given zoom level.
  // Derives tile indices directly from the world→screen transform so it is O(visible)
  // regardless of how many tiles exist at that zoom level globally.
  function tilesForZoom(
    tileZ: number,
    transform: WorldTransform,
    screenW: number,
    screenH: number,
  ) {
    const tileCount = 1 << tileZ; // 2^tileZ tiles per axis
    const tileW = worldWidth / tileCount;
    const tileH = worldHeight / tileCount;

    // Visible world bounds from screen corners.
    const wLeft = (0 - transform.dx) / transform.scale;
    const wRight = (screenW - transform.dx) / transform.scale;
    const wTop = (0 - transform.dy) / transform.scale;
    const wBottom = (screenH - transform.dy) / transform.scale;

    const xMin = Math.max(0, Math.floor((wLeft - worldX) / tileW));
    const xMax = Math.min(tileCount - 1, Math.floor((wRight - worldX) / tileW));
    const yMin = Math.max(0, Math.floor((wTop - worldY) / tileH));
    const yMax = Math.min(tileCount - 1, Math.floor((wBottom - worldY) / tileH));

    const tiles: Array<{
      key: string;
      z: number;
      x: number;
      y: number;
      worldX: number;
      worldY: number;
      worldWidth: number;
      worldHeight: number;
    }> = [];
    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        tiles.push({
          key: `${tileZ}/${tx}/${ty}`,
          z: tileZ,
          x: tx,
          y: ty,
          worldX: worldX + tx * tileW,
          worldY: worldY + ty * tileH,
          worldWidth: tileW,
          worldHeight: tileH,
        });
      }
    }
    return tiles;
  }

  // Fixed surface size: detail comes from fetching higher-LOD tiles, not from
  // re-rendering the same tile data at a larger size. A fixed size means surfaces
  // are created once per tile and never reallocated, which eliminates the GC
  // pressure that comes from allocating large OffscreenCanvases on every zoom tick.
  // Within each LOD level camera zoom goes from 2^n to 2^(n+1), so tiles can be
  // upscaled up to 2× before the next LOD kicks in. Using 1024*dpr as the base
  // (2048px on Retina) covers that 2× headroom — surfaces are always displayed at
  // ≤ their render resolution, which also eliminates bilinear-filter fringing at
  // high-contrast edges like road outlines.
  const renderSize = Math.min(
    2 ** Math.ceil(Math.log2(Math.max(1024 * dpr, 1))),
    maxRenderSize,
  );

  type TileSurface = OffscreenCanvas | HTMLCanvasElement;
  const surfaces = new WeakMap<ArrayBuffer, TileSurface>();

  function getOrCreateSurface(buf: ArrayBuffer): TileSurface {
    const cached = surfaces.get(buf);
    if (cached) return cached;

    const surface =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(renderSize, renderSize)
        : document.createElement("canvas");
    surface.width = renderSize;
    surface.height = renderSize;

    const sCtx = surface.getContext("2d");
    if (!sCtx || !("fillRect" in sCtx))
      throw new Error("tile surface 2d context required");
    drawVectorTile(
      sCtx as CanvasRenderingContext2D,
      buf,
      { worldX: 0, worldY: 0, worldWidth: renderSize, worldHeight: renderSize },
      { scale: 1, dx: 0, dy: 0 },
      style ?? DEFAULT_STYLE,
    );

    surfaces.set(buf, surface);
    return surface;
  }

  async function fetchTile(z: number, x: number, y: number, key: string) {
    cache.set(key, "loading");
    try {
      const r = await fetch(getTileUrl(z, x, y));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      cache.set(key, await r.arrayBuffer());
    } catch {
      cache.set(key, "error");
    }
    onLoad?.();
  }

  function drawZoomLevel(
    ctx: CanvasRenderingContext2D,
    tileZ: number,
    transform: WorldTransform,
    screenW: number,
    screenH: number,
  ): number {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    let loaded = 0;
    // tilesForZoom already returns only viewport-visible tiles.
    for (const tile of tilesForZoom(tileZ, transform, screenW, screenH)) {
      const buf = cache.get(tile.key);
      if (!(buf instanceof ArrayBuffer)) continue;
      const sx = tile.worldX * transform.scale + transform.dx;
      const sy = tile.worldY * transform.scale + transform.dy;
      const sw = tile.worldWidth * transform.scale;
      const sh = tile.worldHeight * transform.scale;
      // Expand by 0.5 screen px on each edge to close sub-pixel seams.
      ctx.drawImage(getOrCreateSurface(buf), sx - 0.5, sy - 0.5, sw + 1, sh + 1);
      loaded++;
    }
    return loaded;
  }

  function tileZoomForCamera(cameraZoom: number): number {
    const delta = Math.max(0, Math.floor(Math.log2(cameraZoom)));
    return Math.min(minZ + delta, maxZ);
  }

  return {
    ensureTiles(
      cameraZoom: number,
      transform: WorldTransform,
      screenW: number,
      screenH: number,
    ): void {
      const tileZ = tileZoomForCamera(cameraZoom);
      for (const t of tilesForZoom(tileZ, transform, screenW, screenH)) {
        if (!cache.has(t.key)) fetchTile(t.z, t.x, t.y, t.key);
      }
    },

    draw(
      ctx: CanvasRenderingContext2D,
      transform: WorldTransform,
      cameraZoom: number,
    ): VectorTileMapStats {
      const tileZ = tileZoomForCamera(cameraZoom);
      const screenW = ctx.canvas.width / dpr;
      const screenH = ctx.canvas.height / dpr;

      // Find the nearest lower zoom level with any cached visible tiles to use as backdrop.
      let backdropZ = -1;
      for (let z = tileZ - 1; z >= minZ; z--) {
        if (
          tilesForZoom(z, transform, screenW, screenH).some(
            (t) => cache.get(t.key) instanceof ArrayBuffer,
          )
        ) {
          backdropZ = z;
          break;
        }
      }

      if (backdropZ >= 0) {
        // Clip the backdrop to only areas NOT covered by a loaded current-level tile.
        // The even-odd rule on nested rects punches holes: outer rect = "draw here",
        // each loaded tile rect = "but not here". Streets that cross a loaded/unloaded
        // tile boundary then stay sharp on both sides instead of switching resolution.
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, screenW, screenH);
        for (const tile of tilesForZoom(tileZ, transform, screenW, screenH)) {
          if (!(cache.get(tile.key) instanceof ArrayBuffer)) continue;
          const sx = tile.worldX * transform.scale + transform.dx;
          const sy = tile.worldY * transform.scale + transform.dy;
          const sw = tile.worldWidth * transform.scale;
          const sh = tile.worldHeight * transform.scale;
          ctx.rect(sx - 1, sy - 1, sw + 2, sh + 2);
        }
        ctx.clip("evenodd");
        drawZoomLevel(ctx, backdropZ, transform, screenW, screenH);
        ctx.restore();
      }

      const loaded = drawZoomLevel(ctx, tileZ, transform, screenW, screenH);
      return {
        tileZ,
        loaded,
        total: tilesForZoom(tileZ, transform, screenW, screenH).length,
      };
    },

    drawDebug(
      ctx: CanvasRenderingContext2D,
      transform: WorldTransform,
      cameraZoom: number,
    ): void {
      const tileZ = tileZoomForCamera(cameraZoom);
      const screenW = ctx.canvas.width / dpr;
      const screenH = ctx.canvas.height / dpr;

      // Mirror draw(): collect the backdrop zoom level (if any) + active level.
      const levelsToShow: Array<{ z: number; isBackdrop: boolean }> = [];
      for (let z = tileZ - 1; z >= minZ; z--) {
        if (
          tilesForZoom(z, transform, screenW, screenH).some(
            (t) => cache.get(t.key) instanceof ArrayBuffer,
          )
        ) {
          levelsToShow.push({ z, isBackdrop: true });
          break;
        }
      }
      levelsToShow.push({ z: tileZ, isBackdrop: false });

      ctx.save();
      ctx.lineWidth = 1;
      ctx.font = "11px monospace";
      ctx.textBaseline = "top";

      for (const { z, isBackdrop } of levelsToShow) {
        for (const tile of tilesForZoom(z, transform, screenW, screenH)) {
          const sx = tile.worldX * transform.scale + transform.dx;
          const sy = tile.worldY * transform.scale + transform.dy;
          const sw = tile.worldWidth * transform.scale;
          const sh = tile.worldHeight * transform.scale;

          const status = cache.get(tile.key);
          if (isBackdrop) {
            // Backdrop tiles: only show the ones actually drawn (loaded).
            if (!(status instanceof ArrayBuffer)) continue;
            ctx.strokeStyle = "rgba(120,180,255,0.8)";
          } else {
            ctx.strokeStyle =
              status instanceof ArrayBuffer
                ? "rgba(80,220,80,0.9)"
                : status === "loading"
                  ? "rgba(255,200,0,0.9)"
                  : status === "error"
                    ? "rgba(255,60,60,0.9)"
                    : "rgba(160,160,160,0.6)";
          }
          ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);

          const label = `${tile.z}/${tile.x}/${tile.y}${isBackdrop ? " ↙" : ""}`;
          const pad = 4;
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(sx + pad, sy + pad, ctx.measureText(label).width + 6, 17);
          ctx.fillStyle = isBackdrop ? "#9cf" : "#fff";
          ctx.fillText(label, sx + pad + 3, sy + pad + 3);
        }
      }

      ctx.restore();
    },
  };
}
