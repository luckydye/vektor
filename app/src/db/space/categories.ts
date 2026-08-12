import { eq } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { category } from "#db/schema/space.ts";

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

export interface CategoryInput {
  name: string;
  slug: string;
  description?: string;
  color?: string;
  icon?: string;
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

export async function createCategory(
  s: SpaceStore,
  input: CategoryInput,
): Promise<Category> {
  const id = createId("category");
  const now = new Date();
  const existing = await s.db.select().from(category).all();
  const order = existing.length;

  await s.db.insert(category).values({
    id,
    name: input.name,
    slug: input.slug,
    description: input.description || null,
    color: input.color || null,
    icon: input.icon || null,
    order,
    createdAt: now,
    updatedAt: now,
  });

  s.emit({
    kind: "category",
    action: "created",
    data: { categoryId: id, name: input.name, slug: input.slug, order },
  });

  return { id, ...input, order, createdAt: now, updatedAt: now };
}

export async function getCategory(s: SpaceStore, id: string): Promise<Category | null> {
  const result = await s.db.select().from(category).where(eq(category.id, id)).get();
  return result ? rowToCategory(result) : null;
}

export async function getCategoryBySlug(
  s: SpaceStore,
  slug: string,
): Promise<Category | null> {
  const result = await s.db.select().from(category).where(eq(category.slug, slug)).get();
  return result ? rowToCategory(result) : null;
}

export async function listCategories(s: SpaceStore): Promise<Category[]> {
  const results = await s.db.select().from(category).all();
  return results.map(rowToCategory).sort((a, b) => a.order - b.order);
}

export async function updateCategory(
  s: SpaceStore,
  id: string,
  input: CategoryInput,
): Promise<Category | null> {
  return s.tx(async (tx) => {
    const existing = await getCategory(tx, id);
    if (!existing) return null;

    const now = new Date();
    await tx.db
      .update(category)
      .set({
        name: input.name,
        slug: input.slug,
        description: input.description || null,
        color: input.color || null,
        icon: input.icon || null,
        updatedAt: now,
      })
      .where(eq(category.id, id));

    tx.emit({
      kind: "category",
      action: "updated",
      data: {
        categoryId: id,
        previousSlug: existing.slug,
        slug: input.slug,
        name: input.name,
        order: existing.order,
      },
    });

    return {
      id,
      ...input,
      order: existing.order,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  });
}

export async function deleteCategory(s: SpaceStore, id: string): Promise<boolean> {
  return s.tx(async (tx) => {
    const existing = await getCategory(tx, id);
    await tx.db.delete(category).where(eq(category.id, id));
    tx.emit({
      kind: "category",
      action: "deleted",
      data: { categoryId: id, slug: existing?.slug ?? null },
    });
    return true;
  });
}

export async function reorderCategories(
  s: SpaceStore,
  categoryIds: string[],
): Promise<boolean> {
  return s.tx(async (tx) => {
    const now = new Date();
    for (let i = 0; i < categoryIds.length; i++) {
      await tx.db
        .update(category)
        .set({ order: i, updatedAt: now })
        .where(eq(category.id, categoryIds[i]));
    }
    tx.emit({ kind: "category", action: "reordered", data: { categoryIds } });
    return true;
  });
}
