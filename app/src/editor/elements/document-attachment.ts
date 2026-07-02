// Custom element for internal document attachments.
// Renders document previews by document type and emits `open-document` from the
// explicit open button.

import { chevronRightThinIcon, documentIcon, tableRowIcon } from "~/src/assets/icons.ts";
import type { WorkflowRunStatus } from "../../api/ApiClient.ts";

type DocumentPreviewStatus = "loading" | "loaded" | "error";
type DocumentPreviewType = "document" | "canvas" | "csv" | "workflow" | string;

type WorkflowPreviewState =
  | { status: "idle" | "loading" }
  | { status: "no-run" }
  | { status: "error"; message: string }
  | { status: "loaded"; run: WorkflowRunStatus };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isCanvasSnapshotContent(content: string): boolean {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { version?: unknown; shapes?: unknown };
    return parsed?.version === 1 && Array.isArray(parsed.shapes);
  } catch {
    return false;
  }
}

function documentTypeLabel(type: DocumentPreviewType | null): string {
  if (type === "canvas") return "Canvas";
  if (type === "csv") return "Table";
  if (type === "workflow") return "Workflow";
  return "Document";
}

function fallbackText(params: {
  status: DocumentPreviewStatus;
  type: DocumentPreviewType | null;
  content: string;
}) {
  if (params.status === "loading") return "Loading document content...";
  if (params.status === "error") return "Unable to load document content.";
  if (params.type === "canvas" || isCanvasSnapshotContent(params.content)) {
    return "Canvas document";
  }
  return "No document content";
}

function previewHtml(params: {
  status: DocumentPreviewStatus;
  type: DocumentPreviewType | null;
  content: string;
  workflow: WorkflowPreviewState | null;
}) {
  if (params.type === "workflow") {
    return workflowPreviewHtml(params.workflow);
  }

  const content = params.content.trim();
  if (
    params.status !== "loaded" ||
    !content ||
    params.type === "canvas" ||
    isCanvasSnapshotContent(content)
  ) {
    return `<p class="empty">${escapeHtml(fallbackText(params))}</p>`;
  }

  return `<div class="content">${content}</div>`;
}

function shouldRenderDocumentView(params: {
  status: DocumentPreviewStatus;
  type: DocumentPreviewType | null;
  content: string;
}) {
  if (params.status !== "loaded") return false;
  if (params.type === "workflow" || params.type === "csv") return false;
  if (params.type === "canvas" || isCanvasSnapshotContent(params.content)) return false;
  return true;
}

function setDocumentViewHtml(
  documentView: HTMLElement & { html?: string },
  html: string,
) {
  if (customElements.get("document-view")) {
    documentView.html = html;
    return;
  }

  void import("../document.ts")
    .then(() => customElements.whenDefined("document-view"))
    .then(() => {
      if (!documentView.isConnected) return;
      if (Object.hasOwn(documentView, "html")) {
        delete documentView.html;
      }
      documentView.html = html;
    })
    .catch((error) => {
      console.error("Failed to load document-view", error);
    });
}

// Job outputs are stored as { type: "text", value } or { type: "file", url } objects.
function unwrapOutputValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "text" && typeof record.value === "string") {
      return record.value;
    }
    if (record.type === "file" && typeof record.url === "string") {
      return record.url;
    }
  }
  return null;
}

function extractTableData(
  output: Record<string, unknown> | null | undefined,
): Record<string, unknown>[] | null {
  let raw: unknown = output?.data ?? output?.result;
  const serialized = unwrapOutputValue(raw);
  if (serialized !== null) {
    try {
      raw = JSON.parse(serialized);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (typeof raw[0] !== "object" || raw[0] === null) return null;
  return raw as Record<string, unknown>[];
}

function renderTablePreview(rows: Record<string, unknown>[]): string {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(
    0,
    6,
  );
  if (columns.length === 0) return "";

  return `
    <div class="workflow-table-wrap">
      <table class="workflow-table">
        <thead>
          <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows
            .slice(0, 5)
            .map(
              (row) => `
                <tr>
                  ${columns
                    .map((column) => {
                      const value = row[column];
                      const text =
                        typeof value === "object" && value !== null
                          ? JSON.stringify(value)
                          : String(value ?? "");
                      return `<td>${escapeHtml(text)}</td>`;
                    })
                    .join("")}
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function formatWorkflowDate(value: string | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function workflowStatusClass(status: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running" || status === "pending") return "running";
  return "neutral";
}

function workflowPreviewHtml(state: WorkflowPreviewState | null): string {
  if (!state || state.status === "idle" || state.status === "loading") {
    return `<p class="empty">Loading latest workflow run...</p>`;
  }
  if (state.status === "no-run") {
    return `<p class="empty">No workflow runs yet.</p>`;
  }
  if (state.status === "error") {
    return `<p class="empty">${escapeHtml(state.message)}</p>`;
  }
  if (state.status !== "loaded") {
    return `<p class="empty">No output</p>`;
  }

  const run = state.run;
  const outputHtml = unwrapOutputValue(run.output?.html);
  const outputDocumentId = unwrapOutputValue(run.output?.documentId);
  const tableData = extractTableData(run.output);
  const createdAt = formatWorkflowDate(run.createdAt);
  const status = run.status;
  const statusClass = workflowStatusClass(status);

  let output = "";
  if (status !== "completed") {
    output = `<p class="empty">Latest run is ${escapeHtml(status)}.</p>`;
  } else if (outputHtml) {
    output = `<div class="content workflow-output-html">${outputHtml}</div>`;
  } else if (tableData) {
    output = renderTablePreview(tableData);
  } else if (outputDocumentId) {
    output = `
      <button type="button" class="workflow-document-output" data-document-id="${escapeHtml(outputDocumentId)}">
        Open output document
      </button>
    `;
  } else {
    output = `<p class="empty">No output</p>`;
  }

  return `
    <div class="workflow-preview">
      <div class="workflow-meta">
        <span class="workflow-status ${statusClass}">${escapeHtml(status)}</span>
        ${createdAt ? `<span>${escapeHtml(createdAt)}</span>` : ""}
      </div>
      ${output}
    </div>
  `;
}

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("document-attachment")
) {
  customElements.define(
    "document-attachment",
    class DocumentAttachmentElement extends HTMLElement {
      shadow: ShadowRoot;
      private workflowPreviewKey = "";
      private workflowPreview: WorkflowPreviewState = { status: "idle" };

      static get observedAttributes() {
        return ["title", "type", "content", "status", "space-id", "document-id"];
      }

      constructor() {
        super();
        this.shadow = this.attachShadow({ mode: "open" });
      }

      connectedCallback() {
        this.render();
      }

      attributeChangedCallback(_name: string, oldValue: string, newValue: string) {
        if (oldValue !== newValue) this.render();
      }

      render() {
        const title = this.getAttribute("title") || "Untitled";
        const type = this.getAttribute("type") || "document";
        const content = this.getAttribute("content") || "";
        const status = (this.getAttribute("status") ||
          "loading") as DocumentPreviewStatus;
        const spaceId = this.getAttribute("space-id") || "";
        const documentId = this.getAttribute("document-id") || "";
        const icon = type === "csv" ? tableRowIcon : documentIcon;
        const workflow =
          type === "workflow" ? this.ensureWorkflowPreview(spaceId, documentId) : null;

        this.shadow.innerHTML = `
          <style>
            :host {
              display: flex;
              min-width: 0;
              min-height: 0;
              width: 100%;
              height: 100%;
              flex-direction: column;
              overflow: hidden;
              color: var(--canvas-text, #111827);
              font: inherit;
            }
            .header {
              display: flex;
              min-width: 0;
              flex: 0 0 auto;
              align-items: center;
              gap: 10px;
              border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
              padding: 10px 12px;
              cursor: move;
            }
            .icon {
              width: 18px;
              height: 18px;
              flex: 0 0 auto;
              color: var(--canvas-doc-accent, #2563eb);
            }
            .title-wrap {
              min-width: 0;
              flex: 1 1 auto;
            }
            .title {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              font-size: 14px;
              font-weight: 700;
              line-height: 1.2;
            }
            .type {
              margin-top: 2px;
              color: var(--canvas-muted, #6b7280);
              font-size: 11px;
              line-height: 1.1;
            }
            .open {
              display: inline-flex;
              width: 24px;
              height: 24px;
              flex: 0 0 auto;
              align-items: center;
              justify-content: center;
              border: 0;
              border-radius: 6px;
              background: transparent;
              padding: 0;
              color: var(--canvas-muted, #6b7280);
              cursor: pointer;
              font: inherit;
              text-decoration: none;
            }
            .open:hover {
              background: var(--canvas-tool-hover-bg, #f3f4f6);
              color: var(--canvas-text, #111827);
            }
            .open-icon {
              width: 16px;
              height: 16px;
            }
            .body {
              min-width: 0;
              min-height: 0;
              flex: 1 1 auto;
              overflow: auto;
              padding: 12px 14px 16px;
              color: var(--canvas-doc-content, #374151);
              cursor: move;
              scrollbar-width: thin;
            }
            .body document-view {
              display: block;
              min-width: 0;
            }
            .content {
              font-size: 13px;
              line-height: 1.45;
            }
            .content * {
              max-width: 100%;
            }
            .content h1,
            .content h2,
            .content h3,
            .content h4 {
              margin: 0.8em 0 0.35em;
              color: var(--canvas-text, #111827);
              font-weight: 750;
              line-height: 1.18;
            }
            .content h1:first-child,
            .content h2:first-child,
            .content h3:first-child,
            .content h4:first-child,
            .content p:first-child,
            .content ul:first-child,
            .content ol:first-child,
            .content table:first-child {
              margin-top: 0;
            }
            .content h1 {
              font-size: 22px;
            }
            .content h2 {
              font-size: 18px;
            }
            .content h3 {
              font-size: 15px;
            }
            .content p,
            .content ul,
            .content ol,
            .content blockquote,
            .content pre,
            .content table {
              margin: 0.55em 0;
            }
            .content ul,
            .content ol {
              padding-left: 1.25em;
            }
            .content img,
            .content video {
              display: block;
              height: auto;
              border-radius: 6px;
            }
            .content table {
              display: block;
              overflow: auto;
              border-collapse: collapse;
              font-size: 12px;
            }
            .content th,
            .content td {
              border: 1px solid var(--canvas-doc-divider, #e5e7eb);
              padding: 4px 6px;
              text-align: left;
            }
            .content pre,
            .content code {
              border-radius: 4px;
              background: var(--canvas-tool-hover-bg, #f3f4f6);
              font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            }
            .content pre {
              overflow: auto;
              padding: 8px;
            }
            .empty {
              margin: 0;
              color: var(--canvas-muted, #6b7280);
              font-size: 13px;
              line-height: 1.4;
            }
            .workflow-preview {
              display: grid;
              gap: 10px;
            }
            .workflow-meta {
              display: flex;
              flex-wrap: wrap;
              align-items: center;
              gap: 8px;
              color: var(--canvas-muted, #6b7280);
              font-size: 11px;
            }
            .workflow-status {
              display: inline-flex;
              align-items: center;
              border-radius: 999px;
              padding: 2px 8px;
              font-size: 11px;
              font-weight: 700;
              text-transform: capitalize;
            }
            .workflow-status.completed {
              background: #dcfce7;
              color: #047857;
            }
            .workflow-status.failed {
              background: #fee2e2;
              color: #b91c1c;
            }
            .workflow-status.running {
              background: #dbeafe;
              color: #1d4ed8;
            }
            .workflow-status.neutral {
              background: #f3f4f6;
              color: #4b5563;
            }
            .workflow-table-wrap {
              max-height: 150px;
              overflow: auto;
              border: 1px solid var(--canvas-doc-divider, #e5e7eb);
              border-radius: 6px;
            }
            .workflow-table {
              width: 100%;
              border-collapse: collapse;
              font-size: 11px;
            }
            .workflow-table th,
            .workflow-table td {
              border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
              padding: 4px 6px;
              text-align: left;
              vertical-align: top;
            }
            .workflow-table th {
              background: var(--canvas-tool-hover-bg, #f3f4f6);
              color: var(--canvas-text, #111827);
              font-weight: 700;
            }
            .workflow-document-output {
              justify-self: start;
              border: 1px solid var(--canvas-doc-divider, #e5e7eb);
              border-radius: 7px;
              background: #fff;
              padding: 7px 10px;
              color: var(--canvas-text, #111827);
              cursor: pointer;
              font: inherit;
              font-size: 12px;
              font-weight: 650;
            }
            .workflow-document-output:hover {
              border-color: #93c5fd;
              background: #eff6ff;
            }
          </style>
          <div class="header">
            <span class="icon">${icon}</span>
            <span class="title-wrap">
              <span class="title">${escapeHtml(title)}</span>
              <span class="type">${escapeHtml(documentTypeLabel(type))}</span>
            </span>
            <button type="button" class="open" draggable="false" aria-label="Open document">
              <span class="open-icon">${chevronRightThinIcon}</span>
            </button>
          </div>
          <div class="body">
            ${
              shouldRenderDocumentView({ status, type, content })
                ? `<document-view></document-view>`
                : previewHtml({ status, type, content, workflow })
            }
          </div>
        `;

        const documentView = this.shadow.querySelector<HTMLElement & { html?: string }>(
          "document-view",
        );
        if (documentView) {
          setDocumentViewHtml(documentView, content);
        }

        const button = this.shadow.querySelector<HTMLButtonElement>(".open");
        button?.addEventListener("pointerdown", (event) => {
          event.stopPropagation();
        });
        button?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.dispatchEvent(
            new CustomEvent("open-document", {
              bubbles: true,
              composed: true,
            }),
          );
        });
        const outputDocumentButton = this.shadow.querySelector<HTMLButtonElement>(
          ".workflow-document-output",
        );
        outputDocumentButton?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const outputDocumentId = outputDocumentButton.dataset.documentId;
          this.dispatchEvent(
            new CustomEvent("open-document", {
              bubbles: true,
              composed: true,
              detail: outputDocumentId ? { documentId: outputDocumentId } : undefined,
            }),
          );
        });
      }

      ensureWorkflowPreview(spaceId: string, documentId: string): WorkflowPreviewState {
        const key = `${spaceId}:${documentId}`;
        if (!spaceId || !documentId)
          return { status: "error", message: "Missing workflow id." };
        if (this.workflowPreviewKey === key && this.workflowPreview.status !== "idle") {
          return this.workflowPreview;
        }

        this.workflowPreviewKey = key;
        this.workflowPreview = { status: "loading" };
        void this.loadWorkflowPreview(spaceId, documentId, key);
        return this.workflowPreview;
      }

      async loadWorkflowPreview(spaceId: string, documentId: string, key: string) {
        try {
          const { api } = await import("../../api/client.ts");
          const latest = await api.workflows.getLatestRun(spaceId, documentId);
          if (this.workflowPreviewKey !== key) return;
          if (!latest) {
            this.workflowPreview = { status: "no-run" };
            this.render();
            return;
          }

          const run = await api.workflows.getRun(spaceId, latest.runId);
          if (this.workflowPreviewKey !== key) return;
          this.workflowPreview = { status: "loaded", run };
          this.render();
        } catch (error) {
          if (this.workflowPreviewKey !== key) return;
          this.workflowPreview = {
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unable to load latest workflow run.",
          };
          this.render();
        }
      }
    },
  );
}
