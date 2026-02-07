import type { APIRoute } from "astro";
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join, extname, dirname, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  badRequestResponse,
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
} from "../../../../../db/api.ts";
import { createDocument, setDocumentParent } from "../../../../../db/documents.ts";
import { createCategory, getCategoryBySlug } from "../../../../../db/categories.ts";
import { getSpaceDb } from "../../../../../db/db.ts";
import { document } from "../../../../../db/schema/space.ts";

const execAsync = promisify(exec);

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
const TEMP_DIR = join(process.cwd(), "data", "temp");

interface WIFManifest {
  wifVersion: string;
  exportName: string;
  createdAt: string;
  source: {
    type: string;
    version?: string;
    url?: string;
  };
}

interface WIFFrontmatter {
  wif_version: string;
  slug: string;
  title: string;
  created_at?: string;
  modified_at?: string;
  author?: string;
  parent?: string;
  order?: number;
  tags?: string[];
  category?: string;
  properties: Record<string, string>;
}

interface WIFDocument {
  filePath: string;
  relativePath: string;
  frontmatter: WIFFrontmatter;
  content: string;
  level: number;
}

interface ImportResult {
  totalFiles: number;
  imported: number;
  skipped: number;
  failed: number;
  documents: Array<{ slug: string; title: string; id: string }>;
  categories: Array<{ slug: string; name: string }>;
  errors: Array<{ file: string; error: string }>;
}

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true });
}

async function extractZipFile(zipPath: string, extractDir: string): Promise<void> {
  await mkdir(extractDir, { recursive: true });
  await execAsync(`unzip -o -q "${zipPath}" -d "${extractDir}"`);
}

async function parseWIFManifest(extractDir: string): Promise<WIFManifest | null> {
  try {
    const manifestPath = join(extractDir, "wif.json");
    const content = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(content) as WIFManifest;

    if (!manifest.wifVersion || !manifest.exportName) {
      return null;
    }

    return manifest;
  } catch {
    return null;
  }
}

function parseFrontmatter(content: string): {
  frontmatter: WIFFrontmatter | null;
  body: string;
} {
  const lines = content.split("\n");

  if (lines[0] !== "---") {
    return { frontmatter: null, body: content };
  }

  let i = 1;
  const frontmatterLines: string[] = [];

  while (i < lines.length && lines[i] !== "---") {
    frontmatterLines.push(lines[i]);
    i++;
  }

  if (i >= lines.length) {
    return { frontmatter: null, body: content };
  }

  const body = lines
    .slice(i + 1)
    .join("\n")
    .trim();

  try {
    const frontmatter: WIFFrontmatter = {
      wif_version: "",
      slug: "",
      title: "",
      properties: {},
    };

    let inProperties = false;

    for (const line of frontmatterLines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      if (trimmed === "properties:") {
        inProperties = true;
        continue;
      }

      if (inProperties && trimmed.startsWith("- ")) {
        continue;
      }

      if (inProperties && !trimmed.includes(":")) {
        inProperties = false;
      }

      const colonIndex = trimmed.indexOf(":");
      if (colonIndex > 0) {
        const key = trimmed.substring(0, colonIndex).trim();
        let value = trimmed.substring(colonIndex + 1).trim();

        value = value.replace(/^["']|["']$/g, "");

        if (inProperties && key) {
          frontmatter.properties[key] = value;
        } else {
          switch (key) {
            case "wif_version":
              frontmatter.wif_version = value;
              break;
            case "slug":
              frontmatter.slug = value;
              break;
            case "title":
              frontmatter.title = value;
              break;
            case "created_at":
              frontmatter.created_at = value;
              break;
            case "modified_at":
              frontmatter.modified_at = value;
              break;
            case "author":
              frontmatter.author = value;
              break;
            case "parent":
              frontmatter.parent = value;
              break;
            case "order":
              frontmatter.order = parseInt(value, 10) || 0;
              break;
            case "category":
              frontmatter.category = value;
              break;
          }
        }
      }
    }

    return { frontmatter, body };
  } catch {
    return { frontmatter: null, body: content };
  }
}

async function scanWIFDocuments(extractDir: string): Promise<WIFDocument[]> {
  const documentsDir = join(extractDir, "documents");
  const documents: WIFDocument[] = [];

  if (
    !(await readdir(documentsDir)
      .then(() => true)
      .catch(() => false))
  ) {
    return documents;
  }

  async function scanDir(dir: string, level: number) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(documentsDir, fullPath);

      if (entry.name.startsWith(".")) {
        continue;
      }

      if (entry.isDirectory()) {
        await scanDir(fullPath, level + 1);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        const content = await readFile(fullPath, "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);

        if (frontmatter) {
          documents.push({
            filePath: fullPath,
            relativePath,
            frontmatter,
            content: body,
            level,
          });
        }
      }
    }
  }

  await scanDir(documentsDir, 0);

  // Sort: index files first, then by order, then alphabetically
  documents.sort((a, b) => {
    if (a.level !== b.level) {
      return a.level - b.level;
    }
    const aIsIndex = a.relativePath.endsWith("/index.md");
    const bIsIndex = b.relativePath.endsWith("/index.md");
    if (aIsIndex && !bIsIndex) return -1;
    if (!aIsIndex && bIsIndex) return 1;
    const orderDiff = (a.frontmatter.order || 0) - (b.frontmatter.order || 0);
    if (orderDiff !== 0) return orderDiff;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return documents;
}

async function scanWIFMedia(extractDir: string): Promise<Map<string, string>> {
  const mediaDir = join(extractDir, "media");
  const mediaMap = new Map<string, string>();

  if (
    !(await readdir(mediaDir)
      .then(() => true)
      .catch(() => false))
  ) {
    return mediaMap;
  }

  async function scanDir(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(mediaDir, fullPath);

      if (entry.name.startsWith(".")) {
        continue;
      }

      if (entry.isDirectory()) {
        await scanDir(fullPath);
      } else if (entry.isFile()) {
        mediaMap.set(relativePath, fullPath);
      }
    }
  }

  await scanDir(mediaDir);
  return mediaMap;
}

async function copyMediaToUploads(
  spaceId: string,
  mediaMap: Map<string, string>,
): Promise<Map<string, string>> {
  const uploadedMap = new Map<string, string>();
  const uploadsDir = join(process.cwd(), "data", "uploads", spaceId);

  await mkdir(uploadsDir, { recursive: true });

  for (const [relativePath, sourcePath] of mediaMap) {
    try {
      const ext = extname(relativePath);
      const fileName = `${randomBytes(16).toString("hex")}${ext}`;
      const destPath = join(uploadsDir, fileName);

      await copyFile(sourcePath, destPath);

      const uploadUrl = `/api/v1/spaces/${spaceId}/uploads/${fileName}`;
      uploadedMap.set(relativePath, uploadUrl);
    } catch (error) {
      console.error(`Failed to copy media file ${relativePath}:`, error);
    }
  }

  return uploadedMap;
}

function updateImageReferences(content: string, mediaMap: Map<string, string>): string {
  let updatedContent = content;

  // Markdown image syntax
  const markdownImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  updatedContent = updatedContent.replace(markdownImgRegex, (match, alt, path) => {
    const mediaMatch = path.match(/\.\.\/media\/(.+)/);
    if (mediaMatch) {
      const mediaPath = mediaMatch[1];
      const uploadedUrl = mediaMap.get(mediaPath);
      if (uploadedUrl) {
        return `![${alt}](${uploadedUrl})`;
      }
    }
    return match;
  });

  // HTML img tag syntax
  const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  updatedContent = updatedContent.replace(htmlImgRegex, (match, path) => {
    const mediaMatch = path.match(/\.\.\/media\/(.+)/);
    if (mediaMatch) {
      const mediaPath = mediaMatch[1];
      const uploadedUrl = mediaMap.get(mediaPath);
      if (uploadedUrl) {
        return match.replace(path, uploadedUrl);
      }
    }
    return match;
  });

  return updatedContent;
}

export const POST: APIRoute = async (context) => {
  let tempDir: string | null = null;

  try {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "editor");

    const formData = await context.request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      throw badRequestResponse("No file provided");
    }

    const ext = extname(file.name).toLowerCase();
    if (ext !== ".zip") {
      throw badRequestResponse("Only WIF (.zip) files are supported");
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      throw badRequestResponse(
        `File size exceeds maximum allowed size of ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
      );
    }

    await ensureTempDir();
    tempDir = join(TEMP_DIR, `import-${randomBytes(16).toString("hex")}`);
    await mkdir(tempDir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    const tempFilePath = join(tempDir, file.name);
    await writeFile(tempFilePath, buffer);

    // Extract ZIP file
    const extractDir = join(tempDir, "extracted");
    await extractZipFile(tempFilePath, extractDir);

    // Validate WIF format
    const manifest = await parseWIFManifest(extractDir);
    if (!manifest) {
      throw badRequestResponse(
        "Invalid WIF format: wif.json manifest not found or invalid",
      );
    }

    // STEP 1: Scan all documents
    const documents = await scanWIFDocuments(extractDir);
    const mediaFiles = await scanWIFMedia(extractDir);

    if (documents.length === 0) {
      throw badRequestResponse("No valid documents found in WIF export");
    }

    // STEP 2: Get existing slugs to avoid collisions
    const db = getSpaceDb(spaceId);
    const allDocs = await db.select({ slug: document.slug }).from(document).all();
    const existingSlugs = new Set(allDocs.map((d) => d.slug));

    const result: ImportResult = {
      totalFiles: documents.length + mediaFiles.size,
      imported: 0,
      skipped: 0,
      failed: 0,
      documents: [],
      categories: [],
      errors: [],
    };

    // STEP 3: Pre-process - collect all document info and category slugs
    const docInfo: Array<{
      originalSlug: string;
      finalSlug: string;
      title: string;
      isCategory: boolean;
      categorySlug?: string;
      parentSlug?: string;
      frontmatter: WIFFrontmatter;
      content: string;
      relativePath: string;
    }> = [];

    const categorySlugs = new Set<string>();
    const slugModifications = new Map<string, string>(); // original -> final

    // First pass: determine all slugs and identify categories
    for (const doc of documents) {
      const { frontmatter } = doc;
      const originalSlug = frontmatter.slug;
      let finalSlug = originalSlug;

      // Handle slug collisions
      if (!finalSlug || existingSlugs.has(finalSlug)) {
        let baseSlug = frontmatter.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .substring(0, 100);

        if (!baseSlug) baseSlug = "document";

        finalSlug = baseSlug;
        let counter = 1;
        while (existingSlugs.has(finalSlug) || slugModifications.has(finalSlug)) {
          finalSlug = `${baseSlug}-${counter}`;
          counter++;
        }
      }

      // Track slug modification
      if (originalSlug && originalSlug !== finalSlug) {
        slugModifications.set(originalSlug, finalSlug);
      }

      // Check if this is a category
      const isCategory = frontmatter.properties?.type === "category";
      if (isCategory) {
        categorySlugs.add(finalSlug);
      }

      // Get parent from either top-level or properties section
      const parentSlug = frontmatter.parent || frontmatter.properties?.parent;

      docInfo.push({
        originalSlug,
        finalSlug,
        title: frontmatter.title,
        isCategory,
        categorySlug: frontmatter.category,
        parentSlug,
        frontmatter,
        content: doc.content,
        relativePath: doc.relativePath,
      });
    }

    // STEP 4: Create categories
    for (const slug of categorySlugs) {
      const doc = docInfo.find((d) => d.finalSlug === slug);
      if (doc) {
        const existing = await getCategoryBySlug(spaceId, slug);
        if (!existing) {
          await createCategory(spaceId, doc.title, slug);
          result.categories.push({ slug, name: doc.title });
        }
      }
    }

    // STEP 5: Upload media files
    const uploadedMediaMap = await copyMediaToUploads(spaceId, mediaFiles);

    // STEP 6: Import documents (two-pass approach)
    const slugToIdMap = new Map<string, string>();
    const documentParents = new Map<string, string>(); // documentId -> parentSlug

    // First pass: Create all documents without parent relationships
    for (const info of docInfo) {
      try {
        // Update image references
        const updatedContent = updateImageReferences(info.content, uploadedMediaMap);

        // Build properties - filter out structural metadata
        const properties: Record<string, string> = {};
        for (const [key, value] of Object.entries(info.frontmatter.properties)) {
          if (key !== "parent") {
            properties[key] = value;
          }
        }

        // Set category for the document
        if (info.isCategory) {
          properties["category"] = info.finalSlug;
        } else if (info.categorySlug) {
          // Resolve category slug if it was modified
          const resolvedCategorySlug =
            slugModifications.get(info.categorySlug) || info.categorySlug;
          properties["category"] = resolvedCategorySlug;
        }

        // Parse dates
        const createdAt = info.frontmatter.created_at
          ? new Date(info.frontmatter.created_at)
          : undefined;
        const updatedAt = info.frontmatter.modified_at
          ? new Date(info.frontmatter.modified_at)
          : undefined;

        // Create document without parent (will be set in second pass)
        const createdDoc = await createDocument(
          spaceId,
          user.id,
          info.finalSlug,
          updatedContent,
          properties,
          null,
          undefined,
          createdAt,
          updatedAt,
        );

        // Store mapping for parent resolution
        slugToIdMap.set(info.finalSlug, createdDoc.id);

        // Store parent relationship for second pass
        if (info.parentSlug) {
          documentParents.set(createdDoc.id, info.parentSlug);
        }

        result.imported++;
        result.documents.push({
          slug: createdDoc.slug,
          title: info.frontmatter.title,
          id: createdDoc.id,
        });
      } catch (error) {
        result.failed++;
        result.errors.push({
          file: info.relativePath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Second pass: Set parent relationships
    for (const [documentId, parentSlug] of documentParents) {
      try {
        // Resolve parent slug (check if it was modified)
        const resolvedParentSlug = slugModifications.get(parentSlug) || parentSlug;
        const parentId = slugToIdMap.get(resolvedParentSlug);

        if (parentId) {
          await setDocumentParent(spaceId, documentId, parentId);
        }
      } catch (error) {
        console.error(`Failed to set parent for document ${documentId}:`, error);
      }
    }

    return jsonResponse(result, 200);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Import error:", error);
    return jsonResponse({ error: "Failed to import WIF file" }, 500);
  } finally {
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error("Failed to cleanup temp directory:", cleanupError);
      }
    }
  }
};
