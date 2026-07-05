import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { config } from "#config";
import { resolveHost, resolveSpaceId } from "./resolve.ts";

type UploadResult = {
  key: string;
  url: string;
};

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function resolveConnection() {
  const host = resolveHost();
  const token = config().CLI_ACCESS_TOKEN;
  const spaceId = await resolveSpaceId(host, token);
  return { host, token, spaceId };
}

export function toAbsoluteUrl(host: string, url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${host.replace(/\/$/, "")}${url}`;
}

export async function commandUploadFile(flags: {
  source: string;
  filename?: string;
  documentId?: string;
  contentType?: string;
  json?: boolean;
}): Promise<void> {
  if (!existsSync(flags.source)) {
    throw new Error(`File not found: ${flags.source}`);
  }

  const stat = statSync(flags.source);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${flags.source}`);
  }

  const { host, token, spaceId } = await resolveConnection();
  const file = Bun.file(flags.source);
  const filename = flags.filename ?? basename(flags.source);
  const contentType = flags.contentType ?? file.type ?? "application/octet-stream";

  const form = new FormData();
  form.append(
    "file",
    new Blob([await file.arrayBuffer()], { type: contentType }),
    filename,
  );
  form.append("filename", filename);
  if (flags.documentId) form.append("documentId", flags.documentId);

  const url = `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/uploads`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      Origin: new URL(host).origin,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`File upload failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as UploadResult;
  const absoluteUrl = toAbsoluteUrl(host, result.url);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...result, url: absoluteUrl }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${result.key}\t${absoluteUrl}\n`);
}
