// Custom element for file attachments in the editor
// Renders file previews with unique UI based on file type:
// - Text files (md, txt): Show text content preview
// - 3D models (obj): Show a lightweight wireframe preview
// - Documents (docx, doc, pdf): Show document icon
// - Presentations (pptx, ppt): Show presentation icon
//
// Usage in HTML:
//   <file-attachment src="/api/v1/spaces/xxx/uploads/file.md" filename="readme.md"></file-attachment>

import {
  archiveBoxIcon,
  fileIcon,
  fileLinesIcon,
  fileSpreadsheetIcon,
  fileTextIcon,
  imageIcon,
  presentationIcon,
} from "~/src/assets/icons.ts";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "svg"];
const DOCUMENT_EXTENSIONS = ["docx", "doc", "pdf"];
const PRESENTATION_EXTENSIONS = ["pptx", "ppt"];
const SPREADSHEET_EXTENSIONS = ["xlsx", "xls", "csv"];
const ARCHIVE_EXTENSIONS = ["zip"];
const TEXT_EXTENSIONS = ["md", "txt"];
const MODEL_EXTENSIONS = ["obj"];

type FileType =
  | "image"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "archive"
  | "text"
  | "model"
  | "unknown";

type Vec3 = [number, number, number];
type Edge = [number, number];

type ObjModel = {
  vertices: Vec3[];
  edges: Edge[];
};

function getFileExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

function getFileType(filename: string): FileType {
  const ext = getFileExtension(filename);
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.includes(ext)) return "document";
  if (PRESENTATION_EXTENSIONS.includes(ext)) return "presentation";
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return "spreadsheet";
  if (ARCHIVE_EXTENSIONS.includes(ext)) return "archive";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  if (MODEL_EXTENSIONS.includes(ext)) return "model";
  return "unknown";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseObjIndex(token: string, vertexCount: number): number | null {
  const raw = Number.parseInt(token.split("/")[0] ?? "", 10);
  if (!Number.isInteger(raw) || raw === 0) return null;
  return raw < 0 ? vertexCount + raw : raw - 1;
}

function parseObj(text: string): ObjModel {
  const vertices: Vec3[] = [];
  const edges = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    if (parts[0] === "v") {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) vertices.push([x, y, z]);
      continue;
    }

    if (parts[0] !== "f" && parts[0] !== "l") continue;

    const indices = parts
      .slice(1)
      .map((token) => parseObjIndex(token, vertices.length))
      .filter((index): index is number => index !== null && index >= 0);
    if (indices.length < 2) continue;

    const segmentCount = parts[0] === "f" ? indices.length : indices.length - 1;
    for (let i = 0; i < segmentCount; i += 1) {
      const a = indices[i];
      const b = indices[(i + 1) % indices.length];
      if (a === undefined || b === undefined || a === b) continue;
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      edges.add(`${min}:${max}`);
    }
  }

  return {
    vertices,
    edges: Array.from(edges, (edge) => {
      const [a, b] = edge.split(":").map(Number);
      return [a, b] as Edge;
    }),
  };
}

function normalizeVertices(vertices: Vec3[]): Vec3[] {
  if (vertices.length === 0) return [];

  const min: Vec3 = [...vertices[0]] as Vec3;
  const max: Vec3 = [...vertices[0]] as Vec3;

  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], vertex[axis]);
      max[axis] = Math.max(max[axis], vertex[axis]);
    }
  }

  const center: Vec3 = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const scale = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);

  return vertices.map((vertex) => [
    (vertex[0] - center[0]) / scale,
    (vertex[1] - center[1]) / scale,
    (vertex[2] - center[2]) / scale,
  ]);
}

const ICONS: Record<FileType, string> = {
  document: fileTextIcon,
  presentation: presentationIcon,
  spreadsheet: fileSpreadsheetIcon,
  archive: archiveBoxIcon,
  text: fileLinesIcon,
  image: imageIcon,
  model: fileIcon,
  unknown: fileIcon,
};

const FILE_COLORS: Record<FileType, string> = {
  document: "#2563eb",
  presentation: "#ea580c",
  spreadsheet: "#16a34a",
  archive: "#7c3aed",
  text: "#6b7280",
  image: "#16a34a",
  model: "#0891b2",
  unknown: "#6b7280",
};

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("file-attachment")
) {
  customElements.define(
    "file-attachment",
    class FileAttachmentElement extends HTMLElement {
      shadow: ShadowRoot;
      previewEl: HTMLElement | null = null;
      private animationFrame: number | null = null;
      private previewRun = 0;
      private rotation = 0;

      static get observedAttributes() {
        return ["src", "filename"];
      }

      constructor() {
        super();
        this.shadow = this.attachShadow({ mode: "open" });
      }

      connectedCallback() {
        this.render();
      }

      attributeChangedCallback(_name: string, oldValue: string, newValue: string) {
        if (oldValue !== newValue) {
          this.render();
        }
      }

      render() {
        this.stopModelPreview();
        const run = ++this.previewRun;
        const src = this.getAttribute("src") || "";
        const filename = this.getAttribute("filename") || "file";
        const safeFilename = escapeHtml(filename);
        const fileType = getFileType(filename);

        this.shadow.innerHTML = `
          <style>
            :host {
              display: inline-flex;
              flex-direction: column;
              border: 1px solid #e5e7eb;
              border-radius: var(--radius-md);
              overflow: hidden;
              max-width: 300px;
              margin: 4px 0;
              background: #fff;
              cursor: pointer;
              transition: box-shadow 0.2s;
            }
            :host(:hover) {
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .preview-area {
              flex: 1;
              min-height: 100px;
              display: flex;
              align-items: center;
              justify-content: center;
              background: #f9fafb;
              padding: 16px;
              position: relative;
            }
            .preview-area.text-preview {
              align-items: flex-start;
            }
            .preview-area.model-preview {
              min-height: 92px;
              padding: 0;
              background: radial-gradient(circle at 50% 35%, #eef2ff 0, #f8fafc 62%);
            }
            .text-content {
              font-family: ui-monospace, monospace;
              font-size: 11px;
              line-height: 1.4;
              color: #374151;
              margin: 0;
              padding: 0;
              white-space: pre-wrap;
              word-break: break-word;
              max-height: 150px;
              overflow: hidden;
              text-align: left;
              width: 100%;
            }
            .model-canvas {
              display: block;
              width: 100%;
              height: 100%;
              min-height: 92px;
            }
            .model-status {
              position: absolute;
              inset: auto 8px 8px 8px;
              color: #64748b;
              font-size: 11px;
              line-height: 1.2;
              text-align: center;
              pointer-events: none;
            }
            .icon-wrapper {
              width: 48px;
              height: 48px;
            }
            .icon-wrapper svg {
              width: 100%;
              height: 100%;
            }
            .info-bar {
              display: flex;
              align-items: center;
              gap: 8px;
              padding: 8px 12px;
              border-top: 1px solid #e5e7eb;
              background: #fff;
            }
            .icon-small {
              width: 16px;
              height: 16px;
              flex-shrink: 0;
            }
            .icon-small svg {
              width: 100%;
              height: 100%;
            }
            .filename {
              font-size: 13px;
              color: #374151;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
          </style>
          <div class="preview-area ${fileType === "text" ? "text-preview" : ""} ${fileType === "model" ? "model-preview" : ""}">
            ${this.previewMarkup(fileType)}
          </div>
          <div class="info-bar">
            <div class="icon-small" style="color: ${FILE_COLORS[fileType]}">${ICONS[fileType]}</div>
            <span class="filename" title="${safeFilename}">${safeFilename}</span>
          </div>
        `;

        this.removeEventListener("click", this.handleClick);
        this.addEventListener("click", this.handleClick);

        if (fileType === "text" && src) {
          this.loadTextPreview(src, run);
        } else if (fileType === "model" && src) {
          this.loadModelPreview(src, run);
        }
      }

      previewMarkup(fileType: FileType): string {
        if (fileType === "text") {
          return `<pre class="text-content">Loading preview...</pre>`;
        }
        if (fileType === "model") {
          return `<canvas class="model-canvas" aria-label="3D model preview"></canvas><div class="model-status">Loading preview...</div>`;
        }
        return `<div class="icon-wrapper" style="color: ${FILE_COLORS[fileType]}">${ICONS[fileType]}</div>`;
      }

      handleClick = (e: Event) => {
        e.preventDefault();
        const src = this.getAttribute("src");
        if (src) {
          window.open(src, "_blank");
        }
      };

      async loadTextPreview(src: string, run: number) {
        const previewEl = this.shadow.querySelector(".text-content");
        if (!previewEl) return;

        try {
          const response = await fetch(src);
          if (!response.ok) throw new Error("Failed to load");

          const text = await response.text();
          if (run !== this.previewRun) return;
          const preview = text.slice(0, 500);
          previewEl.textContent = preview + (text.length > 500 ? "\n..." : "");
        } catch {
          if (run === this.previewRun) previewEl.textContent = "Unable to load preview";
        }
      }

      async loadModelPreview(src: string, run: number) {
        const canvas = this.shadow.querySelector<HTMLCanvasElement>(".model-canvas");
        const status = this.shadow.querySelector<HTMLElement>(".model-status");
        if (!canvas) return;

        try {
          const response = await fetch(src);
          if (!response.ok) throw new Error("Failed to load");

          const model = parseObj(await response.text());
          if (run !== this.previewRun) return;
          if (model.vertices.length === 0 || model.edges.length === 0) {
            throw new Error("No mesh data");
          }

          if (status) status.textContent = "";
          this.renderModel(canvas, model);
        } catch {
          if (run !== this.previewRun) return;
          if (status) status.textContent = "Unable to preview OBJ";
          this.drawEmptyModelState(canvas);
        }
      }

      renderModel(canvas: HTMLCanvasElement, model: ObjModel) {
        const vertices = normalizeVertices(model.vertices);
        const context = canvas.getContext("2d");
        if (!context) return;

        const draw = () => {
          const rect = canvas.getBoundingClientRect();
          const width = Math.max(1, Math.round(rect.width));
          const height = Math.max(1, Math.round(rect.height));
          const ratio = window.devicePixelRatio || 1;
          const pixelWidth = Math.round(width * ratio);
          const pixelHeight = Math.round(height * ratio);

          if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
          }

          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          context.clearRect(0, 0, width, height);
          context.lineWidth = 1;
          context.strokeStyle = "#0891b2";
          context.globalAlpha = 0.9;

          const sinY = Math.sin(this.rotation);
          const cosY = Math.cos(this.rotation);
          const sinX = Math.sin(-0.38);
          const cosX = Math.cos(-0.38);
          const projected = vertices.map(([x, y, z]) => {
            const rotatedX = x * cosY - z * sinY;
            const rotatedZ = x * sinY + z * cosY;
            const rotatedY = y * cosX - rotatedZ * sinX;
            const tiltedZ = y * sinX + rotatedZ * cosX;
            const perspective = 1.8 / (1.8 + tiltedZ);
            return {
              x: width / 2 + rotatedX * perspective * width * 0.72,
              y: height / 2 - rotatedY * perspective * height * 0.72,
            };
          });

          context.beginPath();
          for (const [a, b] of model.edges) {
            const start = projected[a];
            const end = projected[b];
            if (!start || !end) continue;
            context.moveTo(start.x, start.y);
            context.lineTo(end.x, end.y);
          }
          context.stroke();

          this.rotation += 0.01;
          this.animationFrame = requestAnimationFrame(draw);
        };

        draw();
      }

      drawEmptyModelState(canvas: HTMLCanvasElement) {
        const context = canvas.getContext("2d");
        if (!context) return;
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        context.strokeStyle = "#94a3b8";
        context.strokeRect(width / 2 - 18, height / 2 - 18, 36, 36);
      }

      stopModelPreview() {
        if (this.animationFrame !== null) {
          cancelAnimationFrame(this.animationFrame);
          this.animationFrame = null;
        }
      }

      disconnectedCallback() {
        this.stopModelPreview();
        this.removeEventListener("click", this.handleClick);
      }

      get src(): string | null {
        return this.getAttribute("src");
      }

      set src(value: string | null) {
        if (value) {
          this.setAttribute("src", value);
        } else {
          this.removeAttribute("src");
        }
      }

      get filename(): string | null {
        return this.getAttribute("filename");
      }

      set filename(value: string | null) {
        if (value) {
          this.setAttribute("filename", value);
        } else {
          this.removeAttribute("filename");
        }
      }
    },
  );
}
