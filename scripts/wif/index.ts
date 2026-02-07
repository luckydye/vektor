#!/usr/bin/env bun

import { join, relative, dirname, basename, extname } from "node:path";
import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  WIFDocument,
  WIFMediaFile,
  WIFManifest,
  WIFFrontmatter,
  WIFExport,
} from "./types.ts";

export const WIF_VERSION = "1.0";

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

export function createSlugFromPath(filePath: string, baseDir: string): string {
  const relativePath = relative(baseDir, filePath);
  const withoutExtension = relativePath.replace(/\.[^/.]+$/, "");
  const decoded = decodeURIComponent(withoutExtension);

  return (
    decoded
      .replace(/^\/+|\/+$/g, "")
      .replace(/^(temp\/technik-webhome\/pages\/intern\/technik|intern\/Technik)\/?/i, "")
      .replace(/\/WebHome$/i, "")
      .replace(/\//g, "-")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "home"
  );
}

export function getDocumentPath(slug: string, parentSlug?: string): string {
  if (slug === "home") {
    return "documents/index.md";
  }

  // If we have a parent slug, nest under parent's directory
  if (parentSlug && parentSlug !== "home") {
    // Build path from parent slug
    const parentPath = parentSlug.replace(/-/g, "/");
    // Get the last part of current slug as filename
    const parts = slug.split("-");
    const docName = parts[parts.length - 1];
    return `documents/${parentPath}/${docName}.md`;
  }

  // No parent - this is a root level document
  return `documents/${slug}/index.md`;
}

export function getMediaPath(originalPath: string): string {
  const decoded = decodeURIComponent(originalPath);
  const sanitized = decoded.split("/").map(sanitizeFilename).join("/");

  return `media/${sanitized}`;
}

export function generateFrontmatter(doc: WIFDocument): string {
  const frontmatter: WIFFrontmatter = {
    wif_version: WIF_VERSION,
    slug: doc.slug,
    title: doc.title,
    properties: doc.properties,
  };

  if (doc.createdAt) {
    frontmatter.created_at = doc.createdAt;
  }

  if (doc.modifiedAt) {
    frontmatter.modified_at = doc.modifiedAt;
  }

  if (doc.author) {
    frontmatter.author = doc.author;
  }

  if (doc.parentSlug) {
    frontmatter.parent = doc.parentSlug;
  }

  if (doc.categorySlug) {
    frontmatter.category = doc.categorySlug;
  }

  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (key === "properties" && Object.keys(value).length === 0) {
        return `${key}:`;
      }

      if (key === "properties") {
        const props = Object.entries(value as Record<string, string>)
          .map(([k, v]) => `    ${k}: "${v}"`)
          .join("\n");
        return `${key}:\n${props}`;
      }

      if (Array.isArray(value)) {
        return `${key}:\n${value.map((v) => `  - "${v}"`).join("\n")}`;
      }

      return `${key}: "${value}"`;
    })
    .join("\n");

  return `---\n${yaml}\n---\n`;
}

export function calculateRelativePath(fromDocPath: string, toMediaPath: string): string {
  const fromDir = dirname(fromDocPath);
  const relativePath = relative(fromDir, toMediaPath);

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

export async function createWIFExport(
  exportName: string,
  sourceType: string,
  outputDir: string,
): Promise<WIFExport> {
  const now = new Date().toISOString();

  const manifest: WIFManifest = {
    wifVersion: WIF_VERSION,
    exportName,
    createdAt: now,
    source: {
      type: sourceType,
    },
    stats: {
      documents: 0,
      mediaFiles: 0,
      totalSizeBytes: 0,
    },
  };

  return {
    documents: [],
    mediaFiles: [],
    manifest,
  };
}

export async function writeWIFExport(
  wifExport: WIFExport,
  outputDir: string,
  documents: WIFDocument[],
  mediaMap: Map<string, string>,
): Promise<void> {
  const documentsDir = join(outputDir, "documents");
  const mediaDir = join(outputDir, "media");

  await mkdir(documentsDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  let totalSize = 0;

  for (const doc of documents) {
    const docPath = getDocumentPath(doc.slug);
    const fullPath = join(outputDir, docPath);

    await mkdir(dirname(fullPath), { recursive: true });

    const frontmatter = generateFrontmatter(doc);
    const content = `${frontmatter}\n\n${doc.content}`;

    await writeFile(fullPath, content, "utf-8");

    const stats = await stat(fullPath);
    totalSize += stats.size;
  }

  for (const [originalPath, sanitizedPath] of mediaMap) {
    const sourcePath = join(
      outputDir,
      "..",
      "temp",
      "Technik.WebHome",
      "attachment",
      originalPath,
    );
    const destPath = join(outputDir, sanitizedPath);

    if (existsSync(sourcePath)) {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(sourcePath, destPath);

      const stats = await stat(destPath);
      totalSize += stats.size;
    }
  }

  wifExport.manifest.stats.documents = documents.length;
  wifExport.manifest.stats.mediaFiles = mediaMap.size;
  wifExport.manifest.stats.totalSizeBytes = totalSize;

  const manifestPath = join(outputDir, "wif.json");
  await writeFile(manifestPath, JSON.stringify(wifExport.manifest, null, 2), "utf-8");
}

export type { WIFDocument, WIFMediaFile, WIFManifest, WIFFrontmatter, WIFExport };
