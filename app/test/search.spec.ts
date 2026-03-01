import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

const DATA_DIR = "./data";
const AUTH_DB_PATH = join(DATA_DIR, "auth.db");
const BASE_URL = "http://127.0.0.1:4321";

let testUser: { id: string; email: string; name: string };
let sessionToken: string;
let testSpaceId: string;
const testDocIds: string[] = [];

async function createTestUser() {
  const testEmail = `test-search-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";

  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      name: "Search Test User",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.statusText}`);
  }

  const data = await response.json();
  const token = data.token;

  const cookies = response.headers.get("set-cookie");
  let sessionCookie = "";
  if (cookies) {
    const match = cookies.match(/better-auth\.session_token=([^;]+)/);
    if (match) {
      sessionCookie = match[1];
    }
  }

  if (!sessionCookie) {
    sessionCookie = `${token}.${Buffer.from(token).toString("base64")}`;
  }

  return {
    userId: data.user.id,
    token: sessionCookie,
    email: testEmail,
    name: data.user.name,
  };
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (sessionToken) {
    headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  }
  headers.set("Content-Type", "application/json");

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

beforeAll(async () => {
  try {
    const { userId, token, email, name } = await createTestUser();
    testUser = { id: userId, email, name };
    sessionToken = token;

    console.log("Test user created:", testUser.email);

    // Create test space
    const uniqueSlug = `search-test-space-${Date.now()}`;
    const spaceResponse = await apiRequest("/api/v1/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: "Search Test Space",
        slug: uniqueSlug,
      }),
    });

    if (!spaceResponse.ok) {
      const errorText = await spaceResponse.text();
      throw new Error(`Failed to create space (${spaceResponse.status}): ${errorText}`);
    }

    expect(spaceResponse.status).toBe(201);
    const spaceData = await spaceResponse.json();
    testSpaceId = spaceData.space.id;
    console.log("Test space created:", testSpaceId);

    // Create test documents with different content
    const testDocs = [
      {
        slug: "javascript-guide",
        content:
          "# JavaScript Programming Guide\n\nJavaScript is a versatile programming language used for web development.",
        properties: { title: "JavaScript Guide", category: "Programming" },
      },
      {
        slug: "typescript-basics",
        content:
          "# TypeScript Basics\n\nTypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
        properties: { title: "TypeScript Basics", category: "Programming" },
      },
      {
        slug: "python-tutorial",
        content:
          "# Python Tutorial\n\nPython is a high-level programming language known for its simplicity.",
        properties: { title: "Python Tutorial", category: "Programming" },
      },
      {
        slug: "database-design",
        content:
          "# Database Design Principles\n\nLearn about relational databases, SQL, and normalization.",
        properties: { title: "Database Design", category: "Data" },
      },
      {
        slug: "react-components",
        content:
          "# React Components\n\nReact is a JavaScript library for building user interfaces with reusable components.",
        properties: { title: "React Components", category: "Frontend" },
      },
    ];

    for (const doc of testDocs) {
      const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
        method: "POST",
        body: JSON.stringify(doc),
      });

      expect(docResponse.status).toBe(201);
      const docData = await docResponse.json();
      testDocIds.push(docData.document.id);
    }

    console.log(`Created ${testDocIds.length} test documents`);

    // Give the FTS index a moment to catch up
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    console.error("Failed to set up test environment:", error);
    throw error;
  }
});

afterAll(async () => {
  if (testSpaceId && existsSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`))) {
    rmSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`), { force: true });
  }

  if (testUser?.id && existsSync(AUTH_DB_PATH)) {
    try {
      const authSqlite = new Database(AUTH_DB_PATH);
      const authDb = drizzle({ client: authSqlite });

      await authDb.run(sql`DELETE FROM account WHERE user_id = ${testUser.id}`);
      await authDb.run(sql`DELETE FROM session WHERE user_id = ${testUser.id}`);
      await authDb.run(sql`DELETE FROM user WHERE id = ${testUser.id}`);

      authSqlite.close();
    } catch (error) {
      console.log("Cleanup error:", error);
    }
  }
  console.log("Search test cleanup complete");
});

describe("Search API Tests", () => {
  it("should return empty results for empty query", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/search?q=`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("should find documents with simple single word query", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=javascript`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toBeDefined();
    expect(data.total).toBeGreaterThan(0);
    expect(data.results.length).toBeGreaterThan(0);

    // Should find JavaScript Guide and React Components (mentions JavaScript)
    const slugs = data.results.map((r: any) => r.slug);
    expect(slugs).toContain("javascript-guide");
  });

  it("should find documents with prefix matching", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/search?q=java`);

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.total).toBeGreaterThan(0);
    // Should match "javascript" with prefix search
    const slugs = data.results.map((r: any) => r.slug);
    expect(slugs).toContain("javascript-guide");
  });

  it("should find documents with multiple word query", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=programming language`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.total).toBeGreaterThan(0);
    // Should find documents containing either "programming" or "language"
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("should find documents by title property", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=typescript`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.total).toBeGreaterThan(0);
    const slugs = data.results.map((r: any) => r.slug);
    expect(slugs).toContain("typescript-basics");
  });

  it("should handle quoted phrases", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=${encodeURIComponent('"programming language"')}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    // Should find documents with the exact phrase
    expect(data.results).toBeDefined();
  });

  it("should return results with proper structure", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/search?q=python`);

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toBeDefined();
    expect(data.total).toBeDefined();
    expect(data.query).toBe("python");
    expect(data.limit).toBeDefined();
    expect(data.offset).toBeDefined();

    if (data.results.length > 0) {
      const result = data.results[0];
      expect(result.id).toBeDefined();
      expect(result.slug).toBeDefined();
      expect(result.snippet).toBeDefined();
      expect(result.rank).toBeDefined();
      expect(result.properties).toBeDefined();
    }
  });

  it("should include snippet with highlighted matches", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/search?q=database`);

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.total).toBeGreaterThan(0);

    if (data.results.length > 0) {
      const result = data.results[0];
      expect(result.snippet).toBeDefined();
      // Snippet should contain HTML mark tags for highlighting
      expect(result.snippet).toContain("<mark>");
      expect(result.snippet).toContain("</mark>");
    }
  });

  it("should handle pagination with limit and offset", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=programming&limit=2&offset=0`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results.length).toBeLessThanOrEqual(2);
    expect(data.limit).toBe(2);
    expect(data.offset).toBe(0);
  });

  it("should respect limit parameter", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=programming&limit=1`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results.length).toBeLessThanOrEqual(1);
  });

  it("should return 400 for invalid limit", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=test&limit=200`,
    );

    expect(response.status).toBe(400);
  });

  it("should return 400 for negative offset", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=test&offset=-1`,
    );

    expect(response.status).toBe(400);
  });

  it("should handle special characters gracefully", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=${encodeURIComponent("test@#$%")}`,
    );

    // Should not crash, even if no results
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toBeDefined();
  });

  it.skip("should not find archived documents", async () => {
    // Skip this test - archive endpoint may not be implemented yet
    // Create and archive a document
    const docResponse = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        slug: "archived-doc",
        content:
          "# Archived Document\n\nThis document contains uniquearchivedsearchterm.",
        properties: { title: "Archived Doc" },
      }),
    });

    expect(docResponse.status).toBe(201);
    const docData = await docResponse.json();
    const archivedDocId = docData.document.id;

    // Archive the document
    const archiveResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/documents/${archivedDocId}/archive`,
      { method: "POST" },
    );

    expect(archiveResponse.status).toBe(200);

    // Search should not find it
    const searchResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=uniquearchivedsearchterm`,
    );

    expect(searchResponse.status).toBe(200);
    const searchData = await searchResponse.json();
    expect(searchData.total).toBe(0);
  });

  it("should return total count greater than limit when more results exist", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=programming&limit=1`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    if (data.total > 1) {
      expect(data.results.length).toBe(1);
      expect(data.total).toBeGreaterThan(1);
    }
  });

  it("should require authentication", async () => {
    const response = await fetch(
      `${BASE_URL}/api/v1/spaces/${testSpaceId}/search?q=test`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    expect(response.status).toBe(401);
  });
});

describe("Search Property Filters", () => {
  it("should filter documents by property value", async () => {
    // Filter for documents with category = "Programming"
    const filters = JSON.stringify([{ key: "category", value: "Programming" }]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toBeDefined();
    expect(data.total).toBeGreaterThan(0);
    expect(data.filters).toEqual([{ key: "category", value: "Programming" }]);

    // All results should have category = Programming
    for (const result of data.results) {
      expect(result.properties.category).toBe("Programming");
    }
  });

  it("should filter documents by property existence", async () => {
    // Filter for documents that have the "category" property (any value)
    const filters = JSON.stringify([{ key: "category", value: null }]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toBeDefined();
    expect(data.total).toBeGreaterThan(0);

    // All results should have a category property
    for (const result of data.results) {
      expect(result.properties.category).toBeDefined();
      expect(result.properties.category).not.toBe("");
    }
  });

  it("should combine text query with property filters", async () => {
    // Search for "javascript" AND category = "Programming"
    const filters = JSON.stringify([{ key: "category", value: "Programming" }]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=javascript&filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toBeDefined();
    expect(data.query).toBe("javascript");
    expect(data.filters).toEqual([{ key: "category", value: "Programming" }]);

    // Results should match both the query and the filter
    for (const result of data.results) {
      expect(result.properties.category).toBe("Programming");
    }
  });

  it("should return empty results when no documents match filter", async () => {
    const filters = JSON.stringify([{ key: "category", value: "NonExistentCategory" }]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("should support multiple property filters", async () => {
    // Filter for documents with category = "Programming" AND title exists
    const filters = JSON.stringify([
      { key: "category", value: "Programming" },
      { key: "title", value: null },
    ]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.results).toBeDefined();

    // All results should match both filters
    for (const result of data.results) {
      expect(result.properties.category).toBe("Programming");
      expect(result.properties.title).toBeDefined();
    }
  });

  it("should return 400 for invalid filters JSON", async () => {
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=not-valid-json`,
    );

    expect(response.status).toBe(400);
  });

  it("should return 400 for filters that are not an array", async () => {
    const filters = JSON.stringify({ key: "category", value: "Programming" });
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(400);
  });

  it("should return 400 for filter without key", async () => {
    const filters = JSON.stringify([{ value: "Programming" }]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(400);
  });

  it("should be case-insensitive when matching filter values", async () => {
    // Filter with lowercase value should match "Programming"
    const filters = JSON.stringify([{ key: "category", value: "programming" }]);
    const response = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?filters=${encodeURIComponent(filters)}`,
    );

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.total).toBeGreaterThan(0);
  });
});

describe("Search Index Rebuild", () => {
  it("should rebuild search index successfully", async () => {
    const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/search/rebuild`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    // Response is the string directly
    expect(typeof data === "string").toBe(true);

    // Verify search still works after rebuild
    const searchResponse = await apiRequest(
      `/api/v1/spaces/${testSpaceId}/search?q=javascript`,
    );
    expect(searchResponse.status).toBe(200);
    const searchData = await searchResponse.json();
    expect(searchData.total).toBeGreaterThan(0);
  });
});
