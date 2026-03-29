import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path, { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { slugify } from "../utils/utils.ts";
import {
  countSpaceMembers,
  grantPermission,
  listUserPermissions,
  getUserGroups,
  ResourceType,
} from "./acl.ts";
import { closeSpaceDb, getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { preference, spaceMetadata } from "./schema/space.ts";
import { prepareSpaceDb } from "./init.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "../noAuth.ts";

const DATA_DIR = "./data";
const SPACES_DIR = join(DATA_DIR, "spaces");
const DELETED_DIR = join(DATA_DIR, "deleted");
const UPLOADS_DIR = join(DATA_DIR, "uploads");

export interface Space {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  preferences: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  userRole?: string;
  memberCount?: number;
}

export async function createSpace(
  createdBy: string,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space> {
  const id = createId("space");
  const now = new Date();

  // Sanitize slug to contain only URL-compatible characters
  slug = slugify(slug);

  if (!slug) {
    throw new Error("Slug not valid");
  }

  // Check if slug already exists
  const existingSpace = await getSpaceBySlug(slug);
  if (existingSpace) {
    throw new Error(`Space with slug "${slug}" already exists`);
  }

  if (!existsSync(SPACES_DIR)) {
    mkdirSync(SPACES_DIR, { recursive: true });
  }

  const spacePath = join(DATA_DIR, "spaces", `${id}.db`);

  if (existsSync(spacePath)) {
    throw new Error("Space with this ID already exists");
  }

  await prepareSpaceDb(id);

  const spaceDb = drizzle({
    connection: {
      source: path.resolve(spacePath),
      create: true,
      readwrite: true,
    },
  });

  await spaceDb.insert(spaceMetadata).values({
    id,
    name,
    slug,
    createdBy: createdBy,
    createdAt: now,
    updatedAt: now,
  });

  // Insert default preferences
  const defaultPreferences = {
    brandColor: "#1e293b",
    ...preferences,
  };

  for (const [key, value] of Object.entries(defaultPreferences)) {
    await spaceDb.insert(preference).values({
      id: createId("preference"),
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Grant owner permission to creator (after closing initial connection)
  await grantPermission(id, ResourceType.SPACE, id, createdBy, "owner");

  return {
    id,
    name,
    slug,
    createdBy: createdBy,
    preferences: defaultPreferences,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getSpace(id: string): Promise<Space | null> {
  const spacePath = join(SPACES_DIR, `${id}.db`);

  if (!existsSync(spacePath)) {
    return null;
  }

  const spaceDb = await getSpaceDb(id);

  const result = await spaceDb
    .select()
    .from(spaceMetadata)
    .where(eq(spaceMetadata.id, id))
    .get();

  if (!result) {
    return null;
  }

  // Load preferences
  const prefs = await spaceDb.select().from(preference).all();

  const preferences: Record<string, string> = {};
  for (const pref of prefs) {
    preferences[pref.key] = pref.value;
  }

  // Set default preferences if none exist
  if (Object.keys(preferences).length === 0) {
    const now = new Date();
    await spaceDb.insert(preference).values({
      id: createId("preference"),
      key: "brandColor",
      value: "#1e293b",
      createdAt: now,
      updatedAt: now,
    });
    preferences.brandColor = "#1e293b";
  }

  const memberCount = await countSpaceMembers(id);

  return {
    id: result.id,
    name: result.name,
    slug: result.slug,
    createdBy: result.createdBy,
    preferences,
    createdAt: new Date(result.createdAt),
    updatedAt: new Date(result.updatedAt),
    memberCount,
  };
}

export async function getSpaceBySlug(slug: string): Promise<Space | null> {
  const spaces = await listAllSpaces();
  return spaces.find((s) => s.slug === slug || s.id === slug) || null;
}

export async function listAllSpaces(): Promise<Space[]> {
  if (!existsSync(SPACES_DIR)) {
    return [];
  }

  const files = readdirSync(SPACES_DIR);
  const dbFiles = files.filter((f) => f.endsWith(".db"));

  const spaces: Space[] = [];

  for (const file of dbFiles) {
    const spaceId = file.replace(".db", "");
    const space = await getSpace(spaceId);
    if (space) {
      spaces.push(space);
    }
  }

  return spaces;
}

export async function listUserSpaces(userId: string): Promise<Space[]> {
  const allSpaces = await listAllSpaces();

  if (isNoAuthMode() && userId === LOCAL_USER_ID) {
    return allSpaces.map((s) => ({ ...s, userRole: "owner" }));
  }

  const userSpaces: Space[] = [];

  for (const space of allSpaces) {
    // Include space if user created it
    if (space.createdBy === userId) {
      userSpaces.push({ ...space, userRole: "owner" });
      continue;
    }

    // Include space if user is a member
    try {
      const userGroups = await getUserGroups(userId);
      const permissions = await listUserPermissions(
        space.id,
        userId,
        userGroups,
        ResourceType.SPACE,
      );
      const spacePermission = permissions.find(
        (p) => p.resourceType === ResourceType.SPACE && p.resourceId === space.id,
      );
      if (spacePermission) {
        userSpaces.push({ ...space, userRole: spacePermission.permission });
      }
    } catch (error) {}
  }

  return userSpaces;
}

export async function updateSpace(
  id: string,
  name: string,
  slug: string,
  preferences?: Record<string, string>,
): Promise<Space | null> {
  const existing = await getSpace(id);
  if (!existing) {
    return null;
  }

  // Check if slug is changing and if new slug already exists
  if (slug !== existing.slug) {
    const existingSpace = await getSpaceBySlug(slug);
    if (existingSpace && existingSpace.id !== id) {
      throw new Error(`Space with slug "${slug}" already exists`);
    }
  }

  const now = new Date();
  const spaceDb = await getSpaceDb(id);

  await spaceDb
    .update(spaceMetadata)
    .set({ name, slug, updatedAt: now })
    .where(eq(spaceMetadata.id, id));

  // Update preferences if provided
  const updatedPreferences = { ...existing.preferences };
  if (preferences) {
    for (const [key, value] of Object.entries(preferences)) {
      // Check if preference exists
      const existingPref = await spaceDb
        .select()
        .from(preference)
        .where(eq(preference.key, key))
        .get();

      if (existingPref) {
        // Update existing preference
        await spaceDb
          .update(preference)
          .set({ value, updatedAt: now })
          .where(eq(preference.id, existingPref.id));
      } else {
        // Insert new preference
        await spaceDb.insert(preference).values({
          id: createId("preference"),
          key,
          value,
          createdAt: now,
          updatedAt: now,
        });
      }
      updatedPreferences[key] = value;
    }
  }

  return {
    id,
    name,
    slug,
    createdBy: existing.createdBy,
    preferences: updatedPreferences,
    createdAt: existing.createdAt,
    updatedAt: now,
  };
}

export async function deleteSpace(id: string): Promise<boolean> {
  const spacePath = join(SPACES_DIR, `${id}.db`);

  if (!existsSync(spacePath)) {
    return false;
  }

  closeSpaceDb(id);

  // Create deleted directory if it doesn't exist
  const deletedSpacesDir = join(DELETED_DIR, "spaces");
  if (!existsSync(deletedSpacesDir)) {
    mkdirSync(deletedSpacesDir, { recursive: true });
  }

  // Move space database to deleted directory with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const deletedSpacePath = join(deletedSpacesDir, `${id}_${timestamp}.db`);
  renameSync(spacePath, deletedSpacePath);

  // Move uploads directory if it exists
  const uploadsPath = join(UPLOADS_DIR, id);
  if (existsSync(uploadsPath)) {
    const deletedUploadsDir = join(DELETED_DIR, "uploads");
    if (!existsSync(deletedUploadsDir)) {
      mkdirSync(deletedUploadsDir, { recursive: true });
    }
    const deletedUploadsPath = join(deletedUploadsDir, `${id}_${timestamp}`);
    renameSync(uploadsPath, deletedUploadsPath);
  }

  return true;
}
