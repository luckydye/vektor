import type { APIRoute } from "astro";
import apiMd from "#docs/api.md" with { type: "text" };
import extensionsMd from "#docs/extensions.md" with { type: "text" };

const SECTION_CONTENT: Record<string, string> = {
  api: apiMd,
  extensions: extensionsMd,
};

/** Raw markdown source for a /docs page, for agent/tool consumption. */
export const GET: APIRoute = ({ params }) => {
  const content = params.section ? SECTION_CONTENT[params.section] : undefined;
  if (!content) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(content, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
