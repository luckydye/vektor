import * as gitSmart from "./routes/git/smart.ts";
import * as documentGit from "./routes/spaces/document-git.ts";
import type { ApiRoute } from "./routes.ts";

/** Routes that run git itself, so only a target with a git binary and local disk serves them. */
export const gitRoutes: ApiRoute[] = [
  // Not under /api: the clone URL is the repository's own address. The literal
  // `git` segment is what separates it from a document path — see `isGitPath`.
  { pattern: "/[spaceSlug]/git/[repo]/[...gitPath]", module: gitSmart },

  {
    pattern: "/api/v1/spaces/[spaceId]/documents/[documentId]/git",
    module: documentGit,
  },
];
