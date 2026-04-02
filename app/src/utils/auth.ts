import type { APIContext } from "astro";
import { forbiddenResponse, requireUser, verifySpaceRole, authenticateWithToken } from "#db/api.ts";
import { getTokenUserId } from "#db/accessTokens.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

export async function authenticateJobTokenOrSpaceRole(
  context: APIContext,
  spaceId: string,
  requiredRole: string,
): Promise<
  | { type: "job"; userId: string | null }
  | { type: "user"; user: NonNullable<APIContext["locals"]["user"]> }
> {
  const jobToken = context.request.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed) throw forbiddenResponse("Invalid job token");
    return { type: "job", userId: parsed.userId };
  }

  const tokenResult = await authenticateWithToken(context, spaceId);
  if (tokenResult) {
    return { type: "job", userId: getTokenUserId(tokenResult.tokenId) };
  }

  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, requiredRole);
  return { type: "user", user };
}
