import { slugify } from "#utils/slug.ts";
import { resolveConfig } from "./resolve.ts";

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type Category = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  color?: string;
  icon?: string;
  documentSort?: string;
  documentLimit?: number;
  order: number;
};

/** `--limit` as sent: a count, or 0 to show every document. */
function parseLimit(limit: string): number | undefined {
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("--limit must be a whole number (0 shows every document)");
  }
  return value || undefined;
}

async function fetchCategory(
  host: string,
  token: string | undefined,
  spaceId: string,
  idOrSlug: string,
): Promise<Category> {
  const listRes = await fetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories`,
    { headers: authHeaders(token) },
  );
  if (!listRes.ok) throw new Error(`Failed to list categories (${listRes.status})`);
  const { categories } = (await listRes.json()) as { categories: Category[] };
  const match = categories.find((c) => c.id === idOrSlug || c.slug === idOrSlug);
  if (!match) throw new Error(`Category '${idOrSlug}' not found`);
  return match;
}

export async function commandCategoryLs(): Promise<void> {
  const { host, token, spaceId } = await resolveConfig();
  const res = await fetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories`,
    { headers: authHeaders(token) },
  );
  if (!res.ok)
    throw new Error(`Failed to list categories (${res.status}): ${await res.text()}`);
  const { categories } = (await res.json()) as { categories: Category[] };
  for (const c of categories) {
    const meta = [c.color, c.icon].filter(Boolean).join(" ");
    process.stdout.write(`${c.slug}\t${c.name}${meta ? `\t${meta}` : ""}\n`);
  }
}

export async function commandCategoryCreate(flags: {
  name: string;
  slug?: string;
  description?: string;
  color?: string;
  icon?: string;
  sort?: string;
  limit?: string;
}): Promise<void> {
  const { host, token, spaceId } = await resolveConfig();
  const slug = flags.slug ?? slugify(flags.name);

  const res = await fetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({
        name: flags.name,
        slug,
        description: flags.description,
        color: flags.color,
        icon: flags.icon,
        documentSort: flags.sort,
        documentLimit: flags.limit === undefined ? undefined : parseLimit(flags.limit),
      }),
    },
  );
  if (!res.ok)
    throw new Error(`Failed to create category (${res.status}): ${await res.text()}`);
  const { category } = (await res.json()) as { category: Category };
  process.stdout.write(`${category.slug}\t${category.name}\n`);
}

export async function commandCategoryEdit(
  idOrSlug: string,
  flags: {
    name?: string;
    slug?: string;
    description?: string;
    color?: string;
    icon?: string;
    sort?: string;
    limit?: string;
  },
): Promise<void> {
  const { host, token, spaceId } = await resolveConfig();
  const existing = await fetchCategory(host, token, spaceId, idOrSlug);

  const name = flags.name ?? existing.name;
  const slug = flags.slug ?? (flags.name ? slugify(flags.name) : existing.slug);

  const res = await fetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories/${existing.id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({
        name,
        slug,
        description: flags.description ?? existing.description,
        color: flags.color ?? existing.color,
        icon: flags.icon ?? existing.icon,
        // A PUT replaces the category, so unchanged settings are sent back as they were.
        documentSort: flags.sort ?? existing.documentSort,
        documentLimit:
          flags.limit === undefined ? existing.documentLimit : parseLimit(flags.limit),
      }),
    },
  );
  if (!res.ok)
    throw new Error(`Failed to update category (${res.status}): ${await res.text()}`);
  const { category } = (await res.json()) as { category: Category };
  process.stdout.write(`${category.slug}\t${category.name}\n`);
}

export async function commandCategoryRm(idOrSlug: string): Promise<void> {
  const { host, token, spaceId } = await resolveConfig();
  const existing = await fetchCategory(host, token, spaceId, idOrSlug);

  const res = await fetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories/${existing.id}`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!res.ok)
    throw new Error(`Failed to delete category (${res.status}): ${await res.text()}`);
  process.stdout.write(`deleted\t${existing.slug}\n`);
}
