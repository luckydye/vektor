/**
 * Document commands — thin fetch wrappers over the wiki REST API.
 *
 * Defaults to http://localhost:8080 and auto-discovers the first space
 * from a running vektor instance. Override with env vars:
 *   WIKI_HOST          e.g. http://localhost:3000
 *   WIKI_SPACE_ID      space identifier
 *   WIKI_ACCESS_TOKEN  API token (optional)
 *
 * Commands:
 *   document cat <docId>                       print document content to stdout
 *   document write <docId>                     write stdin to existing document
 *   document create [--slug <s>] [--type <t>]  create document from stdin, prints new id
 *   document ls [--limit <n>]                  list documents (id, slug, title)
 *   document search <query>                    full-text search, prints matching docs
 */

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
    headers: { ...authHeaders(token), ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function resolveConnection() {
  const host = resolveHost();
  const token = process.env.WIKI_ACCESS_TOKEN;
  const spaceId = await resolveSpaceId(host, token);
  return { host, token, spaceId };
}

export async function commandCat(docId: string): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const data = (await apiFetch(
    host,
    token,
    `/api/v1/spaces/${spaceId}/documents/${docId}`,
  )) as { document: { content: string } };

  process.stdout.write(data.document.content);
}

export async function commandWrite(docId: string): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const content = await Bun.stdin.text();

  await apiFetch(host, token, `/api/v1/spaces/${spaceId}/documents/${docId}`, {
    method: "PUT",
    headers: { "Content-Type": "text/html" },
    body: content,
  });
}

export async function commandCreate(flags: { slug?: string; type?: string }): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const content = await Bun.stdin.text();

  const data = (await apiFetch(host, token, `/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, slug: flags.slug, type: flags.type }),
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

export async function commandSearch(query: string): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();

  const data = (await apiFetch(
    host,
    token,
    `/api/v1/spaces/${spaceId}/search?q=${encodeURIComponent(query)}`,
  )) as { results: Array<{ id: string; slug: string; title?: string; snippet?: string }> };

  for (const r of data.results) {
    process.stdout.write(`${r.id}\t${r.slug}\t${r.title ?? ""}\t${r.snippet ?? ""}\n`);
  }
}
