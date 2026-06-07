// Custom element for file attachments in the editor
// Renders file previews with unique UI based on file type:
// - Text files (md, txt): Show text content preview
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

type FileType =
  | "image"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "archive"
  | "text"
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
  return "unknown";
}

const ICONS: Record<FileType, string> = {
  document: fileTextIcon,
  presentation: presentationIcon,
  spreadsheet: fileSpreadsheetIcon,
  archive: archiveBoxIcon,
  text: fileLinesIcon,
  image: imageIcon,
  unknown: fileIcon,
};

const FILE_COLORS: Record<FileType, string> = {
  document: "#2563eb",
  presentation: "#ea580c",
  spreadsheet: "#16a34a",
  archive: "#7c3aed",
  text: "#6b7280",
  image: "#16a34a",
  unknown: "#6b7280",
};

customElements.define(
  "file-attachment",
  class FileAttachmentElement extends HTMLElement {
    shadow: ShadowRoot;
    previewEl: HTMLElement | null = null;

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
      const src = this.getAttribute("src") || "";
      const filename = this.getAttribute("filename") || "file";
      const fileType = getFileType(filename);

      this.shadow.innerHTML = `
        <style>
          :host {
            display: inline-flex;
            flex-direction: column;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
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
            min-height: 100px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #f9fafb;
            padding: 16px;
          }
          .preview-area.text-preview {
            align-items: flex-start;
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
        <div class="preview-area ${fileType === "text" ? "text-preview" : ""}">
          ${
            fileType === "text"
              ? `<pre class="text-content">Loading preview...</pre>`
              : `<div class="icon-wrapper" style="color: ${FILE_COLORS[fileType]}">${ICONS[fileType]}</div>`
          }
        </div>
        <div class="info-bar">
          <div class="icon-small" style="color: ${FILE_COLORS[fileType]}">${ICONS[fileType]}</div>
          <span class="filename" title="${filename}">${filename}</span>
        </div>
      `;

      this.addEventListener("click", this.handleClick);

      if (fileType === "text" && src) {
        this.loadTextPreview(src);
      }
    }

    handleClick = (e: Event) => {
      e.preventDefault();
      const src = this.getAttribute("src");
      if (src) {
        window.open(src, "_blank");
      }
    };

    async loadTextPreview(src: string) {
      const previewEl = this.shadow.querySelector(".text-content");
      if (!previewEl) return;

      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error("Failed to load");

        const text = await response.text();
        const preview = text.slice(0, 500);
        previewEl.textContent = preview + (text.length > 500 ? "\n..." : "");
      } catch {
        previewEl.textContent = "Unable to load preview";
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
