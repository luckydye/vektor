import { api } from "#api/client.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { mediaTypeForFile } from "#utils/uploadFiles.ts";
import {
  createDocumentLinkController,
  DOCUMENT_CANVAS_SERVICE,
  documentAddressForShape,
  documentUrlPartsFromUrl,
  fetchRemoteDocumentByAddress,
  insertDocumentUrl,
  isRemoteDocumentAddress,
  isRemoteDocumentShape,
  type DocumentCanvasService,
  type DocumentLinkReference,
} from "./documentLink.ts";
import { pasteFigmaIntoCanvas } from "./figma.ts";
import { createUploadedFileShape } from "./files.ts";
import {
  createCanvasFileInsertionQueue,
  createUploadPlaceholderStore,
  splitCanvasFiles,
} from "./inputs.ts";
import { createLinkShape } from "./link.ts";
import {
  createUploadedMediaShape,
  imageFileFromUrl,
  uploadMediaFile,
} from "./media.ts";
import type {
  CanvasEditSession,
  CanvasExtensionHost,
  CanvasPoint,
  CanvasShape,
  CanvasShapeType,
  CanvasSize,
  CanvasTool,
} from "./types.ts";

export type CanvasExtensionRuntimeOptions = {
  spaceId: string;
  documentId?: string;
  currentOrigin: string;
  sizeFor: (type: CanvasShapeType) => CanvasSize;
  persistShape: (shape: CanvasShape) => void;
  insertNewShape: (shape: CanvasShape) => void;
  selectShape: (id: string) => void;
  selectShapes: (ids: string[]) => void;
  setActiveTool: (tool: CanvasTool) => void;
  setBusy: (busy: boolean) => void;
  commitInsertion: () => void;
  canEdit: () => boolean;
  wasDragged: () => boolean;
  beginEdit: (session: CanvasEditSession) => void;
  reportError: (error: unknown) => void;
};

export function createCanvasExtensionRuntime(options: CanvasExtensionRuntimeOptions) {
  const { documents } = useDocuments();
  const { spaces } = useSpace();
  const placeholders = createUploadPlaceholderStore({ sizeFor: options.sizeFor });
  const currentOrigin = options.currentOrigin;

  const documentController = createDocumentLinkController({
    documents,
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
  const services = new Map<symbol, unknown>([
    [DOCUMENT_CANVAS_SERVICE, documentService],
  ]);

  const host: CanvasExtensionHost = {
    spaceId: options.spaceId,
    wasDragged: options.wasDragged,
    beginEdit: options.beginEdit,
    openUrl: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    dispatch: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
    service: <T>(key: symbol) => {
      if (!services.has(key)) throw new Error("Canvas extension service is not registered");
      return services.get(key) as T;
    },
  };

  const fileInsertion = createCanvasFileInsertionQueue({
    createMedia: (file, at) =>
      createUploadedMediaShape(file, at, {
        spaceId: options.spaceId,
        documentId: options.documentId,
      }),
    createFile: (file, at) =>
      createUploadedFileShape(file, at, {
        spaceId: options.spaceId,
        documentId: options.documentId,
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
        spaces: spaces.value,
        loadSpaces: () => api.spaces.get(),
        fetchDocument: (ref) =>
          isRemoteDocumentAddress(ref.address, currentOrigin)
            ? fetchRemoteDocumentByAddress(ref)
            : api.document.get(ref.spaceId, ref.documentId),
        fetchMetadata: (value) => api.linkPreview.get(value).catch(() => null),
        insertDocument: (reference, point, document) =>
          documentController.insertDocumentLink(reference, point, document),
        insertLink: (value, point) => options.insertNewShape(createLinkShape(value, point)),
        reportError: options.reportError,
      }),
    insertLink: (url: string, at: CanvasPoint) =>
      options.insertNewShape(createLinkShape(url, at)),
    insertImageUrl: (fetchUrl: string, originalUrl: string, at: CanvasPoint) =>
      imageFileFromUrl(fetchUrl, originalUrl).then((file) =>
        fileInsertion.addMedia(file, at),
      ).catch(options.reportError),
    pasteFigma: (html: string, at: CanvasPoint) =>
      pasteFigmaIntoCanvas(html, at, {
        uploadMediaFile: (file) =>
          uploadMediaFile(file, {
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
        return input.insertDocumentUrl(String(value?.url ?? ""), value?.at as CanvasPoint);
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
