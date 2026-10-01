import type { APIRoute } from "astro";
import apiMd from "#docs/api.md?raw";
import extensionsMd from "#docs/extensions.md?raw";
import permissionsMd from "#docs/permissions.md?raw";

const SECTION_CONTENT: Record<string, string> = {
  api: apiMd,
  extensions: extensionsMd,
  permissions: permissionsMd,
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
