const DEFAULT_HOST = "http://localhost:8080";

export function resolveHost(): string {
  return process.env.WIKI_HOST ?? DEFAULT_HOST;
}

export async function resolveSpaceId(host: string, token?: string): Promise<string> {
  const fromEnv = process.env.WIKI_SPACE_ID;
  if (fromEnv) return fromEnv;

  const res = await fetch(`${host.replace(/\/$/, "")}/api/v1/spaces`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to discover spaces from ${host} (${res.status})`);
  const spaces = (await res.json()) as Array<{ id: string }>;
  if (!spaces.length) throw new Error("No spaces found on server");
  return spaces[0].id;
}
