/**
 * Document commands — thin fetch wrappers over the wiki REST API.
 *
 * Defaults to http://localhost:8080 and auto-discovers the first space
 * from a running vektor instance. Override with env vars:
 *   VEKTOR_HOST          e.g. http://localhost:3000
 *   VEKTOR_SPACE_ID      space identifier
 *   VEKTOR_ACCESS_TOKEN  API token (optional)
 *
 * Commands:
 *   document cat <docId>                       print document content to stdout
 *   document write <docId>                     write stdin to existing document
 *   document create [--slug <s>] [--type <t>]  create document from stdin, prints new id
 *   document ls [--limit <n>]                  list documents (id, slug, title)
 *   document search <query>                    full-text search, prints matching docs
 */

import { config } from "#config";
import { resolveHost, resolveSpaceId } from "./resolve.ts";

function apiUrl(host: string, path: string): string {
  return `${host.replace(/\/$/, "")}${path}`;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(
  host: string,
  token: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(apiUrl(host, path), {
    ...init,
    headers: {
      ...authHeaders(token),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(
      `API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text}`,
    );
  }
  return res.json();
}

async function resolveConnection() {
  const host = resolveHost();
  const token = config().CLI_ACCESS_TOKEN;
  const spaceId = await resolveSpaceId(host, token);
  return { host, token, spaceId };
}

export async function commandCat(docId: string): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const res = await fetch(apiUrl(host, `/api/v1/spaces/${spaceId}/documents/${docId}`), {
    headers: {
      ...authHeaders(token),
      Accept: "text/markdown",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`API GET documents/${docId} failed (${res.status}): ${text}`);
  }

  process.stdout.write(await res.text());
}

async function readSource(source?: string): Promise<string> {
  if (!source || source === "-") return Bun.stdin.text();
  return Bun.file(source).text();
}

// Map source file extensions to the Content-Type sent to the API. HTML must be
// sent as text/html so the server stores it verbatim; sending it as markdown
// runs it through marked, which escapes raw tags (e.g. <tr> → &lt;tr&gt;).
function inferContentType(source?: string): string {
  if (source && source !== "-") {
    const dot = source.lastIndexOf(".");
    const ext = dot > -1 ? source.slice(dot + 1).toLowerCase() : "";
    if (ext === "html" || ext === "htm") return "text/html";
  }
  return "text/markdown";
}

type Frontmatter = Record<string, string>;

function parseFrontmatter(raw: string): { meta: Frontmatter; content: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { meta: {}, content: raw };
  }
  const rest = raw.slice(raw.indexOf("\n") + 1);
  const end = rest.search(/^---\s*$/m);
  if (end === -1) return { meta: {}, content: raw };

  const meta: Frontmatter = {};
  for (const line of rest.slice(0, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line
        .slice(colon + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) meta[key] = value;
    }
  }

  const content = rest
    .slice(end)
    .replace(/^---\s*\n?/, "")
    .trimStart();
  return { meta, content };
}

// Fields extracted from frontmatter that map to first-class document fields.
const FIRST_CLASS = new Set(["title", "slug", "type", "guid", "created", "modified"]);

export async function commandWrite(
  docId: string,
  source?: string,
  contentType?: string,
): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();
  const raw = await readSource(source);
  const { content } = parseFrontmatter(raw);

  await apiFetch(host, token, `/api/v1/spaces/${spaceId}/documents/${docId}`, {
    method: "PUT",
    headers: { "Content-Type": contentType ?? inferContentType(source) },
    body: content,
  });
}

function titleFromFilename(source?: string): string | undefined {
  if (!source || source === "-") return undefined;
  const base = source.split("/").pop() ?? source;
  const name = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return name.replace(/[-_]+/g, " ").trim() || undefined;
}

export async function commandCreate(flags: {
  slug?: string;
  type?: string;
  source?: string;
  parent?: string;
  modified?: string;
  created?: string;
  contentType?: string;
  properties?: Record<string, string>;
}): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();
  const raw = await readSource(flags.source);
  const { meta, content } = parseFrontmatter(raw);
  const contentType = flags.contentType ?? inferContentType(flags.source);

  const type = flags.type ?? meta.type;
  const slug = flags.slug ?? meta.slug ?? meta.guid;
  const title = flags.properties?.title ?? meta.title ?? titleFromFilename(flags.source);
  const updatedAt = flags.modified ?? meta.modified;
  const createdAt = flags.created ?? meta.created;

  // Build properties: frontmatter base, then explicit CLI flags on top.
  const properties: Record<string, string> = {};
  if (title) properties.title = title;
  for (const [key, value] of Object.entries(meta)) {
    if (!FIRST_CLASS.has(key)) properties[key] = value;
  }
  if (flags.properties) {
    for (const [key, value] of Object.entries(flags.properties)) {
      properties[key] = value;
    }
  }

  const data = (await apiFetch(host, token, `/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      contentType,
      ...(type ? { type } : {}),
      ...(slug ? { slug } : {}),
      ...(flags.parent ? { parentId: flags.parent } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
    }),
  })) as { document: { id: string; slug: string } };

  process.stdout.write(`${data.document.id}\t${data.document.slug}\n`);
}

export async function commandLs(flags: { limit?: string }): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const limit = flags.limit ? `?limit=${flags.limit}` : "";
  const data = (await apiFetch(
    host,
    token,
    `/api/v1/spaces/${spaceId}/documents${limit}`,
  )) as { documents: Array<{ id: string; slug: string; title?: string }> };

  for (const doc of data.documents) {
    process.stdout.write(`${doc.id}\t${doc.slug}\t${doc.title ?? ""}\n`);
  }
}

// vektor set <docId> [key=value ...] [-key ...] [--title <t>] [--category <slug>] [--parent <id|->]
//
// Positional args after docId are property assignments:
//   key=value   → set property
//   -key        → delete property (value null)
// --title and --category are shorthands for title=value and category=value.
// --parent <id> sets the parent; --parent - clears it.
export async function commandSet(
  docId: string,
  assignments: string[],
  opts: { parent?: string; title?: string; category?: string },
): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();
  const base = `/api/v1/spaces/${spaceId}/documents/${docId}`;

  // Merge --title/--category shorthands into property assignments.
  const allAssignments = [...assignments];
  if (opts.title) allAssignments.unshift(`title=${opts.title}`);
  if (opts.category) allAssignments.unshift(`category=${opts.category}`);

  // Send properties patch if any assignments were given.
  if (allAssignments.length > 0) {
    const properties: Record<string, string | null> = {};
    for (const arg of allAssignments) {
      if (arg.startsWith("-") && !arg.includes("=")) {
        properties[arg.slice(1)] = null; // delete
      } else {
        const eq = arg.indexOf("=");
        if (eq < 1)
          throw new Error(
            `Invalid property assignment: '${arg}' (expected key=value or -key)`,
          );
        properties[arg.slice(0, eq)] = arg.slice(eq + 1);
      }
    }
    await apiFetch(host, token, base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    });
  }

  // Send parent patch separately (API does not allow combining with properties).
  if (opts.parent !== undefined) {
    const parentId = opts.parent === "-" || opts.parent === "none" ? null : opts.parent;
    await apiFetch(host, token, base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId }),
    });
  }

  process.stdout.write(`updated\t${docId}\n`);
}

export async function commandSearch(query: string): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const data = (await apiFetch(
    host,
    token,
    `/api/v1/spaces/${spaceId}/search?q=${encodeURIComponent(query)}`,
  )) as {
    results: Array<{ id: string; slug: string; title?: string; snippet?: string }>;
  };

  for (const r of data.results) {
    process.stdout.write(`${r.id}\t${r.slug}\t${r.title ?? ""}\t${r.snippet ?? ""}\n`);
  }
}
