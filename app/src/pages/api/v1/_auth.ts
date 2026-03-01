import type { APIContext } from "astro";
import { forbiddenResponse, requireUser, verifySpaceRole } from "#db/api.ts";
import { verifyJobToken } from "../../../jobs/jobToken.ts";

export async function authenticateJobTokenOrSpaceRole(
  context: APIContext,
  spaceId: string,
  requiredRole: string,
): Promise<
  { type: "job" } | { type: "user"; user: NonNullable<APIContext["locals"]["user"]> }
> {
  const jobToken = context.request.headers.get("X-Job-Token");
  if (jobToken) {
    if (!verifyJobToken(jobToken, spaceId)) {
      throw forbiddenResponse("Invalid job token");
    }
    return { type: "job" };
  }

  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, requiredRole);
  return { type: "user", user };
}
