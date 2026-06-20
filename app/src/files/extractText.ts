import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
]);

const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml"]);

function extension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function stripXmlTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract plain text from a DOCX file buffer via fflate. */
function extractDocxText(buffer: Buffer): string {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    const xmlBytes = files["word/document.xml"];
    if (!xmlBytes) return "";
    const xml = new TextDecoder().decode(xmlBytes);
    // Preserve paragraph breaks, then strip tags
    const withBreaks = xml.replace(/<w:p[ >]/g, "\n<w:p ").replace(/<w:p\/>/g, "\n");
    return stripXmlTags(withBreaks);
  } catch {
    return "";
  }
}

function extractXlsxText(buffer: Buffer): string {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    // Shared strings table contains the actual cell text
    const sharedBytes = files["xl/sharedStrings.xml"];
    if (!sharedBytes) return "";
    const xml = new TextDecoder().decode(sharedBytes);
    return stripXmlTags(xml);
  } catch {
    return "";
  }
}

function extractPptxText(buffer: Buffer): string {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    const slideTexts: string[] = [];
    for (const [path, bytes] of Object.entries(files)) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) {
        slideTexts.push(stripXmlTags(new TextDecoder().decode(bytes)));
      }
    }
    return slideTexts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Extract searchable text from a file buffer.
 * Returns null for file types where extraction is not supported (images, video, etc.).
 */
export function extractFileTextFromBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string | undefined,
): string | null {
  const ext = extension(originalName);

  if (TEXT_MIME_TYPES.has(mimeType ?? "") || TEXT_EXTENSIONS.has(ext)) {
    return new TextDecoder().decode(buffer).slice(0, 512_000);
  }

  const isDocx =
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx";
  if (isDocx) return extractDocxText(buffer).slice(0, 512_000);

  const isXlsx =
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === "xlsx";
  if (isXlsx) return extractXlsxText(buffer).slice(0, 512_000);

  const isPptx =
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    ext === "pptx";
  if (isPptx) return extractPptxText(buffer).slice(0, 512_000);

  return null;
}

/**
 * Extract searchable text from a file on disk.
 * Returns null for file types where extraction is not supported (images, video, etc.).
 */
export async function extractFileText(
  filePath: string,
  originalName: string,
  mimeType: string | undefined,
): Promise<string | null> {
  const buf = await readFile(filePath).catch(() => null);
  if (!buf) return null;
  return extractFileTextFromBuffer(buf, originalName, mimeType);
}
