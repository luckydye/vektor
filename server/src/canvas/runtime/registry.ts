/**
 * Registering extensions, and the services they are handed. The half that knows
 * about the built-ins — hence separate from the contract in `extensionApi.ts`.
 */

import { api } from "#api/client.ts";
import type { CanvasCollaborationFactory } from "#canvas/document/collaboration.ts";
import {
  createDocumentLinkController,
  DOCUMENT_CANVAS_SERVICE,
  type DocumentCanvasService,
  type DocumentLinkReference,
  type DocumentPreviewSource,
  documentAddressForShape,
  documentUrlPartsFromUrl,
  fetchRemoteDocumentByAddress,
  insertDocumentUrl,
  isRemoteDocumentAddress,
  isRemoteDocumentShape,
} from "#canvas/extensions/documentLink.ts";
import { pasteFigmaIntoCanvas } from "#canvas/extensions/figma.ts";
import { createUploadedFileShape } from "#canvas/extensions/files.ts";
import {
  builtInElements,
  builtInInputs,
  builtInTools,
} from "#canvas/extensions/index.ts";
import {
  createCanvasFileInsertionQueue,
  createUploadPlaceholderStore,
  splitCanvasFiles,
} from "#canvas/extensions/inputs.ts";
import { createLinkShape } from "#canvas/extensions/link.ts";
import {
  type CanvasUploader,
  createUploadedMediaShape,
  imageFileFromUrl,
  uploadMediaFile,
} from "#canvas/extensions/media.ts";
import type {
  CanvasEditSession,
  CanvasElementExtension,
  CanvasElementTool,
  CanvasExtensionHost,
  CanvasInputHandler,
  CanvasInputHandlerContext,
  CanvasInputKind,
  CanvasPoint,
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasSize,
  CanvasToolExtension,
  CanvasToolId,
  CanvasToolProperty,
  CanvasToolPropertyValue,
} from "#canvas/runtime/extensionApi.ts";
import { mediaTypeForFile } from "#files/fileTypes.ts";
import type { TranslationKey } from "#utils/lang.ts";

// ---------------------------------------------------------------------------
// from extensions/registry.ts
// ---------------------------------------------------------------------------

type CanvasColorPalette = {
  type: CanvasShapeType;
  label: TranslationKey;
  palette: readonly string[];
};

type CanvasExtensionManagerOptions = {
  elements?: readonly CanvasElementExtension[];
  tools?: readonly CanvasToolExtension[];
  inputs?: Partial<Record<CanvasInputKind, readonly CanvasInputHandler[]>>;
};

export class CanvasExtensionManager {
  readonly #elements = new Map<CanvasShapeType, CanvasElementExtension>();
  readonly #tools = new Map<CanvasToolId, CanvasToolExtension>();
  readonly #inputs = new Map<CanvasInputKind, CanvasInputHandler[]>();

  constructor(options: CanvasExtensionManagerOptions = {}) {
    for (const extension of options.elements ?? []) this.registerElement(extension);
    for (const tool of options.tools ?? []) this.registerTool(tool);
    for (const kind of ["paste", "drop"] as const) {
      for (const handler of options.inputs?.[kind] ?? [])
        this.registerInput(kind, handler);
    }
  }

  registerElement(extension: CanvasElementExtension) {
    if (this.#elements.has(extension.type)) {
      throw new Error(
        `Canvas element extension is already registered: ${extension.type}`,
      );
    }
    const toolId = extension.creation?.tool?.id;
    if (toolId && this.#tools.has(toolId)) {
      throw new Error(`Canvas tool is already registered: ${toolId}`);
    }
    this.#elements.set(extension.type, extension);
    for (const kind of ["paste", "drop"] as const) {
      const contribution = extension.input?.[kind];
      if (!contribution) continue;
      const handlers = Array.isArray(contribution) ? contribution : [contribution];
      for (const handler of handlers) this.registerInput(kind, handler);
    }
    if (toolId) {
      this.#tools.set(toolId, {
        id: toolId,
        onPointerDown: (at, _event, context) => context.createElement(extension.type, at),
      });
    }
    return this;
  }

  registerTool(tool: CanvasToolExtension) {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Canvas tool is already registered: ${tool.id}`);
    }
    this.#tools.set(tool.id, tool);
    return this;
  }

  registerInput(kind: CanvasInputKind, handler: CanvasInputHandler) {
    const handlers = this.#inputs.get(kind) ?? [];
    handlers.push(handler);
    handlers.sort((left, right) => right.priority - left.priority);
    this.#inputs.set(kind, handlers);
    return this;
  }

  handleInput(
    kind: CanvasInputKind,
    event: ClipboardEvent | DragEvent,
    context: CanvasInputHandlerContext,
  ) {
    return (this.#inputs.get(kind) ?? []).some((handler) =>
      handler.handle(event, context),
    );
  }

  has(type: unknown): type is CanvasShapeType {
    return typeof type === "string" && this.#elements.has(type);
  }

  get(type: CanvasShapeType) {
    const extension = this.#elements.get(type);
    if (!extension)
      throw new Error(`Canvas element extension is not registered: ${type}`);
    return extension;
  }

  elementTools(): CanvasElementTool[] {
    return [...this.#elements.values()]
      .map((extension) => extension.creation?.tool)
      .filter((tool): tool is CanvasElementTool => Boolean(tool));
  }

  /**
   * Every tool that wants a toolbar button, registration order first.
   *
   * Tool extensions come before element tools so the built-in draw button keeps
   * its place ahead of the element-creating tools.
   */
  toolbarTools(): CanvasElementTool[] {
    const fromTools = [...this.#tools.values()].flatMap((tool) =>
      tool.toolbar
        ? [
            {
              id: tool.id,
              label: tool.toolbar.label,
              shortcut: tool.shortcut ?? "",
              icon: tool.toolbar.icon,
            },
          ]
        : [],
    );
    // An element's tool is synthesised into #tools without toolbar metadata, so
    // the two lists never overlap.
    return [...fromTools, ...this.elementTools()];
  }

  /** Controls the given tool contributes to the tool-properties bar. */
  toolProperties(id: CanvasToolId): readonly CanvasToolProperty[] {
    return this.#tools.get(id)?.properties ?? [];
  }

  /**
   * Every tool's property defaults, for seeding engine state.
   *
   * Keyed by tool so two tools may declare the same property id without
   * sharing a value.
   */
  toolPropertyDefaults(): Record<string, Record<string, CanvasToolPropertyValue>> {
    const defaults: Record<string, Record<string, CanvasToolPropertyValue>> = {};
    for (const tool of this.#tools.values()) {
      if (!tool.properties?.length) continue;
      defaults[tool.id] = Object.fromEntries(
        tool.properties.map((property) => [property.id, property.default]),
      );
    }
    return defaults;
  }

  /**
   * Keyboard shortcut per tool, for whoever registers the actions.
   *
   * Covers both tool extensions and element-contributed tools, so a tool with a
   * shortcut but no button (the shape tool) is still reachable by key.
   */
  toolShortcuts(): Array<{ id: CanvasToolId; shortcut: string }> {
    const entries = [...this.#tools.values()].flatMap((tool) =>
      tool.shortcut ? [{ id: tool.id, shortcut: tool.shortcut }] : [],
    );
    for (const tool of this.elementTools()) {
      if (tool.shortcut) entries.push({ id: tool.id, shortcut: tool.shortcut });
    }
    return entries;
  }

  colorPalettes(): CanvasColorPalette[] {
    return [...this.#elements.values()].flatMap((extension) => {
      const creation = extension.creation;
      if (!creation?.palette || !creation.tool) return [];
      return [
        {
          type: extension.type,
          label: creation.tool.label,
          palette: creation.palette,
        },
      ];
    });
  }

  doubleClickType() {
    return [...this.#elements.values()].find(
      (extension) => extension.creation?.doubleClick,
    )?.type;
  }

  tool(id: CanvasToolId) {
    return this.#tools.get(id);
  }

  isValid(shape: CanvasShape) {
    return this.get(shape.type).isValid?.(shape) ?? true;
  }

  persistsSize(type: CanvasShapeType) {
    return this.get(type).behavior.transform.resize !== "font";
  }

  serialize(shape: CanvasShape): CanvasSerializedShape {
    const extension = this.get(shape.type);
    const serialized = {
      ...shape,
      data: extension.storage?.serializeData?.(shape.data) ?? { ...shape.data },
    };
    if (this.persistsSize(shape.type)) return serialized;
    const { width: _width, height: _height, ...frame } = shape.frame;
    return { ...serialized, frame } as CanvasSerializedShape;
  }

  rasters(shape: CanvasShape) {
    const render = this.get(shape.type).render;
    return render.surface === "dom+canvas" && (render.rasterize?.(shape) ?? true);
  }

  rendersInDom(shape: CanvasShape) {
    return this.get(shape.type).render.surface !== "canvas" && !this.rasters(shape);
  }

  paint(type: CanvasShapeType) {
    return this.get(type).render.paint;
  }

  zOrder(type: CanvasShapeType) {
    return this.get(type).behavior.zOrder ?? 0;
  }

  createRuntime(options: Omit<CanvasExtensionRuntimeOptions, "sizeFor">) {
    return createCanvasExtensionRuntime({
      ...options,
      sizeFor: (type) => this.get(type).defaults.size,
    });
  }
}

export function createCanvasExtensionManager(
  options: CanvasExtensionManagerOptions = {},
) {
  return new CanvasExtensionManager({
    elements: [...builtInElements, ...(options.elements ?? [])],
    tools: [...builtInTools, ...(options.tools ?? [])],
    inputs: {
      paste: [...builtInInputs.paste, ...(options.inputs?.paste ?? [])],
      drop: options.inputs?.drop,
    },
  });
}

// ---------------------------------------------------------------------------
// from extensions/services.ts
// ---------------------------------------------------------------------------

type CanvasExtensionRuntimeOptions = {
  spaceId: string;
  documentId?: string;
  currentOrigin: string;
  sizeFor: (type: CanvasShapeType) => CanvasSize;
  persistShape: (shape: CanvasShape) => void;
  insertNewShape: (shape: CanvasShape) => void;
  selectShape: (id: string) => void;
  selectShapes: (ids: string[]) => void;
  setActiveTool: (tool: CanvasToolId) => void;
  setBusy: (busy: boolean) => void;
  commitInsertion: () => void;
  canEdit: () => boolean;
  wasDragged: () => boolean;
  beginEdit: (session: CanvasEditSession) => void;
  reportError: (error: unknown) => void;
  // Server-backed data the app already has loaded. Passed in rather than read
  // from a query composable, so the canvas keeps no framework dependency.
  documents: () => DocumentPreviewSource[];
  spaces: () => ReadonlyArray<{ id: string; slug?: string | null }> | undefined;
  uploadFile: CanvasUploader;
  createCollaboration?: CanvasCollaborationFactory;
};

function createCanvasExtensionRuntime(options: CanvasExtensionRuntimeOptions) {
  const placeholders = createUploadPlaceholderStore({ sizeFor: options.sizeFor });
  const currentOrigin = options.currentOrigin;

  const documentController = createDocumentLinkController({
    documents: options.documents,
    currentOrigin,
    currentSpaceId: options.spaceId,
    fetchDocument: (ref) =>
      isRemoteDocumentAddress(ref.address, currentOrigin)
        ? fetchRemoteDocumentByAddress(ref)
        : api.document.get(ref.spaceId, ref.documentId),
    insertShape: options.persistShape,
    selectShape: options.selectShape,
    afterInsert: () => {
      options.setActiveTool("select");
      options.commitInsertion();
    },
  });

  const documentService: DocumentCanvasService = {
    ...documentController,
    canEdit: options.canEdit,
    isRemote: (shape) => isRemoteDocumentShape(shape, currentOrigin),
    address: documentAddressForShape,
  };
  const services = new Map<symbol, unknown>([[DOCUMENT_CANVAS_SERVICE, documentService]]);

  const host: CanvasExtensionHost = {
    spaceId: options.spaceId,
    wasDragged: options.wasDragged,
    beginEdit: options.beginEdit,
    createCollaboration: options.createCollaboration,
    openUrl: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    service: <T>(key: symbol) => {
      if (!services.has(key))
        throw new Error("Canvas extension service is not registered");
      return services.get(key) as T;
    },
  };

  const fileInsertion = createCanvasFileInsertionQueue({
    createMedia: (file, at) =>
      createUploadedMediaShape(file, at, {
        spaceId: options.spaceId,
        documentId: options.documentId,
        uploadFile: options.uploadFile,
      }),
    createFile: (file, at) =>
      createUploadedFileShape(file, at, {
        spaceId: options.spaceId,
        documentId: options.documentId,
        uploadFile: options.uploadFile,
      }),
    mediaType: mediaTypeForFile,
    addPlaceholder: placeholders.add,
    removePlaceholder: placeholders.remove,
    insert: options.persistShape,
    select: (id) => {
      options.selectShape(id);
      options.setActiveTool("select");
    },
    setBusy: options.setBusy,
    reportError: options.reportError,
  });

  const input = {
    splitFiles: splitCanvasFiles,
    addDroppedFiles: fileInsertion.addDropped,
    isDocumentUrl: (url: string) =>
      documentUrlPartsFromUrl(url, {
        currentOrigin,
        defaultSpaceId: options.spaceId,
      }) !== null,
    insertDocumentRef: (ref: DocumentLinkReference, at: CanvasPoint) =>
      documentController.insertDocumentLink(ref, at),
    insertDocumentUrl: (url: string, at: CanvasPoint) =>
      insertDocumentUrl(url, at, {
        currentOrigin,
        defaultSpaceId: options.spaceId,
        spaces: options.spaces(),
        loadSpaces: () => api.spaces.get(),
        fetchDocument: (ref) =>
          isRemoteDocumentAddress(ref.address, currentOrigin)
            ? fetchRemoteDocumentByAddress(ref)
            : api.document.get(ref.spaceId, ref.documentId),
        fetchMetadata: (value) => api.linkPreview.get(value).catch(() => null),
        insertDocument: (reference, point, document) =>
          documentController.insertDocumentLink(reference, point, document),
        insertLink: (value, point) =>
          options.insertNewShape(createLinkShape(value, point)),
        reportError: options.reportError,
      }),
    insertLink: (url: string, at: CanvasPoint) =>
      options.insertNewShape(createLinkShape(url, at)),
    insertImageUrl: (fetchUrl: string, originalUrl: string, at: CanvasPoint) =>
      imageFileFromUrl(fetchUrl, originalUrl)
        .then((file) => fileInsertion.addMedia(file, at))
        .catch(options.reportError),
    pasteFigma: (html: string, at: CanvasPoint) =>
      pasteFigmaIntoCanvas(html, at, {
        uploadMediaFile: (file) =>
          uploadMediaFile(file, {
            uploadFile: options.uploadFile,
            spaceId: options.spaceId,
            documentId: options.documentId,
          }),
        insertShape: options.persistShape,
        setBusy: options.setBusy,
        select: (ids) => {
          options.selectShapes(ids);
          options.setActiveTool("select");
        },
        reportError: options.reportError,
      }),
  };

  function command(name: string, payload?: unknown): unknown {
    const value = payload as Record<string, unknown> | undefined;
    switch (name) {
      case "is-document-url":
        return input.isDocumentUrl(String(payload ?? ""));
      case "insert-files":
        return input.addDroppedFiles(
          (value?.media as File[]) ?? [],
          (value?.files as File[]) ?? [],
          value?.at as CanvasPoint,
        );
      case "insert-document-url":
        return input.insertDocumentUrl(
          String(value?.url ?? ""),
          value?.at as CanvasPoint,
        );
      case "insert-document-ref":
        return input.insertDocumentRef(
          value?.reference as DocumentLinkReference,
          value?.at as CanvasPoint,
        );
      case "insert-image-url":
        return input.insertImageUrl(
          String(value?.fetchUrl ?? ""),
          String(value?.originalUrl ?? ""),
          value?.at as CanvasPoint,
        );
      case "insert-link":
        return input.insertLink(String(value?.url ?? ""), value?.at as CanvasPoint);
      case "paste-figma":
        return input.pasteFigma(String(value?.html ?? ""), value?.at as CanvasPoint);
      default:
        return undefined;
    }
  }

  return {
    host,
    input,
    command,
    uploadPlaceholders: placeholders.items,
  };
}
