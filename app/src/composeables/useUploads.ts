import { ref } from "vue";
import { api } from "#api/client.ts";
import { t } from "#utils/lang.ts";
import { useToast } from "./useToast.ts";

// Generic upload manager. It owns the shared upload feedback — a progress
// toast (reusing useToast), success/error notifications, and a reactive
// registry of in-flight uploads — so every call site (canvas, editor,
// header image, AI chat) reports uploads the same way. Each surface keeps
// its own placeholder/busy UI and just calls uploadFile/uploadFiles.

export type UploadStatus = "uploading" | "done" | "error";

export interface UploadResult {
  url: string;
  key?: string;
  [key: string]: unknown;
}

export interface ActiveUpload {
  id: string;
  filename: string;
  /** Upload progress in the 0..1 range. */
  progress: number;
  status: UploadStatus;
}

export interface UploadOptions {
  spaceId: string;
  documentId?: string;
  /** Label shown in the toast; defaults to the file name. */
  label?: string;
  /** Show the progress + success toast. Default true. */
  progressToast?: boolean;
  /** Show an error toast when the upload fails. Default true. */
  errorToast?: boolean;
  /** Receives upload progress in the 0..1 range. */
  onProgress?: (progress: number) => void;
}

// Module-level so all callers share one registry, like useToast.
const activeUploads = ref<ActiveUpload[]>([]);
let nextUploadId = 0;

export function useUploads() {
  const toast = useToast();

  function track(filename: string): ActiveUpload {
    const entry: ActiveUpload = {
      id: `upload-${++nextUploadId}`,
      filename,
      progress: 0,
      status: "uploading",
    };
    activeUploads.value = [...activeUploads.value, entry];
    return entry;
  }

  function patchUpload(id: string, patch: Partial<ActiveUpload>) {
    activeUploads.value = activeUploads.value.map((upload) =>
      upload.id === id ? { ...upload, ...patch } : upload,
    );
  }

  function untrack(id: string) {
    activeUploads.value = activeUploads.value.filter((upload) => upload.id !== id);
  }

  function notifyError(toastId: number | null, showError: boolean, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!showError) {
      if (toastId != null) toast.remove(toastId);
      return;
    }
    const text = `${t("Upload failed")}: ${message}`;
    if (toastId != null) {
      toast.update(
        toastId,
        { message: text, type: "error", progress: 1 },
        { duration: 5000 },
      );
    } else {
      toast.error(text);
    }
  }

  /** Upload a single file, reporting progress through the shared toast. */
  async function uploadFile(file: File, options: UploadOptions): Promise<UploadResult> {
    const label = options.label ?? file.name ?? "file";
    const showProgress = options.progressToast !== false;
    const showError = options.errorToast !== false;
    const entry = track(label);
    const toastId = showProgress
      ? toast.show(`${t("Uploading")} ${label}`, "info", 0, { progress: 0 })
      : null;

    try {
      const result = (await api.uploads.post(
        options.spaceId,
        file,
        file.name || label,
        options.documentId,
        {
          onProgress: (progress) => {
            patchUpload(entry.id, { progress });
            if (toastId != null) toast.update(toastId, { progress });
            options.onProgress?.(progress);
          },
        },
      )) as UploadResult;

      patchUpload(entry.id, { progress: 1, status: "done" });
      if (toastId != null) {
        toast.update(
          toastId,
          { message: t("Upload complete"), type: "success", progress: 1 },
          { duration: 2000 },
        );
      }
      return result;
    } catch (error) {
      patchUpload(entry.id, { status: "error" });
      notifyError(toastId, showError, error);
      throw error;
    } finally {
      untrack(entry.id);
    }
  }

  /**
   * Upload several files at once. A single aggregated progress toast is shown
   * for the batch. Results are returned in the same order as the input files.
   */
  async function uploadFiles(
    files: File[],
    options: UploadOptions,
  ): Promise<UploadResult[]> {
    if (files.length === 0) return [];
    if (files.length === 1) return [await uploadFile(files[0], options)];

    const showProgress = options.progressToast !== false;
    const showError = options.errorToast !== false;
    const label = options.label ?? `${files.length} ${t("files")}`;
    const toastId = showProgress
      ? toast.show(`${t("Uploading")} ${label}`, "info", 0, { progress: 0 })
      : null;

    const progresses = new Array(files.length).fill(0);
    const entries = files.map((file) => track(file.name || "file"));

    const reportAggregate = () => {
      const total = progresses.reduce((sum, value) => sum + value, 0) / files.length;
      if (toastId != null) toast.update(toastId, { progress: total });
      options.onProgress?.(total);
    };

    try {
      const results = await Promise.all(
        files.map(
          (file, index) =>
            api.uploads.post(
              options.spaceId,
              file,
              file.name || "file",
              options.documentId,
              {
                onProgress: (progress) => {
                  progresses[index] = progress;
                  patchUpload(entries[index].id, { progress });
                  reportAggregate();
                },
              },
            ) as Promise<UploadResult>,
        ),
      );

      for (const entry of entries) {
        patchUpload(entry.id, { progress: 1, status: "done" });
      }
      if (toastId != null) {
        toast.update(
          toastId,
          { message: t("Upload complete"), type: "success", progress: 1 },
          { duration: 2000 },
        );
      }
      return results;
    } catch (error) {
      for (const entry of entries) {
        patchUpload(entry.id, { status: "error" });
      }
      notifyError(toastId, showError, error);
      throw error;
    } finally {
      for (const entry of entries) {
        untrack(entry.id);
      }
    }
  }

  return { uploadFile, uploadFiles, activeUploads };
}
