#!/usr/bin/env bun

import { readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { parseHTML } from "linkedom";
import { $ } from "bun";
import type { WIFDocument } from "./wif/types.ts";
import {
  WIF_VERSION,
  createSlugFromPath,
  getDocumentPath,
  getMediaPath,
  generateFrontmatter,
  calculateRelativePath,
} from "./wif/index.ts";

const DEFAULT_EXPORT_DIR = "./temp/Technik.WebHome/pages";
const DEFAULT_ATTACHMENT_DIR = "./temp/Technik.WebHome/attachment";

interface XWikiDocument {
  filePath: string;
  html: string;
  slug: string;
}

// Track slug mappings for link rewriting
const pathToSlugMap = new Map<string, string>();
const categories = new Set<string>();

async function findAllDocuments(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string) {
    if (!existsSync(currentDir)) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name === "WebHome.html") {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

function getHierarchyInfo(
  filePath: string,
  exportDir: string,
): {
  parentSlug?: string;
  level: number;
  categorySlug?: string;
} {
  const relativePath = relative(exportDir, filePath);
  const dirPath = dirname(relativePath);

  // Remove the file name to get just the directory path
  // e.g., "intern/Technik/Projekte/Modulbibliothek/WebHome.html" -> "intern/Technik/Projekte/Modulbibliothek"
  const pathParts = dirPath.split("/").filter((p) => p && p !== ".");

  if (pathParts.length === 0) {
    return { level: 0 };
  }

  // Remove the common prefix path (intern/Technik)
  const relevantParts = pathParts.slice(2); // Skip "intern" and "Technik"

  const level = relevantParts.length;

  if (level === 0) {
    return { level: 0 };
  }

  // The category is the first part after intern/Technik
  const categorySlug = relevantParts[0]
    ? relevantParts[0]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    : undefined;

  // Parent slug is all parts except the last one, joined with hyphens
  const parentSlug =
    relevantParts.length > 1
      ? relevantParts
          .slice(0, -1)
          .map((p) =>
            p
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, ""),
          )
          .join("-")
      : undefined;

  return { parentSlug, level, categorySlug };
}

function extractTitle(html: string, slug: string): string {
  const { document } = parseHTML(html);

  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription) {
    const content = metaDescription.getAttribute("content")?.trim();
    if (content) {
      return content;
    }
  }

  return slug
    .split("-")
    .pop()!
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractXWikiPathFromHref(href: string): string | null {
  const patterns = [/https?:\/\/[^/]+\/wiki\/(.+)/, /\/wiki\/(.+)/];

  for (const pattern of patterns) {
    const match = href.match(pattern);
    if (match) {
      return decodeURIComponent(match[1]).replace(/\/$/, "");
    }
  }

  return null;
}

function xwikiPathToSlug(xwikiPath: string): string | null {
  const cleanPath = xwikiPath
    .replace(/^intern\/Technik\//i, "")
    .replace(/\/WebHome$/i, "")
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return cleanPath || "home";
}

async function cleanXWikiHtml(
  html: string,
  htmlFilePath: string,
  attachmentDir: string,
  mediaMap: Map<string, string>,
): Promise<string> {
  const { document } = parseHTML(html);
  const content = document.querySelector("#xwikicontent");

  if (!content) {
    return "";
  }

  const docPath = getDocumentPath(createSlugFromPath(htmlFilePath, DEFAULT_EXPORT_DIR));

  const images = Array.from(content.querySelectorAll("img"));

  for (const img of images) {
    const src = img.getAttribute("src");
    if (!src) continue;

    if (
      src.startsWith("http://") ||
      src.startsWith("https://") ||
      src.startsWith("data:")
    ) {
      continue;
    }

    const pathParts = src.split("/");

    let levelsUp = 0;
    const cleanParts = [];
    for (const part of pathParts) {
      if (part === "..") {
        levelsUp++;
      } else if (part && part !== ".") {
        cleanParts.push(part);
      }
    }

    if (cleanParts[0] === "attachment") {
      const imagePath = cleanParts.slice(1).join("/");
      const sanitizedPath = getMediaPath(imagePath);

      if (!mediaMap.has(imagePath)) {
        mediaMap.set(imagePath, sanitizedPath);
      }

      const relativePath = calculateRelativePath(docPath, sanitizedPath);
      img.setAttribute("src", relativePath);
    }
  }

  const links = Array.from(content.querySelectorAll("a[href]"));
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;

    if (href.startsWith("http://") || href.startsWith("https://")) {
      const xwikiPath = extractXWikiPathFromHref(href);
      if (xwikiPath) {
        const targetSlug = xwikiPathToSlug(xwikiPath);
        if (targetSlug) {
          for (const [, slug] of pathToSlugMap) {
            if (slug === targetSlug || slug.endsWith(`-${targetSlug}`)) {
              const targetPath = getDocumentPath(targetSlug);
              const relativePath = calculateRelativePath(docPath, targetPath);
              link.setAttribute("href", relativePath.replace(/\.md$/, ""));
              break;
            }
          }
        }
      }
    } else if (href.startsWith("/")) {
      const xwikiPath = extractXWikiPathFromHref(href);
      if (xwikiPath) {
        const targetSlug = xwikiPathToSlug(xwikiPath);
        if (targetSlug) {
          const targetPath = getDocumentPath(targetSlug);
          const relativePath = calculateRelativePath(docPath, targetPath);
          link.setAttribute("href", relativePath.replace(/\.md$/, ""));
        }
      }
    }
  }

  content.querySelectorAll(".xtree").forEach((el) => el.remove());

  content.querySelectorAll("[class]").forEach((el) => {
    const element = el as Element;
    const classes = Array.from(element.classList);
    const cleanClasses = classes.filter(
      (cls) =>
        !cls.startsWith("wiki") && !cls.startsWith("xwiki") && cls !== "content-wrapper",
    );

    if (cleanClasses.length > 0) {
      element.setAttribute("class", cleanClasses.join(" "));
    } else {
      element.removeAttribute("class");
    }
  });

  content.querySelectorAll("a.xwiki-mention, a[data-reference]").forEach((mention) => {
    const username = mention.textContent?.trim();
    const dataReference = mention.getAttribute("data-reference");

    if (username && dataReference) {
      const emailMatch = dataReference.match(/(?:xwiki:|intern:)XWiki\.(.+)/);
      if (emailMatch) {
        const email = emailMatch[1].replace(/\\/g, "").replace(/_/g, ".");

        const userMention = document.createElement("user-mention");
        userMention.setAttribute("email", email);
        userMention.textContent = username;
        mention.replaceWith(userMention);
      }
    }
  });

  content.querySelectorAll("div.box > div.code, div.code").forEach((codeBlock) => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");

    let codeText = codeBlock.innerHTML
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/<span[^>]*>/g, "")
      .replace(/<\/span>/g, "");

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = codeText;
    codeText = tempDiv.textContent || "";

    code.textContent = codeText;
    pre.appendChild(code);

    const boxDiv = codeBlock.parentElement;
    if (boxDiv?.classList.contains("box")) {
      boxDiv.replaceWith(pre);
    } else {
      codeBlock.replaceWith(pre);
    }
  });

  content.querySelectorAll("span.xwiki-date, span[class*='date']").forEach((dateSpan) => {
    const date = dateSpan.textContent?.trim();
    if (date) {
      const textNode = document.createTextNode(date);
      dateSpan.replaceWith(textNode);
    }
  });

  content.querySelectorAll("table").forEach((table) => {
    table.querySelectorAll("td > div, th > div").forEach((div) => {
      const parent = div.parentElement;
      if (parent && div.classList.contains("content-wrapper")) {
        while (div.firstChild) {
          parent.insertBefore(div.firstChild, div);
        }
        div.remove();
      }
    });
  });

  content.querySelectorAll("p, div").forEach((el) => {
    if (!el.textContent?.trim() && !el.querySelector("img, table, pre, code")) {
      el.remove();
    }
  });

  return content.innerHTML.trim();
}

function isDocumentEmpty(content: string): boolean {
  const trimmed = content.trim();

  if (!trimmed) {
    return true;
  }

  if (trimmed.replace(/&nbsp;/g, "").trim().length === 0) {
    return true;
  }

  if (/^(<p>\s*<\/p>\s*)+$/.test(trimmed)) {
    return true;
  }

  return false;
}

async function convertXWikiToWIF(
  exportDir: string,
  attachmentDir: string,
  outputDir: string,
): Promise<void> {
  console.log("XWiki to WIF Converter");
  console.log("======================\n");

  if (!existsSync(exportDir)) {
    throw new Error(`Export directory not found: ${exportDir}`);
  }

  console.log("Finding documents...");
  const htmlFiles = await findAllDocuments(exportDir);
  console.log(`Found ${htmlFiles.length} HTML files\n`);

  // First pass: collect all path-to-slug mappings
  for (const filePath of htmlFiles) {
    const relativePath = relative(exportDir, filePath).replace(/\/WebHome\.html$/, "");
    const slug = createSlugFromPath(filePath, exportDir);
    pathToSlugMap.set(relativePath, slug);
  }

  const documents: WIFDocument[] = [];
  const mediaMap = new Map<string, string>();

  for (const filePath of htmlFiles) {
    const html = await Bun.file(filePath).text();
    const slug = createSlugFromPath(filePath, exportDir);
    const content = await cleanXWikiHtml(html, filePath, attachmentDir, mediaMap);

    const hierarchyInfo = getHierarchyInfo(filePath, exportDir);
    const title = extractTitle(html, slug);

    // First-level documents ARE categories
    if (hierarchyInfo.level === 1 && hierarchyInfo.categorySlug) {
      categories.add(hierarchyInfo.categorySlug);
    }

    const isEmpty = isDocumentEmpty(content);
    if (isEmpty) {
      console.log(`- Empty document (will create for hierarchy): ${slug}`);
    }

    // Build properties without isEmpty
    const properties: Record<string, string> = {
      title,
      source: "xwiki-import",
    };

    // If this is a first-level doc, mark it as a category
    if (hierarchyInfo.level === 1) {
      properties.type = "category";
    }

    documents.push({
      slug,
      title,
      content: isEmpty ? "" : content,
      parentSlug: hierarchyInfo.parentSlug,
      path: filePath,
      level: hierarchyInfo.level,
      categorySlug: hierarchyInfo.categorySlug,
      properties,
    });
  }

  documents.sort((a, b) => a.level - b.level);

  console.log(`\nPrepared ${documents.length} documents for export`);
  console.log(`Found ${categories.size} categories (first-level documents)`);
  console.log(`Found ${mediaMap.size} media files\n`);

  console.log("Creating WIF export...");

  await mkdir(outputDir, { recursive: true });

  const documentsDir = join(outputDir, "documents");
  const mediaDir = join(outputDir, "media");

  await mkdir(documentsDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  let totalSize = 0;

  // Create document files preserving original directory structure
  for (const doc of documents) {
    // Convert the original HTML path to MD path, preserving directory structure
    const relativeHtmlPath = relative(exportDir, doc.path);
    const relativeMdPath = relativeHtmlPath
      .replace(/\.html$/i, ".md")
      .replace(/WebHome\.md$/i, "index.md");
    const docPath = join("documents", relativeMdPath);
    const fullPath = join(outputDir, docPath);

    await mkdir(dirname(fullPath), { recursive: true });

    const frontmatter = generateFrontmatter(doc);
    const fileContent = `${frontmatter}\n\n${doc.content}`;

    await writeFile(fullPath, fileContent, "utf-8");

    const fileStat = await Bun.file(fullPath).stat();
    totalSize += fileStat.size;

    const isCategory = doc.level === 1;
    console.log(
      `  ✓ Created: ${docPath}${isCategory ? " [CATEGORY]" : ""}${doc.parentSlug ? ` (parent: ${doc.parentSlug})` : ""}`,
    );
  }

  console.log("\nCopying media files...");

  for (const [originalPath, sanitizedPath] of mediaMap) {
    const sourcePath = join(attachmentDir, originalPath);
    const destPath = join(outputDir, sanitizedPath);

    if (existsSync(sourcePath)) {
      await mkdir(dirname(destPath), { recursive: true });

      const sourceFile = Bun.file(sourcePath);
      await Bun.write(destPath, sourceFile);

      const fileStat = await Bun.file(destPath).stat();
      totalSize += fileStat.size;

      console.log(`  ✓ Copied: ${sanitizedPath}`);
    } else {
      console.log(`  ⚠ Not found: ${originalPath}`);
    }
  }

  const manifest = {
    wifVersion: WIF_VERSION,
    exportName: "technik-wiki",
    createdAt: new Date().toISOString(),
    source: {
      type: "xwiki",
    },
    stats: {
      documents: documents.length,
      categories: categories.size,
      mediaFiles: mediaMap.size,
      totalSizeBytes: totalSize,
    },
  };

  const manifestPath = join(outputDir, "wif.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`\n✓ WIF export created: ${outputDir}`);
  console.log(`\nSummary:`);
  console.log(`  Documents: ${documents.length}`);
  console.log(`  Categories: ${categories.size} (first-level documents)`);
  console.log(`  Media files: ${mediaMap.size}`);
  console.log(`  Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\nTo create a zip file, run:`);
  console.log(`  cd ${outputDir} && zip -r ../technik-wiki.wif.zip .`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun scripts/convert-xwiki-to-wif.ts [options]");
    console.log("\nOptions:");
    console.log(
      "  --export-dir=<path>     Path to XWiki HTML export (default: ./temp/Technik.WebHome/pages)",
    );
    console.log(
      "  --attachment-dir=<path> Path to XWiki attachments (default: ./temp/Technik.WebHome/attachment)",
    );
    console.log(
      "  --output-dir=<path>     Output directory (default: ./output/technik-wiki)",
    );
    console.log("  --zip                   Create zip file automatically");
    console.log("  --help, -h              Show this help message");
    console.log("\nExamples:");
    console.log("  bun scripts/convert-xwiki-to-wif.ts");
    console.log(
      "  bun scripts/convert-xwiki-to-wif.ts --export-dir=./my-export/pages --output-dir=./my-wiki",
    );
    console.log("  bun scripts/convert-xwiki-to-wif.ts --zip");
    process.exit(0);
  }

  const exportDirArg = args.find((arg) => arg.startsWith("--export-dir="))?.split("=")[1];
  const attachmentDirArg = args
    .find((arg) => arg.startsWith("--attachment-dir="))
    ?.split("=")[1];
  const outputDirArg = args.find((arg) => arg.startsWith("--output-dir="))?.split("=")[1];
  const zipFlag = args.includes("--zip");

  const exportDir = exportDirArg || DEFAULT_EXPORT_DIR;
  const attachmentDir = attachmentDirArg || DEFAULT_ATTACHMENT_DIR;
  const outputDir = outputDirArg || "./output/technik-wiki";

  await convertXWikiToWIF(exportDir, attachmentDir, outputDir);

  if (zipFlag) {
    console.log("\nCreating zip file...");
    const zipPath = `${outputDir}.wif.zip`;

    await $`cd ${outputDir} && zip -r ${zipPath} .`;

    console.log(`✓ Created zip: ${zipPath}`);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
