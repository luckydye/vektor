#!/usr/bin/env bun

/**
 * Performance Testing Data Generator
 *
 * Creates 20000 documents with some extra revisions for performance testing.
 * Generates realistic document structures with:
 * - Mixed document types (standard, category, technical docs)
 * - Various content lengths
 * - Multiple revisions on select documents
 * - Hierarchical parent-child relationships
 * - Properties and metadata
 *
 * Usage Examples:
 *
 *   # Basic usage (creates 20000 docs with default settings)
 *   bun run scripts/create-perf-test-data.ts
 *
 *   # Or using the task command
 *   task perf:test-data
 *
 *   # Create smaller batch with more revisions
 *   BATCH_SIZE=50 REVISION_PROBABILITY=0.3 bun run scripts/create-perf-test-data.ts
 *
 *   # Use different server URL
 *   BASE_URL=http://localhost:3000 bun run scripts/create-perf-test-data.ts
 *
 * Environment Variables:
 *   BASE_URL - Wiki server URL (default: http://127.0.0.1:8080)
 *   BATCH_SIZE - Number of documents to create per batch (default: 100)
 *                Smaller batches = slower but more reliable
 *   REVISION_PROBABILITY - Probability of adding extra revisions (default: 0.1)
 *                          0.1 = 10% of docs get 1-5 extra revisions
 *
 * The script will:
 * 1. Create a new test user automatically
 * 2. Create a new performance test space
 * 3. Generate and create documents via API
 * 4. Add random revisions to selected documents
 * 5. Output statistics and login credentials
 */

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8080";
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE || "100");
const REVISION_PROBABILITY = Number.parseFloat(process.env.REVISION_PROBABILITY || "0.1");
const TOTAL_DOCS = 20000;
const OWNER_USER_ID = "IcaXElHWYXheMhmEI9QdQORJYz5CN7OL";

let sessionToken = "";

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (sessionToken) {
    headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  }
  if (options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function createTestUser() {
  console.info("👤 Creating user for perf test space...");

  const testEmail = `perf-test-${Date.now()}@example.com`;
  const testPassword = "PerfTest123!";

  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      name: "Performance Tester",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create user: ${response.statusText}`);
  }

  const data = await response.json();
  const cookies = response.headers.get("set-cookie");
  let sessionCookie = "";

  if (cookies) {
    const match = cookies.match(/better-auth\.session_token=([^;]+)/);
    if (match) sessionCookie = match[1];
  }

  if (!sessionCookie) {
    sessionCookie = `${data.token}.${Buffer.from(data.token).toString("base64")}`;
  }

  console.info(`✅ User created: ${testEmail}`);

  return { userId: data.user.id, token: sessionCookie, email: testEmail };
}

async function createSpace() {
  console.info("🏗️  Creating performance test space...");

  const timestamp = Date.now();
  const slug = `perf-test-${timestamp}`;

  const response = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: `Performance Test ${timestamp}`,
      slug: slug,
      preferences: {
        brandColor: "#ff6b35",
        description: "Performance testing space with 20000 documents",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create space: ${response.statusText}`);
  }

  const data = await response.json();
  console.info(`✅ Space created: ${data.space.name} (${data.space.id})`);

  return data.space.id;
}

async function addOwner(spaceId: string) {
  console.info("👑 Adding owner to space...");

  const response = await apiRequest(`/api/v1/spaces/${spaceId}/members`, {
    method: "POST",
    body: JSON.stringify({
      userId: OWNER_USER_ID,
      role: "owner",
    }),
  });

  if (!response.ok) {
    console.error(`⚠️  Failed to add owner: ${response.statusText}`);
    return false;
  }

  console.info(`✅ Owner added to space`);
  return true;
}

function generateContent(index: number, type: string): string {
  const baseContent = `<h1>Document ${index}</h1>

<p>This is performance test document number ${index}.</p>

<h2>Overview</h2>

<p>This document is part of a large-scale performance testing dataset containing 20,000 documents.</p>

<h2>Content Section</h2>

<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>

<h3>Technical Details</h3>

<ul>
  <li>Document ID: ${index}</li>
  <li>Type: ${type}</li>
  <li>Generated: ${new Date().toISOString()}</li>
</ul>
`;

  if (type === "technical") {
    return (
      baseContent +
      `
<h2>Technical Specifications</h2>

<pre><code class="language-javascript">function example${index}() {
  const data = { id: ${index}, type: '${type}' };
  console.log('Processing document:', data);
  return data;
}</code></pre>

<h3>Performance Metrics</h3>

<table>
  <thead>
    <tr>
      <th>Metric</th>
      <th>Value</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Load Time</td>
      <td>${Math.floor(Math.random() * 100)}ms</td>
    </tr>
    <tr>
      <td>Size</td>
      <td>${Math.floor(Math.random() * 500)}KB</td>
    </tr>
    <tr>
      <td>Requests</td>
      <td>${Math.floor(Math.random() * 20)}</td>
    </tr>
  </tbody>
</table>
`
    );
  }

  if (type === "extensive") {
    return (
      baseContent +
      `
<h2>Extended Content</h2>

${Array.from(
  { length: 10 },
  (_, i) => `
<h3>Section ${i + 1}</h3>

<p>Paragraph ${i + 1}: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>

<ul>
  <li>List item 1</li>
  <li>List item 2</li>
  <li>List item 3</li>
</ul>
`,
).join("\n")}
`
    );
  }

  return baseContent;
}

function getDocumentType(index: number): string {
  if (index % 10 === 0) return "technical";
  if (index % 7 === 0) return "extensive";
  if (index % 5 === 0) return "category";
  return "standard";
}

function generateProperties(index: number, type: string): Record<string, string> {
  const props: Record<string, string> = {
    title: `Document ${index}`,
    type: type,
  };

  if (type === "category") {
    props.category = `Category ${Math.floor(index / 100)}`;
  }

  if (type === "technical") {
    props.category = "Technical";
    props.tags = "technical,performance,test";
  }

  if (index % 3 === 0) {
    props.status = "published";
  } else if (index % 3 === 1) {
    props.status = "draft";
  } else {
    props.status = "review";
  }

  return props;
}

async function createDocument(
  spaceId: string,
  index: number,
  parentId?: string,
): Promise<{ id: string; slug: string } | null> {
  const type = getDocumentType(index);
  const properties = generateProperties(index, type);
  const content = generateContent(index, type);

  try {
    const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        content,
        properties,
        parentId,
        type,
      }),
    });

    if (!response.ok) {
      console.error(`  ⚠️  Failed to create document ${index}: ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return { id: data.document.id, slug: data.document.slug };
  } catch (error) {
    console.error(`  ⚠️  Error creating document ${index}:`, error);
    return null;
  }
}

async function createDocumentsBatch(
  spaceId: string,
  startIndex: number,
  count: number,
  parentIds: string[] = [],
): Promise<{
  documentIds: Array<{ id: string; slug: string; index: number }>;
  errors: number;
}> {
  const documentIds: Array<{ id: string; slug: string; index: number }> = [];
  let errors = 0;

  for (let i = 0; i < count; i++) {
    const index = startIndex + i;

    let parentId: string | undefined;
    if (parentIds.length > 0 && index % 20 === 0) {
      parentId = parentIds[Math.floor(Math.random() * parentIds.length)];
    }

    const result = await createDocument(spaceId, index, parentId);

    if (result) {
      documentIds.push({ ...result, index });
    } else {
      errors++;
    }
  }

  return { documentIds, errors };
}

async function addRevision(spaceId: string, documentId: string, revNum: number) {
  const revisionContent = `<h1>Revision ${revNum}</h1>
<p>This is revision number ${revNum} of the document.</p>
<p>Updated at: ${new Date().toISOString()}</p>
<h2>Changes in this revision</h2>
<ul>
  <li>Update ${revNum - 1}: Modified content</li>
  <li>Update ${revNum}: Added new section</li>
  <li>Update ${revNum + 1}: Fixed formatting</li>
</ul>`;

  try {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      {
        method: "POST",
        body: JSON.stringify({
          html: revisionContent,
          message: `Revision ${revNum}`,
        }),
      },
    );

    return response.ok;
  } catch {
    return false;
  }
}

async function addRevisionsToRandomDocs(
  spaceId: string,
  documents: Array<{ id: string; slug: string; index: number }>,
) {
  const docsToRevise = documents.filter(() => Math.random() < REVISION_PROBABILITY);

  if (docsToRevise.length === 0) return 0;

  let revisionsAdded = 0;

  for (const doc of docsToRevise) {
    const revCount = Math.floor(Math.random() * 5) + 1;

    for (let i = 0; i < revCount; i++) {
      const success = await addRevision(spaceId, doc.id, i + 2);
      if (success) {
        revisionsAdded++;
      } else {
        break;
      }
    }
  }

  return revisionsAdded;
}

async function main() {
  console.info("🚀 Starting performance test data generation...");
  console.info(
    `📊 Target: ${TOTAL_DOCS} documents with ~${Math.floor(TOTAL_DOCS * REVISION_PROBABILITY)} having extra revisions\n`,
  );

  try {
    const { token, email } = await createTestUser();
    sessionToken = token;

    const spaceId = await createSpace();
    await addOwner(spaceId);

    let totalCreated = 0;
    let totalErrors = 0;
    let totalRevisions = 0;
    const allDocumentIds: string[] = [];
    const startTime = Date.now();

    for (let i = 0; i < TOTAL_DOCS; i += BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(TOTAL_DOCS / BATCH_SIZE);
      const batchSize = Math.min(BATCH_SIZE, TOTAL_DOCS - i);

      process.stdout.write(
        `\r📦 Processing batch ${batchNum}/${totalBatches} (${i}-${i + batchSize - 1})...`,
      );

      const { documentIds, errors } = await createDocumentsBatch(
        spaceId,
        i,
        batchSize,
        allDocumentIds,
      );

      totalCreated += documentIds.length;
      totalErrors += errors;
      allDocumentIds.push(...documentIds.map((d) => d.id));

      if (documentIds.length > 0) {
        const revisionsAdded = await addRevisionsToRandomDocs(spaceId, documentIds);
        totalRevisions += revisionsAdded;
      }

      const progress = (((i + batchSize) / TOTAL_DOCS) * 100).toFixed(1);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const rate = totalCreated / elapsed;
      const remaining = Math.floor((TOTAL_DOCS - totalCreated) / rate);

      process.stdout.write(
        ` [${progress}%] ${totalCreated}/${TOTAL_DOCS} created, ` +
          `${rate.toFixed(1)} docs/sec, ~${remaining}s remaining`,
      );
    }

    const totalTime = Math.floor((Date.now() - startTime) / 1000);

    console.info("\n");
    console.info("✅ Performance test data generation complete!");
    console.info(`📊 Statistics:`);
    console.info(`   - Total documents created: ${totalCreated}`);
    console.info(`   - Total revisions added: ${totalRevisions}`);
    console.info(`   - Total errors: ${totalErrors}`);
    console.info(`   - Time taken: ${totalTime}s`);
    console.info(`   - Average rate: ${(totalCreated / totalTime).toFixed(1)} docs/sec`);
    console.info(`\n🔗 Access the space at: ${BASE_URL}/s/${spaceId}`);
    console.info(`👤 Login with: ${email} / PerfTest123!`);
  } catch (error) {
    console.error("\n❌ Error during data generation:", error);
    process.exit(1);
  }
}

main();
