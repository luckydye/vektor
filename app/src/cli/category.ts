import { slugify } from "#utils/slug.ts";
import { apiFetch, resolveConfig } from "./request.ts";

type Category = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  color?: string;
  icon?: string;
  order: number;
};

async function fetchCategory(
  host: string,
  spaceId: string,
  idOrSlug: string,
): Promise<Category> {
  const listRes = await apiFetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories`,
  );
  if (!listRes.ok) throw new Error(`Failed to list categories (${listRes.status})`);
  const { categories } = (await listRes.json()) as { categories: Category[] };
  const match = categories.find((c) => c.id === idOrSlug || c.slug === idOrSlug);
  if (!match) throw new Error(`Category '${idOrSlug}' not found`);
  return match;
}

export async function commandCategoryLs(): Promise<void> {
  const { host, spaceId } = await resolveConfig();
  const res = await apiFetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories`,
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
}): Promise<void> {
  const { host, spaceId } = await resolveConfig();
  const slug = flags.slug ?? slugify(flags.name);

  const res = await apiFetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: flags.name,
        slug,
        description: flags.description,
        color: flags.color,
        icon: flags.icon,
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
  },
): Promise<void> {
  const { host, spaceId } = await resolveConfig();
  const existing = await fetchCategory(host, spaceId, idOrSlug);

  const name = flags.name ?? existing.name;
  const slug = flags.slug ?? (flags.name ? slugify(flags.name) : existing.slug);

  const res = await apiFetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories/${existing.id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        slug,
        description: flags.description ?? existing.description,
        color: flags.color ?? existing.color,
        icon: flags.icon ?? existing.icon,
      }),
    },
  );
  if (!res.ok)
    throw new Error(`Failed to update category (${res.status}): ${await res.text()}`);
  const { category } = (await res.json()) as { category: Category };
  process.stdout.write(`${category.slug}\t${category.name}\n`);
}

export async function commandCategoryRm(idOrSlug: string): Promise<void> {
  const { host, spaceId } = await resolveConfig();
  const existing = await fetchCategory(host, spaceId, idOrSlug);

  const res = await apiFetch(
    `${host.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/categories/${existing.id}`,
    { method: "DELETE" },
  );
  if (!res.ok)
    throw new Error(`Failed to delete category (${res.status}): ${await res.text()}`);
  process.stdout.write(`deleted\t${existing.slug}\n`);
}
