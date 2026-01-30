#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";

const BASE_URL = "http://127.0.0.1:4321";
const EXPORT_DIR = "./temp/Technik.WebHome/pages";

interface Document {
  slug: string;
  content: string;
  properties: Record<string, string>;
  path: string;
  parentSlug?: string;
  level: number;
  categorySlug?: string;
}

let sessionToken: string;
let spaceId: string;
let userId: string;
const documentIdMap = new Map<string, string>(); // slug -> document ID
const categoryMap = new Map<string, string>(); // slug -> category ID

// Parse command line arguments
const args = process.argv.slice(2);
const credentialsFileArg = args.find(arg => arg.startsWith("--credentials="))?.split("=")[1];

async function authenticate() {
  if (!credentialsFileArg) {
    throw new Error("Credentials file is required. Use --credentials=<file> or --help for usage.");
  }

  console.log(`Authenticating with credentials file: ${credentialsFileArg}`);

  if (!existsSync(credentialsFileArg)) {
    throw new Error(`Credentials file not found: ${credentialsFileArg}`);
  }

  const fileContent = await Bun.file(credentialsFileArg).text();
  const lines = fileContent.trim().split("\n");

  // Parse credentials file (can be JSON or simple key=value format)
  let token: string | undefined;
  let userIdFromFile: string | undefined;

  try {
    // Try JSON format first
    const json = JSON.parse(fileContent);
    token = json.session_token || json.sessionToken || json.token;
    userIdFromFile = json.user_id || json.userId;
  } catch {
    // Try key=value format
    for (const line of lines) {
      const [key, value] = line.split("=").map(s => s.trim());
      if (key === "session_token" || key === "sessionToken" || key === "token") {
        token = value;
      }
      if (key === "user_id" || key === "userId") {
        userIdFromFile = value;
      }
    }
  }

  if (!token) {
    throw new Error("Invalid credentials file format. Expected JSON with 'session_token' or key=value format.");
  }

  sessionToken = token;
  userId = userIdFromFile;

  if (!userId) {
    throw new Error("Credentials file must include user_id or userId");
  }

  console.log(`✓ Using credentials from file`);
}

async function createSpace() {
  console.log("Creating space for import...");
  const uniqueSlug = `technik-${Date.now()}`;

  const response = await fetch(`${BASE_URL}/api/v1/spaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `better-auth.session_token=${sessionToken}`,
    },
    body: JSON.stringify({
      name: "Technik",
      slug: uniqueSlug,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create space (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  spaceId = data.space.id;
  console.log(`✓ Space created: ${spaceId}`);

  // Make space public
  await makeSpacePublic();
}

async function makeSpacePublic() {
  console.log("Making space public...");

  const response = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/permissions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `better-auth.session_token=${sessionToken}`,
    },
    body: JSON.stringify({
      type: "role",
      roleOrFeature: "viewer",
      groupId: "public",
      action: "grant",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to make space public (${response.status}): ${errorText}`);
  }

  console.log("✓ Space is now public");
}

function createSlugFromPath(filePath: string): string {
  // Remove base path and WebHome.html
  const relativePath = filePath
    .replace(EXPORT_DIR, "")
    .replace(/\/WebHome\.html$/, "");

  // Decode URL encoding and clean up
  const decoded = decodeURIComponent(relativePath);

  // Remove leading/trailing slashes and convert to slug
  return decoded
    .replace(/^\/+|\/+$/g, "")
    .replace(/^intern\/Technik\/?/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_\/äöüÄÖÜß]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "home";
}

function getHierarchyInfo(slug: string): { parentSlug?: string; level: number; categorySlug?: string } {
  // Remove common prefix to get actual hierarchy
  const normalizedSlug = slug.replace(/^temp\/technik-webhome\/pages\/intern\/technik\/?/, "");

  if (!normalizedSlug || normalizedSlug === slug) {
    // Root document
    return { level: 0 };
  }

  const parts = normalizedSlug.split("/");
  const level = parts.length;

  const parentSlug = parts.length > 1 ? slug.replace(/\/[^\/]+$/, "") : undefined;
  const categorySlug = parts.length >= 1 ? parts[0] : undefined;

  return { parentSlug, level, categorySlug };
}

function extractTitle(doc: Document, html: string): string {
  const { document } = parseHTML(html);

  // Try to get the first heading
  const h1 = document.querySelector("#xwikicontent h1");
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }

  const h2 = document.querySelector("#xwikicontent h2");
  if (h2?.textContent?.trim()) {
    return h2.textContent.trim();
  }

  // Use slug as fallback
  return doc.slug
    .split("/")
    .pop()!
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanXWikiHtml(html: string): string {
  const { document } = parseHTML(html);
  const content = document.querySelector("#xwikicontent");

  if (!content) {
    return "";
  }

  // Remove xtree divs (navigation elements)
  content.querySelectorAll(".xtree").forEach((el) => el.remove());

  // Clean up XWiki-specific classes but keep the HTML structure
  content.querySelectorAll("[class]").forEach((el) => {
    const element = el as Element;
    // Keep standard HTML semantic meaning, remove XWiki-specific classes
    const classes = Array.from(element.classList);
    const cleanClasses = classes.filter(cls =>
      !cls.startsWith("wiki") &&
      !cls.startsWith("xwiki") &&
      cls !== "content-wrapper"
    );

    if (cleanClasses.length > 0) {
      element.setAttribute("class", cleanClasses.join(" "));
    } else {
      element.removeAttribute("class");
    }
  });

  // Convert XWiki mentions to user-mention elements
  content.querySelectorAll("a.xwiki-mention, a[data-reference]").forEach((mention) => {
    const username = mention.textContent?.trim();
    if (username && username.startsWith("@")) {
      // Extract email from mention text like "@j_schraft@s-v_de"
      // Remove leading @ and convert underscores to dots in domain
      const emailPart = username.substring(1); // Remove leading @
      const email = emailPart.replace(/_/g, ".");

      const userMention = document.createElement("user-mention");
      userMention.setAttribute("email", email);
      userMention.textContent = username;
      mention.replaceWith(userMention);
    }
  });

  // Handle XWiki code blocks - convert to pre/code
  content.querySelectorAll("div.box > div.code, div.code").forEach((codeBlock) => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");

    // Get text content and decode HTML entities
    let codeText = codeBlock.innerHTML
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/<span[^>]*>/g, "")
      .replace(/<\/span>/g, "");

    // Remove HTML tags
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

  // Handle XWiki dates - keep as text
  content.querySelectorAll("span.xwiki-date, span[class*='date']").forEach((dateSpan) => {
    const date = dateSpan.textContent?.trim();
    if (date) {
      const textNode = document.createTextNode(date);
      dateSpan.replaceWith(textNode);
    }
  });

  // Clean up tables - remove wrapper divs inside cells
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

  // Remove empty paragraphs and divs
  content.querySelectorAll("p, div").forEach((el) => {
    if (!el.textContent?.trim() && !el.querySelector("img, table, pre, code")) {
      el.remove();
    }
  });

  // Return cleaned HTML
  return content.innerHTML.trim();
}

function isDocumentEmpty(content: string): boolean {
  const trimmed = content.trim();

  // Empty or just whitespace
  if (!trimmed) {
    return true;
  }

  // Only contains non-breaking spaces or similar
  if (trimmed.replace(/&nbsp;/g, "").trim().length === 0) {
    return true;
  }

  // Only contains empty paragraphs
  if (/^(<p>\s*<\/p>\s*)+$/.test(trimmed)) {
    return true;
  }

  return false;
}

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

async function createCategory(slug: string, name: string): Promise<void> {
  if (categoryMap.has(slug)) {
    return; // Already created
  }

  try {
    const response = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/categories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `better-auth.session_token=${sessionToken}`,
      },
      body: JSON.stringify({
        name,
        slug,
        description: `Category for ${name}`,
        color: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
      }),
    });

    if (!response.ok) {
      console.error(`Failed to create category ${slug}: ${response.statusText}`);
      return;
    }

    const data = await response.json();
    categoryMap.set(slug, data.category.id);
    console.log(`✓ Created category: ${name}`);
  } catch (error) {
    console.error(`Error creating category ${slug}:`, error);
  }
}

async function importDocument(doc: Document): Promise<boolean> {
  try {
    const parentId = doc.parentSlug ? documentIdMap.get(doc.parentSlug) : undefined;

    // Use the authenticated user's ID as creator
    const response = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": `better-auth.session_token=${sessionToken}`,
      },
      body: JSON.stringify({
        slug: doc.slug,
        content: doc.content,
        properties: doc.properties,
        parentId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`✗ Failed to import ${doc.slug}: ${response.status} - ${errorText}`);
      return false;
    }

    const data = await response.json();
    documentIdMap.set(doc.slug, data.document.id);
    console.log(`✓ Imported: ${doc.slug}`);
    return true;
  } catch (error) {
    console.error(`✗ Error importing ${doc.slug}:`, error);
    return false;
  }
}

async function main() {
  console.log("XWiki to Wiki Importer");
  console.log("======================\n");

  // Show usage if help requested
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun scripts/import-xwiki.ts --credentials=<file>");
    console.log("\nOptions:");
    console.log("  --credentials=<file>    Path to credentials file (JSON or key=value format)");
    console.log("  --help, -h             Show this help message");
    console.log("\nCredentials file format:");
    console.log("  JSON:     { \"session_token\": \"...\", \"userId\": \"...\" }");
    console.log("  Key=value: session_token=...");
    console.log("             user_id=...");
    console.log("\nExample:");
    console.log("  bun scripts/import-xwiki.ts --credentials=./credentials.json");
    process.exit(0);
  }

  if (!existsSync(EXPORT_DIR)) {
    console.error(`Export directory not found: ${EXPORT_DIR}`);
    process.exit(1);
  }

  // Authenticate and create space
  await authenticate();
  await createSpace();

  console.log("\nFinding documents to import...");
  const htmlFiles = await findAllDocuments(EXPORT_DIR);
  console.log(`Found ${htmlFiles.length} HTML files\n`);

  const documents: Document[] = [];

  for (const filePath of htmlFiles) {
    const html = await Bun.file(filePath).text();
    const slug = createSlugFromPath(filePath);
    const content = cleanXWikiHtml(html);

    if (isDocumentEmpty(content)) {
      console.log(`- Skipping empty document: ${slug}`);
      continue;
    }

    const hierarchyInfo = getHierarchyInfo(slug);
    const title = extractTitle({ slug, content, properties: {}, path: filePath, ...hierarchyInfo }, html);

    const properties: Record<string, string> = {
      title,
      source: "xwiki-import",
    };

    // Assign category to level 1 documents
    if (hierarchyInfo.categorySlug && hierarchyInfo.level === 1) {
      properties.category = hierarchyInfo.categorySlug;
    }

    documents.push({
      slug,
      content,
      properties,
      path: filePath,
      ...hierarchyInfo,
    });
  }

  // Sort documents by level (parents before children)
  documents.sort((a, b) => a.level - b.level);

  console.log(`\nPrepared ${documents.length} documents for import\n`);

  // Create categories for top-level documents
  const topLevelSlugs = new Set<string>();
  for (const doc of documents) {
    if (doc.categorySlug && doc.level === 1) {
      topLevelSlugs.add(doc.categorySlug);
    }
  }

  console.log(`Creating ${topLevelSlugs.size} categories...\n`);
  for (const catSlug of topLevelSlugs) {
    const name = catSlug
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    await createCategory(catSlug, name);
  }

  console.log("\nStarting document import...\n");

  let successCount = 0;
  let failCount = 0;

  for (const doc of documents) {
    const success = await importDocument(doc);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }

    // Small delay to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log("\n======================");
  console.log("Import Summary");
  console.log("======================");
  console.log(`Total files found: ${htmlFiles.length}`);
  console.log(`Documents prepared: ${documents.length}`);
  console.log(`Categories created: ${categoryMap.size}`);
  console.log(`Successfully imported: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Skipped (empty): ${htmlFiles.length - documents.length}`);
  console.log(`\nSpace ID: ${spaceId}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
