import { eq } from "drizzle-orm";
import { realtimeTopics } from "#utils/realtime.ts";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { category } from "./schema/space.ts";
import { sendSyncEvent } from "./ws.ts";

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  color?: string;
  icon?: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function createCategory(
  spaceId: string,
  name: string,
  slug: string,
  description?: string,
  color?: string,
  icon?: string,
): Promise<Category> {
  const db = await getSpaceDb(spaceId);
  const id = createId("category");
  const now = new Date();

  const results = await db.select().from(category).all();
  const order = results.length;

  await db.insert(category).values({
    id,
    name,
    slug,
    description: description || null,
    color: color || null,
    icon: icon || null,
    order,
    createdAt: now,
    updatedAt: now,
  });

  sendSyncEvent(
    spaceId,
    {
      topic: realtimeTopics.categories,
      data: { kind: "category_created", categoryId: id, name, slug, order },
    },
    {
      topic: realtimeTopics.documentTree,
      data: { kind: "category_created", categoryId: id, name, slug, order },
    },
  );

  return {
    id,
    name,
    slug,
    description,
    color,
    icon,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToCategory(result: typeof category.$inferSelect): Category {
  return {
    id: result.id,
    name: result.name,
    slug: result.slug,
    description: result.description || undefined,
    color: result.color || undefined,
    icon: result.icon || undefined,
    order: result.order,
    createdAt: new Date(result.createdAt),
    updatedAt: new Date(result.updatedAt),
  };
}

export async function getCategory(spaceId: string, id: string): Promise<Category | null> {
  const db = await getSpaceDb(spaceId);
  const result = await db.select().from(category).where(eq(category.id, id)).get();

  return result ? rowToCategory(result) : null;
}

export async function getCategoryBySlug(
  spaceId: string,
  slug: string,
): Promise<Category | null> {
  const db = await getSpaceDb(spaceId);
  const result = await db.select().from(category).where(eq(category.slug, slug)).get();

  return result ? rowToCategory(result) : null;
}

export async function listCategories(spaceId: string): Promise<Category[]> {
  const db = await getSpaceDb(spaceId);
  const results = await db.select().from(category).all();

  return results.map(rowToCategory).sort((a, b) => a.order - b.order);
}

export async function updateCategory(
  spaceId: string,
  id: string,
  name: string,
  slug: string,
  description?: string,
  color?: string,
  icon?: string,
): Promise<Category | null> {
  const db = await getSpaceDb(spaceId);
  const existing = await getCategory(spaceId, id);

  if (!existing) {
    return null;
  }

  const now = new Date();

  await db
    .update(category)
    .set({
      name,
      slug,
      description: description || null,
      color: color || null,
      icon: icon || null,
      updatedAt: now,
    })
    .where(eq(category.id, id));

  sendSyncEvent(
    spaceId,
    {
      topic: realtimeTopics.categories,
      data: {
        kind: "category_updated",
        categoryId: id,
        previousSlug: existing.slug,
        slug,
        name,
        order: existing.order,
      },
    },
    {
      topic: realtimeTopics.documentTree,
      data: {
        kind: "category_updated",
        categoryId: id,
        previousSlug: existing.slug,
        slug,
        name,
        order: existing.order,
      },
    },
  );

  return {
    id,
    name,
    slug,
    description,
    color,
    icon,
    order: existing.order,
    createdAt: existing.createdAt,
    updatedAt: now,
  };
}

export async function deleteCategory(spaceId: string, id: string): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const existing = await getCategory(spaceId, id);
  await db.delete(category).where(eq(category.id, id));
  sendSyncEvent(
    spaceId,
    {
      topic: realtimeTopics.categories,
      data: { kind: "category_deleted", categoryId: id, slug: existing?.slug ?? null },
    },
    {
      topic: realtimeTopics.documentTree,
      data: { kind: "category_deleted", categoryId: id, slug: existing?.slug ?? null },
    },
  );
  return true;
}

export async function reorderCategories(
  spaceId: string,
  categoryIds: string[],
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);

  for (let i = 0; i < categoryIds.length; i++) {
    await db
      .update(category)
      .set({ order: i, updatedAt: new Date() })
      .where(eq(category.id, categoryIds[i]));
  }

  sendSyncEvent(
    spaceId,
    {
      topic: realtimeTopics.categories,
      data: { kind: "categories_reordered", categoryIds },
    },
    {
      topic: realtimeTopics.documentTree,
      data: { kind: "categories_reordered", categoryIds },
    },
  );
  return true;
}
