import type { APIRoute } from "astro";
import { writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  isSafeUploadIdPart,
  isWithinUploadsRoot,
} from "../../../../../../utils/uploads.ts";
import { authenticateJobTokenOrSpaceRole } from "../../../_auth.ts";

const ALLOWED_TYPES = [
  // Images
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.ms-excel", // .xls
  "application/msword", // .doc
  "text/markdown", // .md
  "text/plain", // .txt (fallback for .md)
  "text/csv", // .csv
  "application/pdf", // .pdf
  "application/zip", // .zip
  "application/x-zip-compressed", // .zip (alternative)
];

const ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "docx",
  "doc",
  "pdf",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "csv",
  "zip",
  "md",
  "txt",
  "json",
];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB for documents

export const GET: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const user = requireUser(context);
      await verifySpaceRole(spaceId, user.id, "viewer");

      const uploadsDir = join(process.cwd(), "data", "uploads", spaceId);

      let entries: Awaited<ReturnType<typeof readdir>>;
      try {
        entries = await readdir(uploadsDir, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResponse({ files: [] }, 200);
        }
        throw error;
      }

      const files = (
        await Promise.all(
          entries.map(async (entry) => {
            const fullPath = join(uploadsDir, entry);
            const fileStat = await stat(fullPath);
            if (!fileStat.isFile()) return null;
            const key = (entry as string).replace(/\\/g, "/");
            const url = `/api/v1/spaces/${spaceId}/uploads/${key}`;
            return { key, url, size: fileStat.size, updatedAt: fileStat.mtime };
          }),
        )
      ).filter(Boolean);

      return jsonResponse({ files }, 200);
    },
    {
      fallbackMessage: "Failed to list uploads",
      onError: (error) => {
        console.error("List uploads error:", error);
        return errorResponse("Failed to list uploads", 500);
      },
    },
  );

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");
      const isJobAuth = auth.type === "job";

      // Parse the form data
      const formData = await context.request.formData();
      const file = formData.get("file") as Blob | null;
      const originalName =
        (formData.get("filename") as string | null) ??
        (file instanceof File ? file.name : null) ??
        "upload";
      const documentId = formData.get("documentId") as string | null;

      if (!file) {
        return badRequestResponse("No file provided");
      }

      if (documentId !== null && !isSafeUploadIdPart(documentId)) {
        return badRequestResponse("Invalid documentId");
      }

      // Job uploads (authenticated via X-Job-Token) are trusted server-side code;
      // skip the type allowlist. User uploads are validated as before.
      if (!isJobAuth) {
        const extension = originalName.split(".").pop()?.toLowerCase() || "";
        const isAllowedExtension = ALLOWED_EXTENSIONS.includes(extension);
        const isAllowedMime = ALLOWED_TYPES.includes(file.type);

        if (!isAllowedExtension && !isAllowedMime) {
          return badRequestResponse(
            `Invalid file type. Allowed extensions: ${ALLOWED_EXTENSIONS.join(", ")}`,
          );
        }
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        return badRequestResponse(
          `File size exceeds maximum allowed size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        );
      }

      // Generate unique filename
      const fileExtension = originalName.split(".").pop()?.toLowerCase() || "bin";
      const randomName = randomBytes(16).toString("hex");
      const filename = `${randomName}.${fileExtension}`;

      // Build the storage key - includes documentId if provided
      // This structure is S3-compatible: {spaceId}/{documentId}/{filename} or {spaceId}/{filename}
      const key = documentId ? `${documentId}/${filename}` : filename;

      // Create uploads directory (with document subdirectory if applicable)
      const uploadsDir = documentId
        ? join(process.cwd(), "data", "uploads", spaceId, documentId)
        : join(process.cwd(), "data", "uploads", spaceId);
      if (!isWithinUploadsRoot(spaceId, uploadsDir)) {
        throw badRequestResponse("Invalid upload path");
      }
      await mkdir(uploadsDir, { recursive: true });

      // Save file
      const filePath = join(uploadsDir, filename);
      if (!isWithinUploadsRoot(spaceId, filePath)) {
        throw badRequestResponse("Invalid upload path");
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);

      // Return a relative path — consumers prepend their own base URL.
      // This avoids jobs fetching via the public domain (which may 403).
      const url = `/api/v1/spaces/${spaceId}/uploads/${key}`;

      return jsonResponse({ url, key }, 200);
    },
    {
      fallbackMessage: "Failed to upload file",
      onError: (error) => {
        console.error("Upload file error:", error);
        return errorResponse("Failed to upload file", 500);
      },
    },
  );
