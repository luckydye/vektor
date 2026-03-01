#!/usr/bin/env bun

// curl -X PUT https://wiki.luckydye.de/api/v1/spaces/a6b43eab-d7fe-4656-b52d-dc1ac0db6deb/documents/73738c7b-cabe-4d21-8698-0e40cf8fb41b \
//     -H "Content-Type: application/json" \
//     -H "Authorization: Bearer at_c85d7d9c338a4a9d77de12096097af25be19a8900ca96b0562b75b7a696282ff" \
//     -d '{"content": "<html>Your content here</html>"}'

interface WikiConfig {
  url: string;
  token: string;
  spaceId: string;
  documentId: string;
}

export async function fetchAndInlineHTML(
  sourceUrl: string,
  basicAuth?: { username: string; password: string },
): Promise<string> {
  if (!sourceUrl) {
    throw new Error("Source URL is required");
  }

  const fetchOptions: RequestInit = {};

  if (basicAuth) {
    const credentials = btoa(`${basicAuth.username}:${basicAuth.password}`);
    fetchOptions.headers = {
      Authorization: `Basic ${credentials}`,
    };
  }

  const response = await fetch(sourceUrl, fetchOptions);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${sourceUrl}: ${response.statusText}`);
  }

  let html = await response.text();

  // Replace all link tags with rel="stylesheet" with inlined style tags
  const linkTagRegex =
    /<link\s+(?:[^>]*?\s+)?rel=["']stylesheet["'](?:\s+[^>]*)?\s+href=["']([^"']+)["'][^>]*>/gi;

  let match;
  const replacements: Array<{ original: string; replacement: string }> = [];

  while ((match = linkTagRegex.exec(html)) !== null) {
    const fullLinkTag = match[0];
    const href = match[1];

    try {
      const cssUrl = new URL(href, sourceUrl).href;
      const cssResponse = await fetch(cssUrl, fetchOptions);
      if (cssResponse.ok) {
        const cssContent = await cssResponse.text();
        const styleTag = `<style>\n${cssContent}\n</style>`;
        replacements.push({ original: fullLinkTag, replacement: styleTag });
      }
    } catch (error) {
      console.warn(`Failed to fetch CSS from ${href}`);
    }
  }

  // Apply stylesheet replacements
  for (const { original, replacement } of replacements) {
    html = html.replace(original, replacement);
  }

  // Replace all relative URLs in href attributes with absolute URLs
  html = html.replace(
    /href=["'](?!(?:https?:|\/\/|#|mailto:))([^"']+)["']/gi,
    (match, url) => {
      const absoluteUrl = new URL(url, sourceUrl).href;
      return `href="${absoluteUrl}"`;
    },
  );

  // Replace all relative URLs in src attributes with absolute URLs
  html = html.replace(
    /src=["'](?!(?:https?:|\/\/|#|data:))([^"']+)["']/gi,
    (match, url) => {
      const absoluteUrl = new URL(url, sourceUrl).href;
      return `src="${absoluteUrl}"`;
    },
  );

  // Replace :root with :root, :host in style definitions
  html = html.replace(/:root\b/g, ":root, :host");

  html += `
    <style>
      :host {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
      }
      transition-in {
          opacity: 1 !important;
      }
      [class*="--blurred"], [class*="--loading"], header, footer {
          opacity: 0.2 !important;
      }
    </style>
  `;

  return html;
}
export async function postToWiki(html: string, config: WikiConfig): Promise<void> {
  const wikiUrl = `${config.url}/api/v1/spaces/${config.spaceId}/documents/${config.documentId}`;

  console.log(`PUT ${wikiUrl}`);

  const response = await fetch(wikiUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ content: html }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post to wiki: ${response.status} ${response.statusText}`);
  }
}

// curl -X PUT https://wiki.luckydye.de/api/v1/spaces/a6b43eab-d7fe-4656-b52d-dc1ac0db6deb/documents/73738c7b-cabe-4d21-8698-0e40cf8fb41b \
//     -H "Content-Type: application/json" \
//     -H "Authorization: Bearer at_17fa575e4be86ff174abe471fc2941a77933ac7ad41195322677f568a42e393a" \
//     -d '{"content": "<html>Your content here</html>"}'

// CLI usage example
async function main() {
  const sourceUrl = process.argv[2];
  const wikiUrl = process.argv[3] || "https://wiki.luckydye.de";
  const spaceId = process.argv[4] || "a6b43eab-d7fe-4656-b52d-dc1ac0db6deb";
  const documentId = process.argv[5] || "73738c7b-cabe-4d21-8698-0e40cf8fb41b";
  const token = process.env.WIKI_TOKEN;
  const basicAuthUsername = process.env.BASIC_AUTH_USERNAME;
  const basicAuthPassword = process.env.BASIC_AUTH_PASSWORD;

  if (!sourceUrl) {
    console.error("Usage: bun post-html.ts <sourceUrl> [wikiUrl] [spaceId] [documentId]");
    console.error("Environment variable WIKI_TOKEN is required");
    console.error("Optional: BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD for basic auth");
    process.exit(1);
  }

  if (!token) {
    throw new Error("WIKI_TOKEN environment variable is not set");
  }

  const basicAuth =
    basicAuthUsername && basicAuthPassword
      ? { username: basicAuthUsername, password: basicAuthPassword }
      : undefined;

  console.log(`Fetching from ${sourceUrl}...`);
  const inlinedHTML = await fetchAndInlineHTML(sourceUrl, basicAuth);

  if (!inlinedHTML) {
    throw new Error("Failed to inline HTML content");
  }

  console.log("Posting to wiki...");
  await postToWiki(inlinedHTML, {
    url: wikiUrl,
    token,
    spaceId,
    documentId,
  });

  console.log("✓ HTML posted to wiki successfully!");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
