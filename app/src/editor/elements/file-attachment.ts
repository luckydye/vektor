// Custom element for file attachments in the editor
// Renders file previews with unique UI based on file type:
// - Text files (md, txt): Show text content preview
// - 3D models (obj, gltf, glb): Show a live WebGPU preview via <model-viewer-3d>
// - Documents (docx, doc, pdf): Show document icon
// - Presentations (pptx, ppt): Show presentation icon
//
// Usage in HTML:
//   <file-attachment src="/api/v1/spaces/xxx/uploads/file.md" filename="readme.md"></file-attachment>

import { iconMarkup } from "#components/Icon.tsx";
import { MODEL_VIEWER_TAG } from "#model-viewer/ModelViewerElement.ts";
import { escapeHtml } from "#utils/html.ts";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "svg"];
const DOCUMENT_EXTENSIONS = ["docx", "doc", "pdf"];
const PRESENTATION_EXTENSIONS = ["pptx", "ppt"];
const SPREADSHEET_EXTENSIONS = ["xlsx", "xls", "csv"];
const ARCHIVE_EXTENSIONS = ["zip"];
const TEXT_EXTENSIONS = ["md", "txt"];
const MODEL_EXTENSIONS = ["obj", "gltf", "glb"];

type FileType =
  | "image"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "archive"
  | "text"
  | "model"
  | "unknown";

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

const ICONS: Record<FileType, string> = {
  document: iconMarkup("document"),
  presentation: iconMarkup("presentation"),
  spreadsheet: iconMarkup("csv-file"),
  archive: iconMarkup("archive"),
  text: iconMarkup("file"),
  image: iconMarkup("image"),
  model: iconMarkup("file"),
  unknown: iconMarkup("file"),
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
      private previewRun = 0;

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
        const run = ++this.previewRun;
        const src = this.getAttribute("src") || "";
        const filename = this.getAttribute("filename") || "file";
        const safeFilename = escapeHtml(filename);
        const fileType = getFileType(filename);
        this.setAttribute("data-filetype", fileType);

        this.shadow.innerHTML = `
          <style>
            :host {
              display: inline-flex;
              flex-direction: column;
              border: 1px solid var(--color-neutral-200, #e5e7eb);
              border-radius: var(--radius-md);
              overflow: hidden;
              max-width: 300px;
              margin: 4px 0;
              background: var(--color-background, #fff);
              cursor: pointer;
              transition: box-shadow 0.2s;
            }
            :host(:hover) {
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            /* Let the model card grow past the default width when resized. */
            :host([data-filetype="model"]) {
              max-width: none;
            }
            .preview-area {
              flex: 1;
              display: flex;
              align-items: center;
              justify-content: center;
              background: var(--color-neutral-50, #f9fafb);
              padding: 16px;
              position: relative;
            }
            .preview-area.text-preview {
              align-items: flex-start;
            }
            .preview-area.model-preview {
              width: 280px;
              height: 200px;
              min-width: 160px;
              min-height: 120px;
              padding: 0;
              background: var(--color-neutral-100, #f1f5f9);
              /* Native drag handle so the preview can be resized in-place. */
              resize: both;
              overflow: hidden;
            }
            .text-content {
              font-family: ui-monospace, monospace;
              font-size: 11px;
              line-height: 1.4;
              color: var(--color-neutral-700, #374151);
              margin: 0;
              padding: 0;
              white-space: pre-wrap;
              word-break: break-word;
              max-height: 150px;
              overflow: hidden;
              text-align: left;
              width: 100%;
            }
            ${MODEL_VIEWER_TAG} {
              display: block;
              width: 100%;
              height: 100%;
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
              border-top: 1px solid var(--color-neutral-100, #e5e7eb);
              background: var(--color-background, #fff);
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
              color: var(--color-neutral-700, #374151);
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
          </style>
          <div class="preview-area ${fileType === "text" ? "text-preview" : ""} ${fileType === "model" ? "model-preview" : ""}">
            ${this.previewMarkup(fileType, src)}
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
        }
      }

      previewMarkup(fileType: FileType, src: string): string {
        if (fileType === "text") {
          return `<pre class="text-content">Loading preview...</pre>`;
        }
        if (fileType === "model") {
          // The 3D preview owns its own drag/orbit interaction; stop clicks on
          // it from bubbling to the card's open-in-new-tab handler.
          return `<${MODEL_VIEWER_TAG} src="${escapeHtml(src)}"></${MODEL_VIEWER_TAG}>`;
        }
        return `<div class="icon-wrapper" style="color: ${FILE_COLORS[fileType]}">${ICONS[fileType]}</div>`;
      }

      handleClick = (e: Event) => {
        // Interacting with the live 3D preview should orbit it, not open the file.
        if ((e.target as Element | null)?.closest?.(MODEL_VIEWER_TAG)) return;
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

      disconnectedCallback() {
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
